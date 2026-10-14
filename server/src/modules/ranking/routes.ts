import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import {
  COMPONENTS, COMPONENT_LABELS, DEFAULT_DIVERSITY, DEFAULT_WEIGHTS, DiversitySchema, WeightsSchema,
  activateRankingVersion, createRankingVersion, getActiveRankingConfig,
} from './config.js';
import { computeLearnedFeatures, invalidateProfile } from './profile.js';

export async function rankingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ranking', async () => {
    const active = await getActiveRankingConfig();
    const versions = (await db().query('SELECT version, note, is_active, created_at, weights, diversity FROM ranking_configs ORDER BY version DESC LIMIT 50')).rows;
    return { active, versions, components: COMPONENTS.map((c) => ({ key: c, label: COMPONENT_LABELS[c] })), defaults: { weights: DEFAULT_WEIGHTS, diversity: DEFAULT_DIVERSITY } };
  });

  app.post('/api/ranking', async (req) => {
    const b = z.object({ weights: WeightsSchema, diversity: DiversitySchema, note: z.string().max(500).optional() }).parse(req.body);
    const cfg = await createRankingVersion(b.weights, b.diversity, b.note ?? null, req.user!.id);
    invalidateProfile();
    return cfg;
  });

  app.post('/api/ranking/:version/activate', async (req) => {
    const { version } = z.object({ version: z.coerce.number().int().positive() }).parse(req.params);
    try {
      await activateRankingVersion(version);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    return { ok: true };
  });

  app.get('/api/preferences', async () => {
    const features = await computeLearnedFeatures();
    const entityIds = features.filter((f) => f.key.startsWith('entity:')).map((f) => f.key.slice(7));
    const labels = entityIds.length
      ? new Map((await db().query<{ id: string; label: string }>('SELECT id, label FROM cultural_entities WHERE id = ANY($1)', [entityIds])).rows.map((r) => [r.id, r.label]))
      : new Map<string, string>();
    const resets = (await db().query('SELECT * FROM preference_resets ORDER BY reset_at DESC LIMIT 20')).rows;
    return {
      explanation: 'Learned from your latest decision on each reference since the last reset. Item-level rejections count weakly; topic, creator or source rejections count fully for that feature only. Overrides replace learned values.',
      features: features.map((f) => {
        const [kind, ...rest] = f.key.split(':');
        const value = rest.join(':');
        return { ...f, kind, value, label: kind === 'entity' ? labels.get(value) ?? value : value };
      }),
      resets,
    };
  });

  app.post('/api/preferences/reset', async (req) => {
    const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    await db().query('INSERT INTO preference_resets(note, created_by) VALUES ($1,$2)', [b.note ?? null, req.user!.id]);
    invalidateProfile();
    return { ok: true };
  });

  app.post('/api/preferences/reset/:id/undo', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db().query('UPDATE preference_resets SET undone_at = now() WHERE id = $1 AND undone_at IS NULL', [id]);
    invalidateProfile();
    return { ok: true };
  });

  const OverrideSchema = z.object({ kind: z.enum(['tag', 'creator', 'source', 'entity', 'media_type']), value: z.string().trim().min(1).max(300), weight: z.number().min(-1).max(1) });
  app.put('/api/preferences/overrides', async (req) => {
    const b = OverrideSchema.parse(req.body);
    await db().query(
      `INSERT INTO preference_overrides(feature_kind, feature_value, weight) VALUES ($1, lower($2), $3)
       ON CONFLICT (feature_kind, feature_value) DO UPDATE SET weight = EXCLUDED.weight, created_at = now()`,
      [b.kind, b.value, b.weight],
    );
    invalidateProfile();
    return { ok: true };
  });
  app.delete('/api/preferences/overrides', async (req) => {
    const b = OverrideSchema.omit({ weight: true }).parse(req.body);
    await db().query('DELETE FROM preference_overrides WHERE feature_kind = $1 AND feature_value = lower($2)', [b.kind, b.value]);
    invalidateProfile();
    return { ok: true };
  });
}
