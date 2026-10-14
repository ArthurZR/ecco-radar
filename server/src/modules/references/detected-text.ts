import { db } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { detectText, OCR_MODEL } from '../../lib/ocr.js';
import { httpClient } from '../sources/registry.js';
import { enqueue } from '../jobs/queue.js';

/**
 * Text visible in a reference's image, read locally by OCR. The image is fetched read-only from
 * its source (SSRF-guarded, size-capped) and nothing is sent elsewhere. The result is a
 * suggestion; the editor confirms, corrects or rejects it.
 */

const MAX_IMAGE_BYTES = 8_000_000;

export async function textDetectionEnabled(): Promise<boolean> {
  const r = await db().query<{ value: boolean }>(`SELECT value FROM app_settings WHERE key = 'text_detection_enabled'`);
  return r.rows[0]?.value ?? true;
}

export interface DetectedText {
  outcome: 'found' | 'none' | 'failed';
  text: string | null;
  confidence: number | null;
  wordCount: number;
  model: string;
  imageUrl: string | null;
  error: string | null;
  analyzedAt: string;
  reviewState: 'suggested' | 'confirmed' | 'corrected' | 'rejected';
  correctedText: string | null;
  reviewedAt: string | null;
  /** What the editor stands behind: the correction, or the confirmed reading. Null until reviewed. */
  confirmedText: string | null;
}

interface Row {
  outcome: DetectedText['outcome']; text: string | null; confidence: number | null; word_count: number; model: string;
  image_url: string | null; error: string | null; analyzed_at: Date; review_state: DetectedText['reviewState'];
  corrected_text: string | null; reviewed_at: Date | null;
}

function toDetected(r: Row): DetectedText {
  return {
    outcome: r.outcome, text: r.text, confidence: r.confidence, wordCount: r.word_count, model: r.model, imageUrl: r.image_url,
    error: r.error, analyzedAt: r.analyzed_at.toISOString(), reviewState: r.review_state, correctedText: r.corrected_text,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    confirmedText: r.review_state === 'corrected' ? r.corrected_text : r.review_state === 'confirmed' ? r.text : null,
  };
}

export async function getDetectedText(referenceId: string): Promise<DetectedText | null> {
  const r = await db().query<Row>('SELECT * FROM reference_detected_text WHERE reference_id = $1', [referenceId]);
  return r.rows[0] ? toDetected(r.rows[0]) : null;
}

