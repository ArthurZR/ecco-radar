import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { resetVisualAnalysis, visualAnalysisStatus } from '../references/visual.js';

const SETTINGS = {
  external_ai_enabled: { default: false, description: 'Allow sending reference metadata (never analytics files) to the configured AI provider for caption drafts and query expansion.' },
  background_paused: { default: false, description: 'Pause all scheduled background discovery.' },
  visual_analysis_enabled: {
    default: true,
    description: 'Download each reference’s preview image once (from its source, read-only) to compute a local colour/tone vector and perceptual hash. Nothing is sent to any third party.',
  },
} as const;
type Key = keyof typeof SETTINGS;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => {
    const rows = (await db().query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings')).rows;
    const usage = (await db().query(
      `SELECT provider, model, purpose, count(*)::int AS calls, count(*) FILTER (WHERE succeeded)::int AS succeeded,
              coalesce(sum(input_tokens),0)::int AS input_tokens, coalesce(sum(output_tokens),0)::int AS output_tokens
         FROM ai_usage WHERE created_at > now() - interval '30 days' GROUP BY 1,2,3 ORDER BY calls DESC`,
    )).rows;
    return {
      settings: Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, { value: rows.find((r) => r.key === k)?.value ?? s.default, description: s.description }])),
      ai: { configured: !!env().ANTHROPIC_API_KEY, provider: env().ANTHROPIC_API_KEY ? 'anthropic' : null, model: env().ANTHROPIC_API_KEY ? env().ANTHROPIC_MODEL : null, usageLast30Days: usage },
      visual: await visualAnalysisStatus(),
      publishing: 'eccö RADAR has no publishing integrations. Approval and "manually published" are records only.',
    };
  });

  app.put('/api/settings/:key', async (req) => {
    const { key } = z.object({ key: z.enum(Object.keys(SETTINGS) as [Key, ...Key[]]) }).parse(req.params);
    const { value } = z.object({ value: z.boolean() }).parse(req.body);
    await db().query(
      `INSERT INTO app_settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    await db().query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,'setting_changed','setting',$2,$3)`, [req.user!.id, key, JSON.stringify({ value })]);
    return { ok: true };
  });

  app.post('/api/visual/reset', async (req) => {
    const { onlyFailed } = z.object({ onlyFailed: z.boolean().default(true) }).parse(req.body ?? {});
    return { reset: await resetVisualAnalysis(onlyFailed) };
  });
}
