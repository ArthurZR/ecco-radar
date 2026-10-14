import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { invalidateProfile } from '../ranking/profile.js';
import { STATUSES, canTransition, REJECTION_REASONS, type Status } from './status.js';

/**
 * Editorial actions. Each one is recorded in editorial_decisions and audit_events.
 * None of them performs any network request: approval and "published" are records only.
 */

export const StatusChangeSchema = z.object({
  status: z.enum(STATUSES),
  reasonCode: z.enum(REJECTION_REASONS).optional(),
  reasonScope: z.enum(['item', 'topic', 'creator', 'source']).optional(),
  notes: z.string().max(5000).optional(),
  publication: z
    .object({
      platform: z.string().max(60).optional(),
      permalink: z.string().url().max(2000).optional(),
      publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .optional(),
});

async function lockRef(c: PoolClient, id: string) {
  const r = await c.query<{ id: string; status: Status; deleted_at: string | null; ref_number: number }>(
    'SELECT id, status, deleted_at, ref_number FROM reference_items WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Reference');
  return row;
}

async function audit(c: PoolClient, actorId: string | null, action: string, entityId: string, data?: unknown) {
  await c.query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,$2,'reference',$3,$4)`, [
    actorId, action, entityId, data === undefined ? null : JSON.stringify(data),
  ]);
}

export async function changeStatus(id: string, input: z.infer<typeof StatusChangeSchema>, actorId: string | null) {
  const body = StatusChangeSchema.parse(input);
  return withTransaction(async (c) => {
    const ref = await lockRef(c, id);
    if (ref.deleted_at) throw badRequest('Restore this reference before changing its status');
    const check = canTransition(ref.status, body.status);
    if (!check.ok) throw new AppError(409, 'invalid_transition', check.reason);
    if (body.status === 'reviewed') {
      const fc = await c.query('SELECT 1 FROM final_captions WHERE reference_id = $1', [id]);
      if (!fc.rowCount) throw new AppError(409, 'no_final_caption', 'Save a final caption in Caption Studio before marking as reviewed');
    }
    await c.query('UPDATE reference_items SET status = $2, updated_at = now() WHERE id = $1', [id, body.status]);
    const d = await c.query<{ id: string }>(
      `INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, reason_code, reason_scope, notes, previous_status, new_status, payload)
       VALUES ($1,$2,'status_change',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [id, actorId, body.reasonCode ?? null, body.status === 'rejected' ? (body.reasonScope ?? 'item') : null, body.notes ?? null,
        ref.status, body.status, body.publication ? JSON.stringify(body.publication) : null],
    );
    if (body.status === 'manually_published') {
      // Recorded as the editor's own report. RADAR has no means of publishing.
      await c.query(
        `INSERT INTO publication_reports(reference_id, reported_by, platform, permalink, published_on) VALUES ($1,$2,$3,$4,$5)`,
        [id, actorId, body.publication?.platform ?? null, body.publication?.permalink ?? null, body.publication?.publishedOn ?? null],
      );
    }
    await audit(c, actorId, 'status_change', id, { from: ref.status, to: body.status });
    invalidateProfile();
    return { decisionId: d.rows[0]!.id, previous: ref.status, status: body.status };
  });
}

export async function addNote(id: string, body: string, actorId: string | null) {
  const text = z.string().trim().min(1).max(20000).parse(body);
  return withTransaction(async (c) => {
    await lockRef(c, id);
    const r = await c.query<{ id: string }>('INSERT INTO research_notes(reference_id, author_id, body) VALUES ($1,$2,$3) RETURNING id', [id, actorId, text]);
    await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, payload) VALUES ($1,$2,'note_added',$3)`, [
      id, actorId, JSON.stringify({ noteId: r.rows[0]!.id }),
    ]);
    return { id: r.rows[0]!.id };
  });
}

export async function updateNote(id: string, noteId: string, body: string) {
  const text = z.string().trim().min(1).max(20000).parse(body);
  return withTransaction(async (c) => {
    const r = await c.query('UPDATE research_notes SET body = $3, updated_at = now() WHERE id = $2 AND reference_id = $1', [id, noteId, text]);
    if (!r.rowCount) throw notFound('Note');
    return { ok: true };
  });
}

export const TagEditSchema = z.object({
  tag: z.string().trim().toLowerCase().min(1).max(120),
  action: z.enum(['add', 'confirm', 'reject']),
});

export async function editTag(id: string, input: z.infer<typeof TagEditSchema>, actorId: string | null) {
  const body = TagEditSchema.parse(input);
  return withTransaction(async (c) => {
    await lockRef(c, id);
    if (body.action === 'add') {
      await c.query(
        `INSERT INTO reference_tags(reference_id, tag, origin, state) VALUES ($1,$2,'editor','confirmed')
         ON CONFLICT (reference_id, tag, origin) DO UPDATE SET state = 'confirmed'`,
        [id, body.tag],
      );
    } else {
      // Suggested tags (from sources or models) are corrected, never silently removed.
      const r = await c.query(`UPDATE reference_tags SET state = $3 WHERE reference_id = $1 AND tag = $2`, [
        id, body.tag, body.action === 'confirm' ? 'confirmed' : 'rejected',
      ]);
      if (!r.rowCount) throw notFound('Tag');
    }
    await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, payload) VALUES ($1,$2,'tag_edit',$3)`, [
      id, actorId, JSON.stringify(body),
    ]);
    invalidateProfile();
    return { ok: true };
  });
}

