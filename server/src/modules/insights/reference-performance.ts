import { db } from '../../db/pool.js';
import { cosine } from '../../lib/embedding.js';
import { tryCanonicalizeUrl } from '../../lib/canonical-url.js';
import { engagementPerReach, summarize } from './routes.js';
import { alreadyPosted, visualScale } from '../ranking/score.js';

/** Lexical similarity a caption needs before it is shown as "similar wording". */
export const SIMILAR_CAPTION_MIN = 0.3;
const SIMILAR_SHOWN = 5;
/** Raw colour-tone cosine a post image needs before it is shown as "similar colour and tone". */
export const SIMILAR_IMAGE_MIN = 0.85;

export interface PostSummary {
  platform: string;
  account: string;
  permalink: string | null;
  publishedAt: string | null;
  format: string | null;
  captionExcerpt: string | null;
  metrics: Record<string, number>;
  /** (likes + comments + shares + saves) / reach, only when reach and an engagement metric exist. */
  engagementPerReach: number | null;
  similarity?: number;
  /** id of the post's cover image, when the editor supplied the post's media */
  imageId: string | null;
}

export interface ReferencePerformance {
  /** Imported posts whose link matches one the editor recorded as their own manual publication. */
  published: PostSummary[];
  /** Recorded publications whose link matches no imported post (yet). */
  unmatchedReports: { platform: string | null; permalink: string | null; publishedOn: string | null }[];
  /** Imported Instagram posts whose caption shares wording with this reference. */
  similarCaptions: PostSummary[];
  /** eccö posts whose image is near-identical to this reference's preview (dhash-64). */
  alreadyPosted: (PostSummary & { distance: number })[];
  /** eccö posts whose cover image has similar colour and tone (colour-tone-v1). Not about subject. */
  similarImages: PostSummary[];
  /** How many imported posts have images, so the reader knows how much was compared. */
  postsWithImages: number;
  /** Engagement per reach across all imported Instagram posts, for context. */
  baseline: { n: number; median: number | null; p25: number | null; p75: number | null } | null;
  notes: string[];
}

interface Row {
  id: string; platform: string; account_handle: string; permalink: string | null; canonical_permalink: string | null;
  published_at: string | null; format: string | null; caption: string | null; text_embedding: number[] | null;
  metrics: Record<string, number>;
  images: { id: string; visual_hash: string; visual_embedding: number[] }[];
}

