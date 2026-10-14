import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';

/**
 * Insights are descriptive. They use medians and interquartile ranges (robust to viral outliers),
 * require a minimum number of posts per group, state their denominators, and keep post-level
 * Instagram data apart from daily X account totals.
 */

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), min: s[0] ?? null, max: s[s.length - 1] ?? null };
}

const MIN_GROUP = 5;
const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'] as const;

interface PostRow {
  id: string;
  caption: string | null;
  permalink: string | null;
  format: string | null;
  published_at: string | null;
  metrics: Record<string, number>;
  image_id: string | null;
}

export async function loadLatestPostMetrics(platform: 'instagram' | 'x'): Promise<PostRow[]> {
  const r = await db().query<PostRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (m.post_id, m.metric) m.post_id, m.metric, m.value
         FROM historical_post_metrics m JOIN import_batches b ON b.id = m.batch_id AND b.status = 'committed'
        ORDER BY m.post_id, m.metric, b.created_at DESC)
     SELECT p.id, p.caption, p.permalink, p.format, p.published_at, coalesce(jsonb_object_agg(l.metric, l.value) FILTER (WHERE l.metric IS NOT NULL), '{}') AS metrics,
            (SELECT m.id FROM historical_post_media m WHERE m.post_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_id
       FROM historical_posts p LEFT JOIN latest l ON l.post_id = p.id
      WHERE p.platform = $1 GROUP BY p.id`,
    [platform],
  );
  return r.rows;
}

/** (likes + comments + shares + saves) / reach, only when reach > 0 and at least one engagement metric exists. */
export function engagementPerReach(m: Record<string, number>): number | null {
  if (!(m.reach! > 0)) return null;
  const present = ENGAGEMENT.filter((k) => m[k] !== undefined);
  if (!present.length) return null;
  return present.reduce((a, k) => a + m[k]!, 0) / m.reach!;
}

function groupStats(posts: PostRow[], keyOf: (p: PostRow) => string[], value: (p: PostRow) => number | null) {
  const groups = new Map<string, number[]>();
  for (const p of posts) {
    const v = value(p);
    if (v === null) continue;
    for (const k of keyOf(p)) groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  return [...groups.entries()]
    .map(([key, vals]) => ({ key, ...summarize(vals) }))
    .filter((g) => g.n >= MIN_GROUP)
    .sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/insights/overview', async () => {
    const [posts, daily, batches] = await Promise.all([
      db().query(`SELECT platform, account_handle, count(*)::int AS posts, min(published_at) AS first, max(published_at) AS last,
                         count(*) FILTER (WHERE media_available)::int AS with_media FROM historical_posts GROUP BY platform, account_handle`),
      db().query(`SELECT a.platform, a.account_handle, count(DISTINCT a.metric_date)::int AS days, min(a.metric_date)::text AS first, max(a.metric_date)::text AS last,
                         array_agg(DISTINCT a.metric) AS metrics
                    FROM account_daily_metrics a JOIN import_batches b ON b.id = a.batch_id AND b.status = 'committed' GROUP BY a.platform, a.account_handle`),
      db().query(`SELECT count(*) FILTER (WHERE status = 'committed')::int AS committed, count(*) FILTER (WHERE status = 'rolled_back')::int AS rolled_back FROM import_batches`),
    ]);
    const coverage = await db().query(
      `SELECT p.platform, m.metric, count(DISTINCT m.post_id)::int AS posts FROM historical_post_metrics m
         JOIN historical_posts p ON p.id = m.post_id JOIN import_batches b ON b.id = m.batch_id AND b.status = 'committed'
        GROUP BY p.platform, m.metric ORDER BY p.platform, m.metric`,
    );
    return { postLevel: posts.rows, accountDaily: daily.rows, metricCoverage: coverage.rows, batches: batches.rows[0] };
  });

  app.get('/api/insights/instagram', async () => {
    const posts = await loadLatestPostMetrics('instagram');
    const metricNames = [...new Set(posts.flatMap((p) => Object.keys(p.metrics)))].sort();
    const perMetric = Object.fromEntries(metricNames.map((k) => [k, summarize(posts.map((p) => p.metrics[k]).filter((v): v is number => v !== undefined))]));
    const rate = (p: PostRow) => engagementPerReach(p.metrics);
    const savesRate = (p: PostRow) => (p.metrics.reach! > 0 && p.metrics.saves !== undefined ? p.metrics.saves / p.metrics.reach! : null);
    const sharesRate = (p: PostRow) => (p.metrics.reach! > 0 && p.metrics.shares !== undefined ? p.metrics.shares / p.metrics.reach! : null);
    const features = await db().query<{ post_id: string; feature_kind: string; value: string }>(
      `SELECT f.post_id, f.feature_kind, f.value FROM historical_post_features f JOIN historical_posts p ON p.id = f.post_id WHERE p.platform = 'instagram'`,
    );
    const featMap = new Map<string, { kind: string; value: string }[]>();
    for (const f of features.rows) featMap.set(f.post_id, [...(featMap.get(f.post_id) ?? []), { kind: f.feature_kind, value: f.value }]);
    const feat = (kind: string) => (p: PostRow) => (featMap.get(p.id) ?? []).filter((f) => f.kind === kind).map((f) => f.value);
    const month = (p: PostRow) => (p.published_at ? [new Date(p.published_at).toISOString().slice(0, 7)] : []);
    const monthlyAll = (() => {
      const m = new Map<string, number[]>();
      for (const p of posts) {
        const r = rate(p);
        const k = month(p)[0];
        if (r === null || !k) continue;
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return [...m.entries()].map(([key, v]) => ({ key, ...summarize(v) })).sort((a, b) => a.key.localeCompare(b.key));
    })();
    const ranked = posts
      .map((p) => ({ p, r: rate(p) }))
      .filter((x) => x.r !== null && (x.p.metrics.reach ?? 0) >= 100)
      .sort((a, b) => b.r! - a.r!);
    const overall = summarize(ranked.map((x) => x.r!));
    const toPost = (x: { p: PostRow; r: number | null }) => ({
      id: x.p.id, caption: x.p.caption?.slice(0, 280) ?? null, permalink: x.p.permalink, format: x.p.format,
      publishedAt: x.p.published_at, rate: x.r, metrics: x.p.metrics, imageId: x.p.image_id,
    });
    const withMedia = posts.filter((p) => p.image_id).length;
    return {
      posts: posts.length,
      definitions: {
        engagementPerReach: '(likes + comments + shares + saves) ÷ reach, per post, using only metrics present in the export. Posts with reach under 100 are excluded from post rankings.',
        savesPerReach: 'saves ÷ reach',
        sharesPerReach: 'shares ÷ reach',
        grouping: `Medians with interquartile range; groups with fewer than ${MIN_GROUP} posts are hidden. These are associations, not causes.`,
      },
      metrics: perMetric,
      engagementPerReach: overall,
      savesPerReach: summarize(posts.map(savesRate).filter((v): v is number => v !== null)),
      sharesPerReach: summarize(posts.map(sharesRate).filter((v): v is number => v !== null)),
      byFormat: groupStats(posts, (p) => (p.format ? [p.format] : []), rate),
      byCaptionLength: groupStats(posts, feat('caption_length'), rate),
      byHashtag: groupStats(posts, feat('hashtag'), rate).slice(0, 25),
      byTerm: groupStats(posts, feat('term'), rate).slice(0, 25),
      byPeriodMentioned: groupStats(posts, feat('period'), rate),
      byTone: groupStats(posts, feat('tone'), rate),
      byColourfulness: groupStats(posts, feat('colourfulness'), rate),
      postsWithImages: withMedia,
      monthly: monthlyAll,
      top: ranked.slice(0, 10).map(toPost),
      bottom: ranked.slice(-5).reverse().map(toPost),
      visualAnalysis: withMedia === 0
        ? 'Not available: the analytics export contains captions and links only. Add post images in Insights → Post images to analyse colour and tone.'
        : `Colour and tone measured from the cover image of ${withMedia} of ${posts.length} posts (colour-tone-v1). The other ${posts.length - withMedia} have text only. Subjects and style are not recognised.`,
    };
  });

  app.get('/api/insights/x-daily', async (req) => {
    const q = z.object({ account: z.string().max(100).optional() }).parse(req.query);
    const r = await db().query<{ account_handle: string; metric_date: string; metric: string; value: number }>(
      `SELECT DISTINCT ON (a.account_handle, a.metric_date, a.metric) a.account_handle, a.metric_date::text, a.metric, a.value
         FROM account_daily_metrics a JOIN import_batches b ON b.id = a.batch_id AND b.status = 'committed'
        WHERE a.platform = 'x' AND ($1::text IS NULL OR a.account_handle = $1)
        ORDER BY a.account_handle, a.metric_date, a.metric, b.created_at DESC`,
      [q.account ?? null],
    );
    const byDate = new Map<string, Record<string, number>>();
    for (const row of r.rows) byDate.set(row.metric_date, { ...(byDate.get(row.metric_date) ?? {}), [row.metric]: row.value });
    const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, m]) => ({ date, ...m }));
    const metrics = [...new Set(r.rows.map((x) => x.metric))].sort();
    // ISO-week totals
    const weekOf = (d: string) => {
      const dt = new Date(`${d}T00:00:00Z`);
      const day = (dt.getUTCDay() + 6) % 7;
      dt.setUTCDate(dt.getUTCDate() - day);
      return dt.toISOString().slice(0, 10);
    };
    const weeks = new Map<string, Record<string, number> & { days: number }>();
    for (const d of days) {
      const w = weekOf(d.date);
      const acc = weeks.get(w) ?? ({ days: 0 } as Record<string, number> & { days: number });
      acc.days++;
      for (const k of metrics) if (typeof (d as unknown as Record<string, unknown>)[k] === 'number') acc[k] = (acc[k] ?? 0) + ((d as unknown as Record<string, number>)[k] ?? 0);
      weeks.set(w, acc);
    }
    return {
      note: 'Daily account-level totals for the whole X account. They are not linked to individual posts and cannot show which post caused a change.',
      metrics,
      days,
      weekly: [...weeks.entries()].map(([week, v]) => ({ week, ...v })).sort((a, b) => a.week.localeCompare(b.week)),
      totals: Object.fromEntries(metrics.map((k) => [k, summarize(days.map((d) => (d as unknown as Record<string, number>)[k]).filter((v): v is number => typeof v === 'number'))])),
    };
  });

  app.get('/api/insights/editorial', async () => {
    const [bySource, reasons, statusCounts] = await Promise.all([
      db().query(`WITH latest AS (SELECT DISTINCT ON (reference_id) reference_id, new_status FROM editorial_decisions WHERE decision_type = 'status_change' ORDER BY reference_id, created_at DESC)
                  SELECT r.source_id, count(*)::int AS decided,
                         count(*) FILTER (WHERE l.new_status IN ('approved_consideration','caption_draft','reviewed','approved_publication','manually_published'))::int AS approved,
                         count(*) FILTER (WHERE l.new_status = 'rejected')::int AS rejected
                    FROM latest l JOIN reference_items r ON r.id = l.reference_id GROUP BY r.source_id ORDER BY decided DESC`),
      db().query(`SELECT coalesce(reason_code, 'unspecified') AS reason, coalesce(reason_scope, 'item') AS scope, count(*)::int AS n
                    FROM editorial_decisions WHERE decision_type = 'status_change' AND new_status = 'rejected' GROUP BY 1,2 ORDER BY n DESC`),
      db().query(`SELECT status, count(*)::int AS n FROM reference_items WHERE deleted_at IS NULL GROUP BY status`),
    ]);
    return { bySource: bySource.rows, rejectionReasons: reasons.rows, statusCounts: statusCounts.rows };
  });
}
