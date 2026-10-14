import { cosine } from '../../lib/embedding.js';
import { COMPONENT_LABELS, type Component, type Weights } from './config.js';

/**
 * Pure scoring. Every component is in [0,1] or null when it cannot be computed honestly (for
 * example: no editorial history yet, no query, no visual model). Null components are left out of
 * the weighted average rather than guessed, and the explanation says so.
 */

export type ExplorationMode = 'familiar' | 'adjacent' | 'experimental';

export interface ScorableReference {
  id: string;
  source_id: string;
  creator_name: string | null;
  creator_url: string | null;
  title: string | null;
  description: string | null;
  published_date: string | null;
  license: string | null;
  rights_statement: string | null;
  preview_url: string | null;
  attribution_status: string;
  text_embedding: number[] | null;
  tags: string[];
  entity_ids: string[];
}

export interface PostResonance {
  embedding: number[];
  /** percentile rank (0..1) of the post's engagement rate among eccö posts on the same platform */
  percentile: number;
}

export interface EditorialProfile {
  approvedCentroid: number[] | null;
  approvedCount: number;
  historyCentroid: number[] | null;
  historyCount: number;
  /** 'tag:…', 'creator:…', 'source:…', 'entity:…' → learned weight in [-1, 1] */
  featureWeights: Map<string, number>;
  /** embeddings of what eccö already holds or published, for novelty and exposure */
  archiveEmbeddings: number[][];
  historyEmbeddings: number[][];
  approvedEntityIds: Set<string>;
  sourceReliability: Map<string, number>;
  resonance: PostResonance[];
  resonanceBasis: string;
}

export interface ScoreContext {
  mode: ExplorationMode;
  /** 0 = prefer the familiar, 1 = prefer the new */
  novelty: number;
  queryEmbedding?: number[] | null;
  queryLabel?: string | null;
  historicalExposurePenalty?: number;
}

export interface ComponentScore {
  key: Component;
  label: string;
  value: number | null;
  weight: number;
  note: string;
}