function excerpt(s: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

function toSummary(r: Row, similarity?: number): PostSummary {
  return {
    platform: r.platform, account: r.account_handle, permalink: r.permalink, publishedAt: r.published_at, format: r.format,
    captionExcerpt: excerpt(r.caption), metrics: r.metrics, engagementPerReach: engagementPerReach(r.metrics),
    imageId: r.images[0]?.id ?? null,
    ...(similarity === undefined ? {} : { similarity: Math.round(similarity * 100) / 100 }),
  };
}

/**
 * Descriptive performance context for one reference. Nothing here feeds a score or changes a record.
 * X daily account totals are never used because they cannot be tied to a post.
 */
export async function referencePerformance(
  referenceId: string, textEmbedding: number[] | null,
  visual: { embedding: number[] | null; hash: string | null } = { embedding: null, hash: null },
): Promise<ReferencePerformance> {
  const [posts, reports] = await Promise.all([
    db().query<Row>(
      `WITH latest AS (
         SELECT DISTINCT ON (m.post_id, m.metric) m.post_id, m.metric, m.value
           FROM historical_post_metrics m JOIN import_batches b ON b.id = m.batch_id AND b.status = 'committed'
          ORDER BY m.post_id, m.metric, b.created_at DESC)
       SELECT p.id, p.platform, p.account_handle, p.permalink, p.canonical_permalink, p.published_at, p.format, p.caption, p.text_embedding,
              coalesce(jsonb_object_agg(l.metric, l.value::float8) FILTER (WHERE l.metric IS NOT NULL), '{}') AS metrics,
              coalesce((SELECT json_agg(json_build_object('id', m.id, 'visual_hash', m.visual_hash, 'visual_embedding', m.visual_embedding) ORDER BY m.position, m.created_at)
                          FROM historical_post_media m WHERE m.post_id = p.id), '[]') AS images
         FROM historical_posts p LEFT JOIN latest l ON l.post_id = p.id
        WHERE EXISTS (SELECT 1 FROM historical_post_imports hi JOIN import_batches b ON b.id = hi.batch_id AND b.status = 'committed' WHERE hi.post_id = p.id)
        GROUP BY p.id`,
    ),
    db().query<{ platform: string | null; permalink: string | null; published_on: string | null }>(
      `SELECT platform, permalink, published_on::text FROM publication_reports WHERE reference_id = $1 ORDER BY created_at`,
      [referenceId],
    ),
  ]);

  const byLink = new Map(posts.rows.filter((p) => p.canonical_permalink).map((p) => [p.canonical_permalink!, p]));
  const published: PostSummary[] = [];
  const unmatchedReports: ReferencePerformance['unmatchedReports'] = [];
  for (const r of reports.rows) {
    const key = tryCanonicalizeUrl(r.permalink);
    const match = key ? byLink.get(key) : undefined;
    if (match) published.push(toSummary(match));
    else unmatchedReports.push({ platform: r.platform, permalink: r.permalink, publishedOn: r.published_on });
  }

  const publishedIds = new Set(published.map((p) => p.permalink));
  const instagram = posts.rows.filter((p) => p.platform === 'instagram');
  const similarCaptions = textEmbedding
    ? instagram
        .filter((p) => p.text_embedding && !publishedIds.has(p.permalink))
        .map((p) => ({ p, s: cosine(textEmbedding, p.text_embedding) }))
        .filter((x) => x.s >= SIMILAR_CAPTION_MIN)
        .sort((a, b) => b.s - a.s)
        .slice(0, SIMILAR_SHOWN)
        .map(({ p, s }) => toSummary(p, s))
    : [];

  const withImages = posts.rows.filter((p) => p.images.length);
  const byPostId = new Map(withImages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const posted = alreadyPosted(
    visual.hash,
    withImages.flatMap((p) => p.images.map((m) => ({
      hash: m.visual_hash, postId: p.id, permalink: p.permalink, publishedAt: p.published_at ? new Date(p.published_at).toISOString() : null,
    }))),
  ).filter((m) => (seen.has(m.postId) ? false : (seen.add(m.postId), true)))
    .map((m) => ({ ...toSummary(byPostId.get(m.postId)!), distance: m.distance }));
  const postedIds = new Set(posted.map((p) => p.permalink));
  const similarImages = visual.embedding
    ? withImages
        .filter((p) => !postedIds.has(p.permalink) && !publishedIds.has(p.permalink))
        .map((p) => ({ p, raw: cosine(visual.embedding, p.images[0]!.visual_embedding) }))
        .filter((x) => x.raw >= SIMILAR_IMAGE_MIN)
        .sort((a, b) => b.raw - a.raw)
        .slice(0, SIMILAR_SHOWN)
        .map(({ p, raw }) => toSummary(p, visualScale(raw)))
    : [];

  const rates = instagram.map((p) => engagementPerReach(p.metrics)).filter((v): v is number => v !== null);
  const baseline = rates.length ? (({ n, median, p25, p75 }) => ({ n, median, p25, p75 }))(summarize(rates)) : null;

  const notes: string[] = [];
  if (!posts.rows.length) notes.push('No post-level analytics imported yet. Import an Instagram export in Insights → Imports.');
  if (instagram.length && !similarCaptions.length) notes.push('No imported caption shares enough wording with this reference.');
  if (similarCaptions.length) {
    notes.push('Similar wording only: these posts may show different images. Matching is lexical (lexical-hash-v1), not visual.');
  }
  if (baseline && baseline.n < 20) notes.push(`Only ${baseline.n} imported posts have reach and engagement, so the baseline is rough.`);
  if (posted.length) notes.push('Already posted: the image is near-identical to an image eccö published (dhash-64). Check before posting it again.');
  if (similarImages.length) notes.push('Similar colour and tone only (colour-tone-v1): the subject may be entirely different.');
  if (posts.rows.length && !withImages.length) notes.push('No post images imported, so images were not compared. Add them in Insights → Post images.');
  notes.push('Shown for context. It does not change this reference’s score or status.');
  return { published, unmatchedReports, similarCaptions, alreadyPosted: posted, similarImages, postsWithImages: withImages.length, baseline, notes };
}
