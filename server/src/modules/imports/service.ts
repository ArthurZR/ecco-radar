import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db, withTransaction } from '../../db/pool.js';
import { tryCanonicalizeUrl } from '../../lib/canonical-url.js';
import { textEmbedder } from '../../lib/embedding.js';
import { extractHashtags, extractMentions, extractYears, tokenize } from '../../lib/text.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { invalidateProfile } from '../ranking/profile.js';
import { detectDateOrder, parseCount, parseCsv, parseDateTime, type ParsedCsv } from './normalize.js';
import { DAILY_METRICS, FIELD_ALIASES, POST_METRICS, detectKind, suggestMapping, IMPORT_KINDS, type ImportKind, type ImportOptions } from './schemas.js';

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function inspectCsv(buf: Buffer, filename: string) {
  const csv = parseCsv(buf);
  const detected = detectKind(csv.headers);
  const suggestions = Object.fromEntries(IMPORT_KINDS.map((k) => [k, suggestMapping(k, csv.headers)])) as Record<ImportKind, Record<string, string>>;
  const accountCol = suggestions.instagram_posts.account_handle;
  const accounts = accountCol
    ? Object.entries(csv.rows.reduce<Record<string, number>>((acc, r) => {
        const a = (r[accountCol] ?? '').trim() || '(blank)';
        acc[a] = (acc[a] ?? 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]).map(([account, rows]) => ({ account, rows }))
    : [];
  const dateCol = suggestions[detected.kind ?? 'instagram_posts'].published_at ?? suggestions.x_account_daily.date;
  const fileHash = sha256(buf);
  const prior = await db().query('SELECT id, kind, created_at, imported_count FROM import_batches WHERE file_sha256 = $1 AND status = $2', [fileHash, 'committed']);
  return {
    filename,
    sha256: fileHash,
    delimiter: csv.delimiter,
    headers: csv.headers,
    rowCount: csv.rows.length,
    sample: csv.rows.slice(0, 5),
    detected,
    suggestions,
    fields: Object.fromEntries(IMPORT_KINDS.map((k) => [k, Object.keys(FIELD_ALIASES[k])])) as Record<ImportKind, string[]>,
    accounts,
    dateOrder: dateCol ? detectDateOrder(csv.rows.map((r) => r[dateCol] ?? '')) : 'ISO',
    alreadyImported: prior.rows,
  };
}

type Outcome = 'imported' | 'skipped_account' | 'duplicate' | 'invalid';

export interface NormalizedRow {
  rowIndex: number;
  raw: Record<string, string>;
  outcome: Outcome;
  errors: string[];
  post?: {
    platform: 'instagram' | 'x';
    postId: string | null;
    account: string;
    accountName: string | null;
    caption: string | null;
    permalink: string | null;
    canonicalPermalink: string | null;
    format: string | null;
    publishedAt: string | null;
    durationSeconds: number | null;
    metrics: Partial<Record<(typeof POST_METRICS)[number], number>>;
  };
  daily?: { date: string; metrics: Record<string, number> };
}

export interface ValidationResult {
  kind: ImportKind;
  rows: NormalizedRow[];
  summary: { total: number; valid: number; skippedAccount: number; duplicates: number; invalid: number; newRecords: number; existingRecords: number; dateRange: { from: string | null; to: string | null }; metricsPresent: string[] };
  warnings: string[];
}

function resolveOrder(opts: ImportOptions, csv: ParsedCsv, col: string | undefined): 'MDY' | 'DMY' | 'ISO' {
  if (opts.dateOrder !== 'auto') return opts.dateOrder;
  if (!col) return 'ISO';
  const d = detectDateOrder(csv.rows.map((r) => r[col] ?? ''));
  if (!d) throw new AppError(422, 'ambiguous_dates', 'Dates in this file could be day/month or month/day. Choose the date order before importing.');
  return d;
}

/** Validates and normalises every row without writing anything. */
export async function validateImport(buf: Buffer, opts: ImportOptions): Promise<ValidationResult> {
  const csv = parseCsv(buf);
  const m = opts.mapping;
  for (const [field, col] of Object.entries(m)) {
    if (col && !csv.headers.includes(col)) throw badRequest(`Mapped column "${col}" for ${field} is not in the file`);
  }
  const warnings: string[] = [];
  const rows: NormalizedRow[] = [];
  const metricsPresent = new Set<string>();

  if (opts.kind === 'x_account_daily') {
    if (!m.date) throw badRequest('Map the date column');
    if (!opts.account) throw badRequest('Enter the X account handle this overview belongs to');
    const order = resolveOrder(opts, csv, m.date);
    const seen = new Set<string>();
    const metricCols = DAILY_METRICS.filter((k) => m[k]);
    if (!metricCols.length) throw badRequest('Map at least one metric column');
    csv.rows.forEach((raw, i) => {
      const errors: string[] = [];
      const d = parseDateTime(raw[m.date!], order);
      if (!d.ok) errors.push(d.error);
      const date = d.ok && d.value ? d.value.slice(0, 10) : null;
      if (d.ok && !d.value) errors.push('missing date');
      const metrics: Record<string, number> = {};
      for (const k of metricCols) {
        const v = parseCount(raw[m[k]!]);
        if (!v.ok) errors.push(`${k}: ${v.error}`);
        else if (v.value !== null) {
          metrics[k] = v.value;
          metricsPresent.add(k);
        }
      }
      let outcome: Outcome = errors.length ? 'invalid' : 'imported';
      if (date && seen.has(date)) {
        outcome = 'invalid';
        errors.push(`date ${date} appears more than once in this file`);
      }
      if (date) seen.add(date);
      rows.push({ rowIndex: i, raw, outcome, errors, daily: date ? { date, metrics } : undefined });
    });
    warnings.push('These are daily account-level totals. They are stored separately and are never attributed to individual posts.');
    const existing = await db().query<{ metric_date: string }>(
      `SELECT DISTINCT metric_date::text FROM account_daily_metrics a JOIN import_batches b ON b.id = a.batch_id
        WHERE b.status = 'committed' AND a.platform = 'x' AND a.account_handle = $1`,
      [opts.account.toLowerCase()],
    );
    const known = new Set(existing.rows.map((r) => r.metric_date));
    let existingCount = 0;
    for (const r of rows) if (r.outcome === 'imported' && r.daily && known.has(r.daily.date)) {
      r.outcome = 'duplicate';
      existingCount++;
    }
    if (existingCount) warnings.push(`${existingCount} dates already exist from an earlier import; this file's values will be kept as a newer observation.`);
  } else {
    const platform = opts.kind === 'instagram_posts' ? 'instagram' : 'x';
    if (!m.permalink && !m.post_id) throw badRequest('Map a permalink or post id column so posts can be identified');
    if (platform === 'instagram' && !m.account_handle) throw badRequest('Map the account username column so other accounts can be filtered out');
    if (!opts.account) throw badRequest(platform === 'instagram' ? 'Choose which account to import (other accounts are skipped)' : 'Enter the X account handle');
    const order = resolveOrder(opts, csv, m.published_at);
    const target = opts.account.toLowerCase().replace(/^@/, '');
    const seenIds = new Set<string>();
    csv.rows.forEach((raw, i) => {
      const errors: string[] = [];
      const account = (m.account_handle ? raw[m.account_handle] ?? '' : target).trim().replace(/^@/, '').toLowerCase();
      if (platform === 'instagram' && account !== target) {
        rows.push({ rowIndex: i, raw, outcome: 'skipped_account', errors: [`account "${account || 'blank'}" is not ${target}`] });
        return;
      }
      const postId = m.post_id ? (raw[m.post_id] ?? '').trim() || null : null;
      const permalink = m.permalink ? (raw[m.permalink] ?? '').trim() || null : null;
      const canonical = tryCanonicalizeUrl(permalink);
      if (permalink && !canonical) errors.push('permalink is not a valid URL');
      if (!postId && !canonical) errors.push('row has neither a post id nor a permalink');
      const pub = m.published_at ? parseDateTime(raw[m.published_at], order) : { ok: true as const, value: null };
      if (!pub.ok) errors.push(pub.error);
      const dur = m.duration_seconds ? parseCount(raw[m.duration_seconds]) : { ok: true as const, value: null };
      if (!dur.ok) errors.push(`duration: ${dur.error}`);
      const metrics: NonNullable<NormalizedRow['post']>['metrics'] = {};
      for (const k of POST_METRICS) {
        if (!m[k]) continue;
        const v = parseCount(raw[m[k]!]);
        if (!v.ok) errors.push(`${k}: ${v.error}`);
        else if (v.value !== null) {
          metrics[k] = v.value;
          metricsPresent.add(k);
        }
      }
      const key = postId ?? canonical!;
      let outcome: Outcome = errors.length ? 'invalid' : 'imported';
      if (key && seenIds.has(key)) {
        outcome = 'invalid';
        errors.push('same post appears more than once in this file');
      }
      if (key) seenIds.add(key);
      rows.push({
        rowIndex: i, raw, outcome, errors,
        post: {
          platform, postId, account: target, accountName: m.account_name ? raw[m.account_name]?.trim() || null : null,
          caption: m.caption ? raw[m.caption] || null : null, permalink, canonicalPermalink: canonical,
          format: m.format ? raw[m.format]?.trim().toLowerCase() || null : null,
          publishedAt: pub.ok ? pub.value : null, durationSeconds: dur.ok ? dur.value : null, metrics,
        },
      });
    });
    const valid = rows.filter((r) => r.outcome === 'imported' && r.post);
    const existing = await db().query<{ platform_post_id: string | null; canonical_permalink: string | null }>(
      `SELECT platform_post_id, canonical_permalink FROM historical_posts WHERE platform = $1 AND (platform_post_id = ANY($2) OR canonical_permalink = ANY($3))`,
      [platform, valid.map((r) => r.post!.postId).filter(Boolean), valid.map((r) => r.post!.canonicalPermalink).filter(Boolean)],
    );
    const ids = new Set(existing.rows.map((r) => r.platform_post_id));
    const links = new Set(existing.rows.map((r) => r.canonical_permalink));
    for (const r of valid) {
      if ((r.post!.postId && ids.has(r.post!.postId)) || (r.post!.canonicalPermalink && links.has(r.post!.canonicalPermalink))) r.outcome = 'duplicate';
    }
    if (!m.published_at) warnings.push('No publish time column mapped; posts will have no date.');
    warnings.push('Exports contain captions and links, not images. Visual analysis of these posts is incomplete until media is supplied.');
    if (m.published_at) warnings.push('Timestamps carry no timezone in the export and are stored as written.');
  }

  const dates = rows.flatMap((r) => (r.outcome === 'imported' || r.outcome === 'duplicate' ? [r.daily?.date ?? r.post?.publishedAt?.slice(0, 10)] : [])).filter((d): d is string => !!d).sort();
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  return {
    kind: opts.kind,
    rows,
    warnings,
    summary: {
      total: rows.length,
      valid: count('imported') + count('duplicate'),
      skippedAccount: count('skipped_account'),
      duplicates: count('duplicate'),
      invalid: count('invalid'),
      newRecords: count('imported'),
      existingRecords: count('duplicate'),
      dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
      metricsPresent: [...metricsPresent],
    },
  };
}

function postFeatures(caption: string | null, format: string | null) {
  const f: { kind: string; value: string }[] = [];
  for (const h of extractHashtags(caption).slice(0, 20)) f.push({ kind: 'hashtag', value: h });
  for (const mn of extractMentions(caption).slice(0, 10)) f.push({ kind: 'mention', value: mn });
  for (const y of extractYears(caption).slice(0, 5)) f.push({ kind: 'period', value: `${Math.floor(y / 10) * 10}s` });
  const len = (caption ?? '').length;
  f.push({ kind: 'caption_length', value: len === 0 ? 'none' : len < 120 ? 'short' : len < 500 ? 'medium' : 'long' });
  if (format) f.push({ kind: 'format', value: format });
  const counts = new Map<string, number>();
  for (const t of tokenize((caption ?? '').replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/@\S+/g, ' '))) if (t.length > 3) counts.set(t, (counts.get(t) ?? 0) + 1);
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([t]) => f.push({ kind: 'term', value: t }));
  return f;
}

