import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { getTextProvider, AiUnavailableError } from '../../ai/provider.js';
import { buildPublicationPack } from './pack.js';
import { formatRefNumber, parseRefNumber } from '../references/types.js';
import { buildFactSheet, flagUnsupported, groundedTemplate, type CaptionReference, type FactSheet } from './grounding.js';

const LENGTHS = { short: 'one or two sentences (under 220 characters)', medium: 'three to four sentences', long: 'a short paragraph of five to seven sentences' } as const;

export const GenerateSchema = z.object({
  method: z.enum(['ai', 'grounded_template']).default('ai'),
  length: z.enum(['short', 'medium', 'long']).default('medium'),
  purpose: z.enum(['archival_description', 'cultural_context', 'artist_spotlight', 'period_context', 'technique', 'connection']).default('archival_description'),
  tone: z.enum(['restrained', 'conversational', 'scholarly', 'playful']).default('restrained'),
  factualDensity: z.enum(['low', 'medium', 'high']).default('medium'),
  emphasis: z.enum(['context', 'artist', 'work', 'period', 'movement', 'technique', 'significance']).default('context'),
  alternatives: z.number().int().min(1).max(3).default(1),
});

const SYSTEM_PROMPT = `You write captions for eccö, an independent cultural archive and visual curation project about internet culture, design, fashion, music, film, games and digital history. eccö is an archive and mood board, not a personal account.

Voice: cultural research, archival description and concise educational context. Specific, informed, plain English. No marketing language, no hype, no emojis, no hashtags, no URLs or citations, no "this image", no opening filler such as "Step back in time".

Accuracy rules, which override everything else:
- Use only the facts in the fact sheet. Do not add artists, titles, dates, places, events, intentions, techniques or significance that the fact sheet does not state.
- "As stated by source" facts may be used, but do not upgrade them into stronger claims.
- If an item listed as unknown matters, leave it out or say plainly that it is unknown. A shorter, restrained caption is better than an invented one.
- If you include anything you are not certain the fact sheet supports, wrap it in [verify: ...].
- Do not vary the structure just to be clever, and do not force a fixed template either.

Reply with the caption text only.`;