export interface ScoreResult {
  total: number;
  components: ComponentScore[];
  penalties: { key: string; label: string; amount: number }[];
  reasons: string[];
  caveats: string[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
// Lexical-hash cosine values between related texts are usually modest; 0.35 is treated as strong.
const SIM_SCALE = 0.35;
const scaleSim = (s: number) => clamp01(s / SIM_SCALE);

const MODE_MULTIPLIERS: Record<ExplorationMode, Partial<Record<Component, number>>> = {
  familiar: { editorial_affinity: 1.5, novelty: 0.4, cultural_relevance: 1 },
  adjacent: { editorial_affinity: 1, novelty: 1, cultural_relevance: 1.3 },
  experimental: { editorial_affinity: 0.6, novelty: 1.8, cultural_relevance: 1.2 },
};

export function featureKeys(r: ScorableReference): string[] {
  const keys = r.tags.map((t) => `tag:${t.toLowerCase()}`);
  if (r.creator_name) keys.push(`creator:${r.creator_name.toLowerCase()}`);
  keys.push(`source:${r.source_id}`);
  r.entity_ids.forEach((e) => keys.push(`entity:${e}`));
  return keys;
}

function maxSim(v: number[] | null, set: number[][]): number {
  if (!v) return 0;
  let m = 0;
  for (const x of set) m = Math.max(m, cosine(v, x));
  return m;
}

export function audienceResonance(v: number[] | null, profile: EditorialProfile): { value: number | null; note: string } {
  if (!v) return { value: null, note: 'No text representation to compare with past posts.' };
  if (profile.resonance.length < 20) {
    return { value: null, note: `Not enough imported post metrics (${profile.resonance.length} posts; 20 needed).` };
  }
  const sims = profile.resonance
    .map((p) => ({ s: cosine(v, p.embedding), p: p.percentile }))
    .filter((x) => x.s > 0.12)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10);
  if (sims.length < 3) return { value: null, note: 'Too few comparable past posts to estimate audience resonance.' };
  // Shrink toward the median (0.5) so a handful of viral posts cannot dominate.
  const prior = 2;
  const num = sims.reduce((acc, x) => acc + x.s * x.p, 0) + prior * 0.5;
  const den = sims.reduce((acc, x) => acc + x.s, 0) + prior;
  return {
    value: clamp01(num / den),
    note: `Based on ${sims.length} similar eccö posts (${profile.resonanceBasis}); shrunk toward the median.`,
  };
}

export function scoreReference(r: ScorableReference, profile: EditorialProfile, weights: Weights, ctx: ScoreContext): ScoreResult {
  const components: ComponentScore[] = [];
  const reasons: string[] = [];
  const caveats: string[] = [];
  const mult = MODE_MULTIPLIERS[ctx.mode];
  const add = (key: Component, value: number | null, note: string) => {
    let weight = weights[key] * (mult[key] ?? 1);
    if (key === 'novelty') weight *= 0.5 + ctx.novelty;
    if (key === 'editorial_affinity') weight *= 1.5 - ctx.novelty * 0.5;
    components.push({ key, label: COMPONENT_LABELS[key], value: value === null ? null : clamp01(value), weight, note });
  };

  // Editorial affinity: similarity to approved items + eccö's published history + learned features
  const v = r.text_embedding;
  const keys = featureKeys(r);
  const matched = keys.map((k) => profile.featureWeights.get(k)).filter((x): x is number => x !== undefined);
  const featureMean = matched.length ? matched.reduce((a, b) => a + b, 0) / matched.length : 0;
  if (profile.approvedCount === 0 && profile.historyCount === 0 && matched.length === 0) {
    add('editorial_affinity', null, 'No editorial decisions or imported eccö history yet.');
  } else {
    const simA = profile.approvedCentroid ? scaleSim(cosine(v, profile.approvedCentroid)) : 0;
    const simH = profile.historyCentroid ? scaleSim(cosine(v, profile.historyCentroid)) : 0;
    const hasA = !!profile.approvedCentroid;
    const hasH = !!profile.historyCentroid;
    const sim = hasA && hasH ? 0.6 * simA + 0.4 * simH : hasA ? simA : simH;
    const value = 0.7 * sim + 0.3 * (0.5 + 0.5 * featureMean);
    add('editorial_affinity', value, `Text similarity to approved items/eccö history ${sim.toFixed(2)}; learned feature signal ${featureMean.toFixed(2)} (${matched.length} matched).`);
    if (sim >= 0.6) reasons.push(hasA ? 'Close to references you approved' : 'Close to subjects eccö has published');
    if (featureMean <= -0.3) caveats.push('Matches creators or topics you rejected at topic level');
    else if (featureMean >= 0.3) reasons.push('Shares creators or tags you have favoured');
  }

  // Cultural relevance: documented entities, especially ones shared with approved items
  const shared = r.entity_ids.filter((e) => profile.approvedEntityIds.has(e)).length;
  const cultural = clamp01(Math.min(r.entity_ids.length, 3) * 0.15 + (shared > 0 ? 0.4 + 0.1 * Math.min(shared, 2) : 0) + (r.tags.length > 0 ? 0.1 : 0));
  add('cultural_relevance', cultural, `${r.entity_ids.length} documented entities, ${shared} shared with approved references.`);
  if (shared > 0) reasons.push('Connected to entities in approved references');

  // Query relevance
  if (ctx.queryEmbedding) {
    const s = scaleSim(cosine(v, ctx.queryEmbedding));
    add('semantic_relevance', s, `Lexical similarity to "${ctx.queryLabel ?? 'query'}".`);
    if (s >= 0.5) reasons.push(`Matches "${ctx.queryLabel ?? 'the query'}"`);
  } else {
    add('semantic_relevance', null, 'No active query.');
  }

  add('visual_affinity', null, 'No vision model configured; visual affinity is not computed.');

  // Novelty relative to what eccö already holds or published
  const pool = profile.archiveEmbeddings.concat(profile.historyEmbeddings);
  if (pool.length === 0) {
    add('novelty', null, 'Archive is empty; novelty cannot be estimated yet.');
  } else {
    const nearest = maxSim(v, pool);
    const nov = 1 - scaleSim(nearest);
    add('novelty', nov, `Nearest archived/published item similarity ${nearest.toFixed(2)}.`);
    if (nov >= 0.75 && ctx.mode !== 'familiar') reasons.push('New territory relative to the archive');
  }

  // Research potential: how much verifiable material there is to work with
  let rp = 0;
  if (r.creator_name) rp += 0.25;
  if (r.published_date) rp += 0.15;
  if ((r.description ?? '').length >= 80) rp += 0.2;
  if (r.license || r.rights_statement) rp += 0.1;
  if (r.entity_ids.length) rp += 0.2;
  if (r.creator_url) rp += 0.1;
  add('research_potential', rp, 'Completeness of creator, date, description, rights and linked entities.');
  if (!r.creator_name) caveats.push('Creator unknown');
  if (!r.published_date) caveats.push('Date unknown');

  // Source reliability (separate from editorial relevance)
  let rel = profile.sourceReliability.get(r.source_id) ?? 0.5;
  if (r.attribution_status === 'reported_incorrect') rel *= 0.3;
  else if (r.attribution_status === 'editor_confirmed') rel = Math.max(rel, 0.9);
  else if (!r.creator_name) rel *= 0.75;
  add('source_reliability', rel, `Source baseline adjusted for attribution status (${r.attribution_status}).`);
  if (r.attribution_status === 'reported_incorrect') caveats.push('Attribution reported incorrect');

  const ar = audienceResonance(v, profile);
  add('audience_resonance', ar.value, ar.note);
  if (ar.value !== null && ar.value >= 0.65) reasons.push('Similar eccö posts resonated with the audience');

  // Weighted mean over components that could be computed
  const avail = components.filter((c) => c.value !== null && c.weight > 0);
  const wsum = avail.reduce((a, c) => a + c.weight, 0);
  let total = wsum > 0 ? avail.reduce((a, c) => a + c.weight * (c.value as number), 0) / wsum : 0;

  const penalties: ScoreResult['penalties'] = [];
  const nearestHistory = maxSim(v, profile.historyEmbeddings);
  if (nearestHistory >= 0.6) {
    penalties.push({ key: 'historical_exposure', label: 'Very close to a post eccö already published', amount: ctx.historicalExposurePenalty ?? 0.1 });
  }
  // Unverifiable or inaccessible material must not rank highly just because it is attractive
  if (r.attribution_status === 'reported_incorrect') penalties.push({ key: 'misattribution', label: 'Attribution reported incorrect', amount: 0.25 });
  if (!r.preview_url && !(r.description ?? '').trim()) penalties.push({ key: 'inaccessible', label: 'No preview or description available', amount: 0.15 });
  // Experimental mode still needs a defensible connection
  if (ctx.mode === 'experimental') {
    const aff = components.find((c) => c.key === 'editorial_affinity')?.value ?? 0;
    const q = components.find((c) => c.key === 'semantic_relevance')?.value;
    if (aff < 0.15 && cultural < 0.2 && (q === undefined || q === null || q < 0.2)) {
      penalties.push({ key: 'no_connection', label: 'No defensible connection to eccö or the query', amount: 0.2 });
    }
  }
  total = clamp01(total - penalties.reduce((a, p) => a + p.amount, 0));
  if (reasons.length === 0) reasons.push('Surfaced by discovery; few signals connect it to the archive yet');
  return { total, components, penalties, reasons: reasons.slice(0, 3), caveats };
}
