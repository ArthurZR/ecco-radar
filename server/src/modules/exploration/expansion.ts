import { db } from '../../db/pool.js';
import { tokenize, extractHashtags } from '../../lib/text.js';
import { seedNeighbours } from './seed-map.js';
import type { WikidataClient } from '../sources/adapters/wikidata.js';
import type { ExplorationMode } from '../ranking/score.js';

export type ExpansionOrigin = 'concept' | 'history' | 'approved_tags' | 'seed_map' | 'knowledge_graph' | 'creator' | 'ai_suggestion';

export interface Expansion {
  query: string;
  origin: ExpansionOrigin;
  rationale: string;
  /** Wikidata entity behind a knowledge-graph branch, for provenance */
  entity?: { id: string; label: string; via?: { id: string; label: string; property: string; propertyLabel: string } };
}

/** Which strategies each mode may use. Familiar stays close to what eccö already holds. */
export const MODE_STRATEGIES: Record<ExplorationMode, ExpansionOrigin[]> = {
  familiar: ['concept', 'history', 'approved_tags'],
  adjacent: ['concept', 'history', 'approved_tags', 'seed_map', 'knowledge_graph', 'creator'],
  experimental: ['concept', 'seed_map', 'knowledge_graph', 'creator', 'history', 'ai_suggestion'],
};

/**
 * Terms that co-occur with the query in a body of texts (eccö captions or approved references).
 * Returns terms ranked by co-occurrence count, excluding terms already in the query.
 */
export function cooccurringTerms(query: string, texts: string[], limit = 4): { term: string; count: number }[] {
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  const counts = new Map<string, number>();
  for (const t of texts) {
    const toks = new Set([...tokenize(t), ...extractHashtags(t)]);
    if (![...q].some((w) => toks.has(w))) continue;
    for (const w of toks) {
      if (q.has(w) || w.length < 4 || /^\d+$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2) // needs repeated evidence, not a single caption
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

export interface ExpansionInput {
  query: string;
  mode: ExplorationMode;
  /** max expansions to return for this step */
  limit: number;
  /** 1-based depth of the expansions being produced */
  depth: number;
  creatorsSeen?: string[];
  wikidata?: WikidataClient;
  aiSuggest?: (query: string, n: number) => Promise<string[]>;
  exclude: Set<string>;
}

export async function expandQuery(input: ExpansionInput): Promise<{ expansions: Expansion[]; errors: string[] }> {
  const strategies = MODE_STRATEGIES[input.mode];
  const out: Expansion[] = [];
  const errors: string[] = [];
  const push = (e: Expansion) => {
    const key = e.query.toLowerCase().trim();
    if (!key || input.exclude.has(key) || out.some((o) => o.query.toLowerCase() === key)) return;
    out.push(e);
  };

  if (strategies.includes('history')) {
    const captions = (await db().query<{ caption: string }>(`SELECT caption FROM historical_posts WHERE caption IS NOT NULL LIMIT 5000`)).rows.map((r) => r.caption);
    for (const t of cooccurringTerms(input.query, captions, 3)) {
      push({ query: `${input.query} ${t.term}`, origin: 'history', rationale: `"${t.term}" appears alongside this topic in ${t.count} eccö captions` });
    }
  }
  if (strategies.includes('approved_tags')) {
    const rows = (await db().query<{ text: string }>(
      `SELECT concat_ws(' ', r.title, r.description, (SELECT string_agg(tag, ' ') FROM reference_tags t WHERE t.reference_id = r.id AND t.state <> 'rejected')) AS text
         FROM reference_items r WHERE r.deleted_at IS NULL
          AND r.status IN ('approved_consideration','caption_draft','reviewed','approved_publication','manually_published') LIMIT 3000`,
    )).rows.map((r) => r.text);
    for (const t of cooccurringTerms(input.query, rows, 3)) {
      push({ query: `${input.query} ${t.term}`, origin: 'approved_tags', rationale: `"${t.term}" co-occurs with this topic in ${t.count} references you approved` });
    }
  }
  if (strategies.includes('seed_map')) {
    for (const n of seedNeighbours(input.query)) {
      for (const term of n.terms.slice(0, input.mode === 'experimental' ? 4 : 2)) {
        push({ query: term, origin: 'seed_map', rationale: `Neighbouring territory of "${n.key}" in the eccö territory map` });
      }
    }
  }
  if (strategies.includes('knowledge_graph') && input.wikidata) {
    try {
      const ents = await input.wikidata.searchEntities(input.query, 2);
      for (const ent of ents.slice(0, 1)) {
        const rels = await input.wikidata.relations(ent.id, 10);
        for (const r of rels.slice(0, input.mode === 'experimental' ? 6 : 4)) {
          push({
            query: r.target.label,
            origin: 'knowledge_graph',
            rationale: `Wikidata: ${ent.label} → ${r.propertyLabel} → ${r.target.label}`,
            entity: { id: r.target.id, label: r.target.label, via: { id: ent.id, label: ent.label, property: r.property, propertyLabel: r.propertyLabel } },
          });
        }
      }
    } catch (e) {
      errors.push(`Wikidata expansion failed: ${(e as Error).message}`);
    }
  }
  if (strategies.includes('creator') && input.creatorsSeen?.length) {
    for (const c of input.creatorsSeen.slice(0, 2)) {
      push({ query: c, origin: 'creator', rationale: `Creator of a result for "${input.query}"; following their other work` });
    }
  }
  if (strategies.includes('ai_suggestion') && input.aiSuggest) {
    try {
      for (const s of await input.aiSuggest(input.query, 3)) {
        push({ query: s, origin: 'ai_suggestion', rationale: 'Suggested by the configured AI provider (unverified suggestion)' });
      }
    } catch (e) {
      errors.push(`AI expansion failed: ${(e as Error).message}`);
    }
  }
  // Interleave origins so one strategy cannot crowd out the others within the budget.
  const byOrigin = new Map<ExpansionOrigin, Expansion[]>();
  out.forEach((e) => byOrigin.set(e.origin, [...(byOrigin.get(e.origin) ?? []), e]));
  const interleaved: Expansion[] = [];
  while (interleaved.length < input.limit && [...byOrigin.values()].some((l) => l.length)) {
    for (const list of byOrigin.values()) {
      const next = list.shift();
      if (next && interleaved.length < input.limit) interleaved.push(next);
    }
  }
  return { expansions: interleaved, errors };
}