/** Reads the text in a reference's image and stores the result. */
export async function detectReferenceText(referenceId: string): Promise<DetectedText> {
  const r = await db().query<{ thumbnail_url: string | null; preview_url: string | null; source_id: string; deleted_at: string | null }>(
    'SELECT thumbnail_url, preview_url, source_id, deleted_at FROM reference_items WHERE id = $1',
    [referenceId],
  );
  const row = r.rows[0];
  if (!row || row.deleted_at) throw notFound('Reference');
  // The larger image reads better; the thumbnail is the fallback.
  const url = row.preview_url ?? row.thumbnail_url;
  let result: { outcome: DetectedText['outcome']; text: string | null; confidence: number | null; words: number; error: string | null };
  if (!url) {
    result = { outcome: 'failed', text: null, confidence: null, words: 0, error: 'No preview image' };
  } else {
    try {
      const res = await httpClient().getBytes(url, { maxBytes: MAX_IMAGE_BYTES, rateKey: `image:${row.source_id}`, ratePerMinute: 30, timeoutMs: 20_000, headers: { accept: 'image/*' } });
      if (!/^image\//i.test(res.contentType)) throw new Error(`Preview is not an image (${res.contentType || 'unknown type'})`);
      const ocr = await detectText(res.body);
      result = { outcome: ocr.words ? 'found' : 'none', text: ocr.words ? ocr.text : null, confidence: ocr.confidence, words: ocr.words, error: null };
    } catch (e) {
      result = { outcome: 'failed', text: null, confidence: null, words: 0, error: `Could not read the image: ${(e as Error).message}`.slice(0, 500) };
    }
  }
  // A new reading keeps the editor's review only when it cannot have changed what was reviewed:
  // a correction stands on its own; a confirmation or rejection holds while the text is the same.
  const saved = await db().query<Row>(
    `INSERT INTO reference_detected_text(reference_id, outcome, text, confidence, word_count, model, image_url, error, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (reference_id) DO UPDATE SET
       outcome = EXCLUDED.outcome, confidence = EXCLUDED.confidence, word_count = EXCLUDED.word_count, model = EXCLUDED.model,
       image_url = EXCLUDED.image_url, error = EXCLUDED.error, analyzed_at = now(),
       review_state = CASE
         WHEN reference_detected_text.review_state = 'corrected' THEN 'corrected'
         WHEN reference_detected_text.text IS NOT DISTINCT FROM EXCLUDED.text THEN reference_detected_text.review_state
         ELSE 'suggested' END,
       reviewed_at = CASE
         WHEN reference_detected_text.review_state = 'corrected' OR reference_detected_text.text IS NOT DISTINCT FROM EXCLUDED.text
         THEN reference_detected_text.reviewed_at ELSE NULL END,
       text = EXCLUDED.text
     RETURNING *`,
    [referenceId, result.outcome, result.text, result.confidence, result.words, OCR_MODEL, url, result.error],
  );
  return toDetected(saved.rows[0]!);
}

export type ReviewAction = { action: 'confirm' } | { action: 'reject' } | { action: 'correct'; text: string } | { action: 'reset' };

export async function reviewDetectedText(referenceId: string, review: ReviewAction, userId: string): Promise<DetectedText> {
  const cur = await getDetectedText(referenceId);
  if (review.action !== 'correct' && !cur) throw notFound('Detected text');
  if (review.action === 'confirm' && cur?.outcome !== 'found') throw badRequest('There is no detected text to confirm. Use Correct to type what the image says.');
  const state = review.action === 'confirm' ? 'confirmed' : review.action === 'reject' ? 'rejected' : review.action === 'correct' ? 'corrected' : 'suggested';
  const corrected = review.action === 'correct' ? review.text.trim() : null;
  if (review.action === 'correct' && !corrected) throw badRequest('Type the text as it appears, or reject the suggestion instead.');
  const r = await db().query<Row>(
    `INSERT INTO reference_detected_text(reference_id, outcome, model, review_state, corrected_text, reviewed_at, reviewed_by)
     VALUES ($1, 'none', 'editor', $2, $3, now(), $4)
     ON CONFLICT (reference_id) DO UPDATE SET review_state = EXCLUDED.review_state, corrected_text = EXCLUDED.corrected_text,
       reviewed_at = CASE WHEN EXCLUDED.review_state = 'suggested' THEN NULL ELSE now() END, reviewed_by = EXCLUDED.reviewed_by
     RETURNING *`,
    [referenceId, state, corrected, userId],
  );
  await db().query(
    `INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,'detected_text_reviewed','reference',$2,$3)`,
    [userId, referenceId, JSON.stringify({ action: review.action })],
  );
  return toDetected(r.rows[0]!);
}

/** Queues text detection for references with an image that have not been read yet. */
export async function queuePendingTextDetection(limit = 50): Promise<number> {
  if (!(await textDetectionEnabled())) return 0;
  const r = await db().query<{ id: string }>(
    `SELECT r.id FROM reference_items r
      WHERE r.deleted_at IS NULL AND coalesce(r.preview_url, r.thumbnail_url) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reference_detected_text d WHERE d.reference_id = r.id)
      ORDER BY r.discovered_at DESC LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const { id } of r.rows) if (await enqueue('embed_reference', { referenceId: id, kind: 'text' }, `text:${id}`, 1)) n++;
  return n;
}

export async function textDetectionStatus() {
  const r = await db().query<{ found: number; none: number; failed: number; pending: number; confirmed: number; corrected: number; rejected: number }>(
    `SELECT count(*) FILTER (WHERE d.outcome = 'found')::int AS found,
            count(*) FILTER (WHERE d.outcome = 'none')::int AS none,
            count(*) FILTER (WHERE d.outcome = 'failed')::int AS failed,
            count(*) FILTER (WHERE d.reference_id IS NULL AND coalesce(r.preview_url, r.thumbnail_url) IS NOT NULL)::int AS pending,
            count(*) FILTER (WHERE d.review_state = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE d.review_state = 'corrected')::int AS corrected,
            count(*) FILTER (WHERE d.review_state = 'rejected')::int AS rejected
       FROM reference_items r LEFT JOIN reference_detected_text d ON d.reference_id = r.id
      WHERE r.deleted_at IS NULL`,
  );
  return { ...r.rows[0]!, model: OCR_MODEL };
}