async function loadContext(ref: string) {
  const n = parseRefNumber(ref);
  if (n === null) throw badRequest('Invalid reference number');
  const r = await db().query<CaptionReference & { id: string }>(
    `SELECT r.id, r.title, r.creator_name, r.attribution_status, r.published_raw, r.published_precision, r.description, s.name AS source_name,
            r.original_url, r.license, r.media_type
       FROM reference_items r JOIN sources s ON s.id = r.source_id WHERE r.ref_number = $1 AND r.deleted_at IS NULL`,
    [n],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Reference');
  const [entities, notes, sources] = await Promise.all([
    db().query(`SELECT e.label, e.kind, re.predicate, re.evidence, re.provenance FROM reference_entities re JOIN cultural_entities e ON e.id = re.entity_id WHERE re.reference_id = $1`, [row.id]),
    db().query<{ body: string }>(`SELECT body FROM research_notes WHERE reference_id = $1 ORDER BY created_at`, [row.id]),
    db().query<{ id: string }>(`SELECT id FROM research_sources WHERE reference_id = $1`, [row.id]),
  ]);
  const sheet = buildFactSheet(row, entities.rows, notes.rows.map((x) => x.body));
  return { row, sheet, sourceIds: sources.rows.map((s) => s.id) };
}

function factPrompt(sheet: FactSheet): string {
  const facts = sheet.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
  return `FACT SHEET\n${facts}\n\nUNKNOWN: ${sheet.unknown.length ? sheet.unknown.join(', ') : 'nothing listed'}`;
}

async function nextVersion(referenceId: string): Promise<number> {
  const r = await db().query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM caption_drafts WHERE reference_id = $1', [referenceId]);
  return r.rows[0]!.v;
}

async function insertDraft(d: {
  referenceId: string; parentId?: string | null; body: string; origin: string; provider?: string | null; model?: string | null;
  params?: z.infer<typeof GenerateSchema>; sourceIds: string[]; flags: unknown; actorId: string | null;
}) {
  // Retry once if two drafts race for the same version number
  for (let i = 0; i < 2; i++) {
    try {
      const v = await nextVersion(d.referenceId);
      const r = await db().query(
        `INSERT INTO caption_drafts(reference_id, version, parent_draft_id, body, origin, provider, model, length_setting, purpose, tone, factual_density, emphasis, research_source_ids, verification_flags, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [d.referenceId, v, d.parentId ?? null, d.body, d.origin, d.provider ?? null, d.model ?? null, d.params?.length ?? null, d.params?.purpose ?? null,
          d.params?.tone ?? null, d.params?.factualDensity ?? null, d.params?.emphasis ?? null, d.sourceIds, JSON.stringify(d.flags), d.actorId],
      );
      return r.rows[0];
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || i === 1) throw e;
    }
  }
  throw new Error('unreachable');
}

export async function captionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/captions/:ref', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const { row, sheet } = await loadContext(ref);
    const [drafts, final, sources, provider] = await Promise.all([
      db().query('SELECT * FROM caption_drafts WHERE reference_id = $1 ORDER BY version DESC', [row.id]),
      db().query('SELECT * FROM final_captions WHERE reference_id = $1', [row.id]),
      db().query('SELECT * FROM research_sources WHERE reference_id = $1 ORDER BY accessed_at', [row.id]),
      getTextProvider(),
    ]);
    return {
      factSheet: sheet,
      drafts: drafts.rows,
      finalCaption: final.rows[0] ?? null,
      researchSources: sources.rows,
      ai: provider.provider ? { available: true, provider: provider.provider.name, model: provider.provider.model } : { available: false, reason: provider.reason },
    };
  });

  app.post('/api/captions/:ref/generate', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const params = GenerateSchema.parse(req.body ?? {});
    const { row, sheet, sourceIds } = await loadContext(ref);
    const out = [];
    if (params.method === 'grounded_template') {
      const body = groundedTemplate(sheet, params.length);
      out.push(await insertDraft({ referenceId: row.id, body, origin: 'grounded_template', params, sourceIds, flags: flagUnsupported(body, sheet), actorId: req.user!.id }));
      return { drafts: out };
    }
    const p = await getTextProvider();
    if (!p.provider) throw new AppError(409, 'ai_unavailable', `${p.reason} Use "Assemble from facts" instead, or write the caption yourself.`);
    for (let i = 0; i < params.alternatives; i++) {
      const prompt = `${factPrompt(sheet)}\n\nWrite ${LENGTHS[params.length]}. Purpose: ${params.purpose.replace(/_/g, ' ')}. Tone: ${params.tone}. Factual density: ${params.factualDensity}. Emphasise: ${params.emphasis}.${i > 0 ? ` This is alternative ${i + 1}: take a noticeably different angle or structure from a conventional caption.` : ''}`;
      try {
        const body = await p.provider.generate({ purpose: 'caption_draft', system: SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        out.push(await insertDraft({ referenceId: row.id, body, origin: 'ai_generated', provider: p.provider.name, model: p.provider.model, params, sourceIds, flags: flagUnsupported(body, sheet), actorId: req.user!.id }));
      } catch (e) {
        if (e instanceof AiUnavailableError) throw new AppError(502, 'ai_failed', `Caption generation failed: ${e.message}`);
        throw e;
      }
    }
    return { drafts: out };
  });

  app.post('/api/captions/:ref/rewrite', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const body = z.object({
      draftId: z.string().uuid(),
      instruction: z.enum(['shorter', 'longer', 'more_context', 'less_context', 'plainer', 'more_precise']),
    }).parse(req.body);
    const { row, sheet, sourceIds } = await loadContext(ref);
    const d = (await db().query<{ body: string }>('SELECT body FROM caption_drafts WHERE id = $1 AND reference_id = $2', [body.draftId, row.id])).rows[0];
    if (!d) throw notFound('Draft');
    const p = await getTextProvider();
    if (!p.provider) throw new AppError(409, 'ai_unavailable', `${p.reason} Edit the draft directly instead.`);
    const instructions: Record<typeof body.instruction, string> = {
      shorter: 'Make it noticeably shorter.', longer: 'Make it somewhat longer, using only the fact sheet.', more_context: 'Add more cultural or historical context, only from the fact sheet.',
      less_context: 'Cut background context; keep the essentials.', plainer: 'Use plainer, simpler language.', more_precise: 'Make the wording more precise and specific.',
    };
    try {
      const text = await p.provider.generate({ purpose: 'caption_rewrite', system: SYSTEM_PROMPT, prompt: `${factPrompt(sheet)}\n\nCURRENT DRAFT\n${d.body}\n\n${instructions[body.instruction]}` });
      return { draft: await insertDraft({ referenceId: row.id, parentId: body.draftId, body: text, origin: 'ai_generated', provider: p.provider.name, model: p.provider.model, sourceIds, flags: flagUnsupported(text, sheet), actorId: req.user!.id }) };
    } catch (e) {
      if (e instanceof AiUnavailableError) throw new AppError(502, 'ai_failed', `Rewrite failed: ${e.message}`);
      throw e;
    }
  });

  // Editor-written or edited draft: a new version, never an overwrite
  app.post('/api/captions/:ref/drafts', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(5000), parentDraftId: z.string().uuid().optional() }).parse(req.body);
    const { row, sheet, sourceIds } = await loadContext(ref);
    return insertDraft({ referenceId: row.id, parentId: b.parentDraftId, body: b.body, origin: b.parentDraftId ? 'editor_edited' : 'editor_written', sourceIds, flags: flagUnsupported(b.body, sheet), actorId: req.user!.id });
  });

  app.post('/api/captions/:ref/check', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const b = z.object({ body: z.string().max(5000) }).parse(req.body);
    const { sheet } = await loadContext(ref);
    return { flags: flagUnsupported(b.body, sheet) };
  });

  // The final caption is the editor's own text, stored apart from drafts.
  app.put('/api/captions/:ref/final', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(5000), basedOnDraftId: z.string().uuid().optional() }).parse(req.body);
    const { row } = await loadContext(ref);
    return withTransaction(async (c) => {
      await c.query(
        `INSERT INTO final_captions(reference_id, body, based_on_draft_id, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (reference_id) DO UPDATE SET body = EXCLUDED.body, based_on_draft_id = EXCLUDED.based_on_draft_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [row.id, b.body, b.basedOnDraftId ?? null, req.user!.id],
      );
      await c.query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id) VALUES ($1,'final_caption_saved','reference',$2)`, [req.user!.id, row.id]);
      return { ok: true };
    });
  });

  app.post('/api/captions/:ref/sources', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const b = z.object({
      url: z.string().url().max(2000).refine((u) => /^https?:/i.test(u), 'http(s) only'),
      title: z.string().max(500).optional(),
      publisher: z.string().max(200).optional(),
      excerpt: z.string().max(5000).optional(),
    }).parse(req.body);
    const { row } = await loadContext(ref);
    const r = await db().query(
      `INSERT INTO research_sources(reference_id, url, title, publisher, kind, excerpt, added_by) VALUES ($1,$2,$3,$4,'editor_added',$5,'editor')
       ON CONFLICT (reference_id, url) DO UPDATE SET title = EXCLUDED.title, excerpt = EXCLUDED.excerpt RETURNING *`,
      [row.id, b.url, b.title ?? null, b.publisher ?? null, b.excerpt ?? null],
    );
    return r.rows[0];
  });

  // Export of prepared material for manual publication. Produces text only; nothing is sent anywhere.
  app.get('/api/captions/:ref/export', async (req) => {
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const { row, sheet } = await loadContext(ref);
    const [final, sources, extra] = await Promise.all([
      db().query<{ body: string }>('SELECT body FROM final_captions WHERE reference_id = $1', [row.id]),
      db().query<{ url: string; title: string | null }>('SELECT url, title FROM research_sources WHERE reference_id = $1 ORDER BY accessed_at', [row.id]),
      db().query<{ ref_number: number; status: string; creator_url: string | null; preview_url: string | null }>(
        'SELECT ref_number, status, creator_url, preview_url FROM reference_items WHERE id = $1', [row.id],
      ),
    ]);
    const x = extra.rows[0]!;
    const caption = final.rows[0]?.body ?? null;
    const pack = buildPublicationPack(sheet, {
      refLabel: formatRefNumber(x.ref_number), status: x.status, attributionStatus: row.attribution_status,
      originalUrl: row.original_url, creatorUrl: x.creator_url, previewUrl: x.preview_url, sourceName: row.source_name,
      finalCaption: caption, researchSources: sources.rows,
    });
    return {
      caption,
      media: { originalUrl: row.original_url, creator: row.creator_name, license: row.license },
      researchSources: sources.rows,
      pack,
      notice: pack.notice,
    };
  });
}
