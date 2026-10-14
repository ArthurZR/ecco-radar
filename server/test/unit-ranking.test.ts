import { describe, expect, it } from 'vitest';
import { scoreReference, audienceResonance, type EditorialProfile, type ScorableReference } from '../src/modules/ranking/score.js';
import { diversify } from '../src/modules/ranking/diversity.js';
import { DEFAULT_WEIGHTS, DEFAULT_DIVERSITY, WeightsSchema } from '../src/modules/ranking/config.js';
import { textEmbedder } from '../src/lib/embedding.js';

const emptyProfile = (): EditorialProfile => ({
  approvedCentroid: null, approvedCount: 0, historyCentroid: null, historyCount: 0, featureWeights: new Map(),
  archiveEmbeddings: [], historyEmbeddings: [], approvedEntityIds: new Set(), sourceReliability: new Map([['wikimedia_commons', 0.75]]),
  resonance: [], resonanceBasis: 'test',
});
const ref = (text: string, extra: Partial<ScorableReference> = {}): ScorableReference => ({
  id: 'x', source_id: 'wikimedia_commons', creator_name: 'A Creator', creator_url: null, title: text, description: text,
  published_date: '2001-01-01', license: null, rights_statement: null, preview_url: 'https://e.com/i.jpg',
  attribution_status: 'source_provided', text_embedding: textEmbedder.embed(text), tags: [], entity_ids: [], ...extra,
});

describe('scoring', () => {
  it('leaves components it cannot compute as null instead of guessing', () => {
    const s = scoreReference(ref('glossy interface icons'), emptyProfile(), DEFAULT_WEIGHTS, { mode: 'adjacent', novelty: 0.5 });
    const byKey = Object.fromEntries(s.components.map((c) => [c.key, c.value]));
    expect(byKey.editorial_affinity).toBeNull();
    expect(byKey.semantic_relevance).toBeNull();
    expect(byKey.visual_affinity).toBeNull();
    expect(byKey.audience_resonance).toBeNull();
    expect(byKey.research_potential).toBeGreaterThan(0);
    expect(s.total).toBeGreaterThan(0);
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('rewards similarity to approved references and to the query', () => {
    const p = emptyProfile();
    p.approvedCentroid = textEmbedder.embed('frutiger aero glossy interface windows vista wallpaper');
    p.approvedCount = 3;
    const ctx = { mode: 'adjacent' as const, novelty: 0.5, queryEmbedding: textEmbedder.embed('frutiger aero'), queryLabel: 'frutiger aero' };
    const close = scoreReference(ref('frutiger aero glossy interface wallpaper'), p, DEFAULT_WEIGHTS, ctx);
    const far = scoreReference(ref('medieval tapestry wool weaving'), p, DEFAULT_WEIGHTS, ctx);
    expect(close.total).toBeGreaterThan(far.total);
  });

  it('penalises misattributed and inaccessible items', () => {
    const ok = scoreReference(ref('poster design'), emptyProfile(), DEFAULT_WEIGHTS, { mode: 'adjacent', novelty: 0.5 });
    const bad = scoreReference(ref('poster design', { attribution_status: 'reported_incorrect' }), emptyProfile(), DEFAULT_WEIGHTS, { mode: 'adjacent', novelty: 0.5 });
    const hidden = scoreReference(ref('poster design', { preview_url: null, description: null }), emptyProfile(), DEFAULT_WEIGHTS, { mode: 'adjacent', novelty: 0.5 });
    expect(bad.total).toBeLessThan(ok.total);
    expect(bad.penalties.map((p) => p.key)).toContain('misattribution');
    expect(hidden.penalties.map((p) => p.key)).toContain('inaccessible');
  });

  it('caps the audience weight so engagement cannot dominate', () => {
    expect(WeightsSchema.safeParse({ ...DEFAULT_WEIGHTS, audience_resonance: 4 }).success).toBe(false);
  });

  it('needs enough comparable posts before estimating resonance, and shrinks toward the median', () => {
    const p = emptyProfile();
    p.resonance = Array.from({ length: 10 }, () => ({ embedding: textEmbedder.embed('dreamcast advert'), percentile: 1 }));
    expect(audienceResonance(textEmbedder.embed('dreamcast advert'), p).value).toBeNull();
    p.resonance = Array.from({ length: 25 }, (_, i) => ({ embedding: textEmbedder.embed(i < 5 ? 'dreamcast advert' : `unrelated topic ${i} weaving`), percentile: i < 5 ? 1 : 0.2 }));
    const r = audienceResonance(textEmbedder.embed('dreamcast advert'), p).value!;
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(1); // shrinkage keeps it below the raw 100th percentile
  });

  it('requires a defensible connection in experimental mode', () => {
    const s = scoreReference(ref('zzz qqq'), { ...emptyProfile(), approvedCentroid: textEmbedder.embed('frutiger aero'), approvedCount: 1 }, DEFAULT_WEIGHTS,
      { mode: 'experimental', novelty: 1, queryEmbedding: textEmbedder.embed('frutiger aero'), queryLabel: 'frutiger aero' });
    expect(s.penalties.map((p) => p.key)).toContain('no_connection');
  });
});

describe('diversity re-ranking', () => {
  it('pushes repeated creators down without hiding them', () => {
    const items = [
      { id: 'a1', score: 0.9, creator: 'Same', source: 's', tags: [], embedding: null },
      { id: 'a2', score: 0.89, creator: 'Same', source: 's', tags: [], embedding: null },
      { id: 'a3', score: 0.88, creator: 'Same', source: 's', tags: [], embedding: null },
      { id: 'b1', score: 0.8, creator: 'Other', source: 's', tags: [], embedding: null },
    ];
    const out = diversify(items, { ...DEFAULT_DIVERSITY, creator_penalty: 0.12 });
    expect(out.map((o) => o.item.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
    expect(out.length).toBe(4);
    expect(out[2]!.redundancy[0]!.label).toMatch(/Same creator/);
  });
  it('penalises near-identical content', () => {
    const e = textEmbedder.embed('windows xp bliss wallpaper');
    const out = diversify(
      [
        { id: 'x1', score: 0.9, creator: null, source: 's', tags: [], embedding: e },
        { id: 'x2', score: 0.85, creator: null, source: 's', tags: [], embedding: e },
        { id: 'y', score: 0.7, creator: null, source: 's', tags: [], embedding: textEmbedder.embed('dreamcast controller advert') },
      ],
      DEFAULT_DIVERSITY,
    );
    expect(out.map((o) => o.item.id)).toEqual(['x1', 'y', 'x2']);
  });
});