export const ReportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attribution_incorrect'), notes: z.string().max(5000).optional() }),
  z.object({ kind: z.literal('attribution_confirmed'), notes: z.string().max(5000).optional() }),
  z.object({ kind: z.literal('irrelevant'), notes: z.string().max(5000).optional(), scope: z.enum(['item', 'topic', 'creator', 'source']).default('item') }),
  z.object({ kind: z.literal('duplicate_of'), otherId: z.string().uuid(), notes: z.string().max(5000).optional() }),
  z.object({ kind: z.literal('not_duplicate_of'), otherId: z.string().uuid() }),
]);

export async function report(id: string, input: z.infer<typeof ReportSchema>, actorId: string | null) {
  const body = ReportSchema.parse(input);
  return withTransaction(async (c) => {
    await lockRef(c, id);
    switch (body.kind) {
      case 'attribution_incorrect':
        await c.query(`UPDATE reference_items SET attribution_status = 'reported_incorrect', verification_status = 'disputed', updated_at = now() WHERE id = $1`, [id]);
        await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, notes) VALUES ($1,$2,'report_attribution',$3)`, [id, actorId, body.notes ?? null]);
        break;
      case 'attribution_confirmed':
        await c.query(`UPDATE reference_items SET attribution_status = 'editor_confirmed', verification_status = 'editor_verified', updated_at = now() WHERE id = $1`, [id]);
        await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, notes) VALUES ($1,$2,'confirm_attribution',$3)`, [id, actorId, body.notes ?? null]);
        break;
      case 'irrelevant':
        await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, reason_scope, notes) VALUES ($1,$2,'report_irrelevant',$3,$4)`, [id, actorId, body.scope, body.notes ?? null]);
        break;
      case 'duplicate_of': {
        if (body.otherId === id) throw badRequest('A reference cannot duplicate itself');
        const other = await lockRef(c, body.otherId);
        const grp = await c.query<{ g: string }>(
          `SELECT coalesce((SELECT duplicate_group_id FROM reference_items WHERE id = $1), (SELECT duplicate_group_id FROM reference_items WHERE id = $2), gen_random_uuid()) AS g`,
          [other.id, id],
        );
        const g = grp.rows[0]!.g;
        await c.query(`UPDATE reference_items SET duplicate_group_id = $3, updated_at = now() WHERE id IN ($1, $2)`, [id, other.id, g]);
        await c.query(`DELETE FROM reference_relations WHERE kind = 'duplicate_candidate' AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`, [id, other.id]);
        await c.query(`INSERT INTO reference_relations(from_id, to_id, kind, method, evidence) VALUES ($1,$2,'confirmed_duplicate','editor','editor_confirmed') ON CONFLICT DO NOTHING`, [id, other.id]);
        await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, notes, payload) VALUES ($1,$2,'mark_duplicate',$3,$4)`, [
          id, actorId, body.notes ?? null, JSON.stringify({ duplicateOf: other.ref_number }),
        ]);
        break;
      }
      case 'not_duplicate_of':
        await c.query(`DELETE FROM reference_relations WHERE kind = 'duplicate_candidate' AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`, [id, body.otherId]);
        await c.query(`INSERT INTO reference_relations(from_id, to_id, kind, method, evidence) VALUES ($1,$2,'not_duplicate','editor','editor_rejected') ON CONFLICT DO NOTHING`, [id, body.otherId]);
        await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, payload) VALUES ($1,$2,'mark_not_duplicate',$3)`, [id, actorId, JSON.stringify({ otherId: body.otherId })]);
        break;
    }
    await audit(c, actorId, `report_${body.kind}`, id);
    invalidateProfile();
    return { ok: true };
  });
}

export const RelationshipDecisionSchema = z.object({
  entityId: z.string().uuid(),
  predicate: z.string().max(60),
  verdict: z.enum(['confirm', 'reject']),
});

export async function decideRelationship(id: string, input: z.infer<typeof RelationshipDecisionSchema>, actorId: string | null) {
  const body = RelationshipDecisionSchema.parse(input);
  return withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE reference_entities SET evidence = $4 WHERE reference_id = $1 AND entity_id = $2 AND predicate = $3`,
      [id, body.entityId, body.predicate, body.verdict === 'confirm' ? 'editor_confirmed' : 'editor_rejected'],
    );
    if (!r.rowCount) throw notFound('Relationship');
    await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, payload) VALUES ($1,$2,$3,$4)`, [
      id, actorId, body.verdict === 'confirm' ? 'relationship_confirm' : 'relationship_reject', JSON.stringify(body),
    ]);
    invalidateProfile();
    return { ok: true };
  });
}

/** Soft delete: the reference number is retired forever; history is kept. */
export async function deleteReference(id: string, reason: string | undefined, actorId: string | null) {
  return withTransaction(async (c) => {
    const ref = await lockRef(c, id);
    if (ref.deleted_at) return { ok: true };
    await c.query('UPDATE reference_items SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
    await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type, notes, previous_status) VALUES ($1,$2,'delete',$3,$4)`, [id, actorId, reason ?? null, ref.status]);
    await audit(c, actorId, 'delete', id, { refNumber: ref.ref_number });
    invalidateProfile();
    return { ok: true };
  });
}

export async function restoreReference(id: string, actorId: string | null) {
  return withTransaction(async (c) => {
    const ref = await lockRef(c, id);
    if (!ref.deleted_at) return { ok: true };
    await c.query('UPDATE reference_items SET deleted_at = NULL, updated_at = now() WHERE id = $1', [id]);
    await c.query(`INSERT INTO editorial_decisions(reference_id, actor_id, decision_type) VALUES ($1,$2,'restore')`, [id, actorId]);
    await audit(c, actorId, 'restore', id);
    invalidateProfile();
    return { ok: true };
  });
}
