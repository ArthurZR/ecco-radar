import { z } from 'zod';
import { db } from '../../db/pool.js';

export const COMPONENTS = [
  'editorial_affinity',
  'cultural_relevance',
  'semantic_relevance',
  'visual_affinity',
  'novelty',
  'research_potential',
  'source_reliability',
  'audience_resonance',
] as const;
export type Component = (typeof COMPONENTS)[number];

export const COMPONENT_LABELS: Record<Component, string> = {
  editorial_affinity: 'Editorial affinity',
  cultural_relevance: 'Cultural relevance',
  semantic_relevance: 'Query relevance',
  visual_affinity: 'Visual affinity',
  novelty: 'Novelty',
  research_potential: 'Research potential',
  source_reliability: 'Source reliability',
  audience_resonance: 'Audience resonance',
};

const w = z.number().min(0).max(5);
export const WeightsSchema = z.object({
  editorial_affinity: w,
  cultural_relevance: w,
  semantic_relevance: w,
  visual_affinity: w,
  novelty: w,
  research_potential: w,
  source_reliability: w,
  // capped low on purpose: engagement must never dominate editorial judgement
  audience_resonance: z.number().min(0).max(1.5),
});
export type Weights = z.infer<typeof WeightsSchema>;

export const DiversitySchema = z.object({
  window: z.number().int().min(2).max(60),
  creator_penalty: z.number().min(0).max(1),
  source_penalty: z.number().min(0).max(1),
  tag_overlap_penalty: z.number().min(0).max(1),
  near_duplicate_penalty: z.number().min(0).max(1),
  historical_exposure_penalty: z.number().min(0).max(1),
});
export type Diversity = z.infer<typeof DiversitySchema>;

export const DEFAULT_WEIGHTS: Weights = {
  editorial_affinity: 2.5,
  cultural_relevance: 1.2,
  semantic_relevance: 2,
  visual_affinity: 0.8,
  novelty: 1,
  research_potential: 0.8,
  source_reliability: 1,
  audience_resonance: 0.6,
};

export const DEFAULT_DIVERSITY: Diversity = {
  window: 12,
  creator_penalty: 0.12,
  source_penalty: 0.03,
  tag_overlap_penalty: 0.06,
  near_duplicate_penalty: 0.25,
  historical_exposure_penalty: 0.1,
};

export interface RankingConfig {
  version: number;
  weights: Weights;
  diversity: Diversity;
  note: string | null;
  is_active: boolean;
  created_at: string;
}

/** Returns the active config, creating version 1 with defaults on first use. */
export async function getActiveRankingConfig(): Promise<RankingConfig> {
  const r = await db().query<RankingConfig>('SELECT * FROM ranking_configs WHERE is_active LIMIT 1');
  if (r.rows[0]) {
    return { ...r.rows[0], weights: WeightsSchema.parse(r.rows[0].weights), diversity: DiversitySchema.parse(r.rows[0].diversity) };
  }
  const ins = await db().query<RankingConfig>(
    `INSERT INTO ranking_configs(weights, diversity, note, is_active)
     SELECT $1, $2, 'Initial defaults', true WHERE NOT EXISTS (SELECT 1 FROM ranking_configs WHERE is_active)
     RETURNING *`,
    [JSON.stringify(DEFAULT_WEIGHTS), JSON.stringify(DEFAULT_DIVERSITY)],
  );
  if (ins.rows[0]) return ins.rows[0];
  return getActiveRankingConfig();
}

/** Every change creates a new version; older versions stay available for rollback. */
export async function createRankingVersion(weights: Weights, diversity: Diversity, note: string | null, actorId: string | null): Promise<RankingConfig> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ranking_configs SET is_active = false WHERE is_active');
    const r = await client.query<RankingConfig>(
      `INSERT INTO ranking_configs(weights, diversity, note, is_active, created_by) VALUES ($1,$2,$3,true,$4) RETURNING *`,
      [JSON.stringify(WeightsSchema.parse(weights)), JSON.stringify(DiversitySchema.parse(diversity)), note, actorId],
    );
    await client.query('COMMIT');
    return r.rows[0]!;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function activateRankingVersion(version: number): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM ranking_configs WHERE version = $1', [version]);
    if (!exists.rowCount) throw new Error('Unknown ranking version');
    await client.query('UPDATE ranking_configs SET is_active = false WHERE is_active');
    await client.query('UPDATE ranking_configs SET is_active = true WHERE version = $1', [version]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