export async function commitImport(buf: Buffer, filename: string, opts: ImportOptions, actorId: string | null) {
  const validation = await validateImport(buf, opts);
  const hash = sha256(buf);
  return withTransaction(async (c: PoolClient) => {
    let batchId: string;
    try {
      const b = await c.query<{ id: string }>(
        `INSERT INTO import_batches(kind, filename, file_sha256, account_filter, column_mapping, row_count, imported_count, skipped_count, duplicate_count, invalid_count, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'committed',$11) RETURNING id`,
        [opts.kind, filename.slice(0, 300), hash, opts.account?.toLowerCase() ?? null, JSON.stringify({ ...opts.mapping, __dateOrder: opts.dateOrder }),
          validation.summary.total, validation.summary.newRecords, validation.summary.skippedAccount, validation.summary.duplicates, validation.summary.invalid, actorId],
      );
      batchId = b.rows[0]!.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'already_imported', 'This exact file has already been imported. Roll back the earlier batch first if you want to re-import it.');
      throw e;
    }
    for (const r of validation.rows) {
      const raw = await c.query<{ id: number }>(
        `INSERT INTO import_raw_rows(batch_id, row_index, raw, outcome, errors) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [batchId, r.rowIndex, JSON.stringify(r.raw), r.outcome, r.errors],
      );
      if (r.outcome !== 'imported' && r.outcome !== 'duplicate') continue;
      if (r.daily) {
        for (const [metric, value] of Object.entries(r.daily.metrics)) {
          await c.query(
            `INSERT INTO account_daily_metrics(platform, account_handle, metric_date, metric, value, batch_id) VALUES ('x',$1,$2,$3,$4,$5)`,
            [opts.account!.toLowerCase().replace(/^@/, ''), r.daily.date, metric, value, batchId],
          );
        }
      } else if (r.post) {
        const p = r.post;
        const found = await c.query<{ id: string }>(
          `SELECT id FROM historical_posts WHERE platform = $1 AND ((platform_post_id IS NOT NULL AND platform_post_id = $2) OR (canonical_permalink IS NOT NULL AND canonical_permalink = $3)) LIMIT 1`,
          [p.platform, p.postId, p.canonicalPermalink],
        );
        let postId = found.rows[0]?.id;
        if (!postId) {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO historical_posts(platform, platform_post_id, account_handle, account_name, caption, permalink, canonical_permalink, format, published_at, duration_seconds, text_embedding, text_embedding_model)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [p.platform, p.postId, p.account, p.accountName, p.caption, p.permalink, p.canonicalPermalink, p.format, p.publishedAt, p.durationSeconds,
              p.caption ? textEmbedder.embed(p.caption) : null, p.caption ? textEmbedder.model : null],
          );
          postId = ins.rows[0]!.id;
          for (const f of postFeatures(p.caption, p.format)) {
            await c.query(`INSERT INTO historical_post_features(post_id, feature_kind, value, evidence) VALUES ($1,$2,$3,'caption_text') ON CONFLICT DO NOTHING`, [postId, f.kind, f.value]);
          }
        }
        await c.query(`INSERT INTO historical_post_imports(post_id, batch_id, raw_row_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [postId, batchId, raw.rows[0]!.id]);
        for (const [metric, value] of Object.entries(p.metrics)) {
          await c.query(`INSERT INTO historical_post_metrics(post_id, batch_id, metric, value) VALUES ($1,$2,$3,$4)`, [postId, batchId, metric, value]);
        }
      }
    }
    await c.query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,'import_commit','import_batch',$2,$3)`, [actorId, batchId, JSON.stringify(validation.summary)]);
    invalidateProfile();
    return { batchId, summary: validation.summary, warnings: validation.warnings };
  });
}

/** Removes everything a batch contributed while keeping its raw rows and record for audit. */
export async function rollbackImport(batchId: string, actorId: string | null) {
  return withTransaction(async (c) => {
    const b = await c.query<{ status: string }>('SELECT status FROM import_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!b.rows[0]) throw new AppError(404, 'not_found', 'Import batch not found');
    if (b.rows[0].status === 'rolled_back') return { ok: true };
    await c.query('DELETE FROM historical_post_metrics WHERE batch_id = $1', [batchId]);
    await c.query('DELETE FROM account_daily_metrics WHERE batch_id = $1', [batchId]);
    await c.query('DELETE FROM historical_post_imports WHERE batch_id = $1', [batchId]);
    const removed = await c.query(`DELETE FROM historical_posts p WHERE NOT EXISTS (SELECT 1 FROM historical_post_imports i WHERE i.post_id = p.id)`);
    await c.query(`UPDATE import_batches SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`, [batchId]);
    await c.query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,'import_rollback','import_batch',$2,$3)`, [actorId, batchId, JSON.stringify({ postsRemoved: removed.rowCount })]);
    invalidateProfile();
    return { ok: true, postsRemoved: removed.rowCount };
  });
}

/** Deletes a rolled-back batch and its raw rows entirely. */
export async function deleteImport(batchId: string) {
  const r = await db().query(`DELETE FROM import_batches WHERE id = $1 AND status = 'rolled_back'`, [batchId]);
  if (!r.rowCount) throw new AppError(409, 'not_rolled_back', 'Roll the batch back before deleting it');
  return { ok: true };
}
