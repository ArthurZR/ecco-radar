import { db } from '../../db/pool.js';
import { cosine } from '../../lib/embedding.js';
import { notFound } from '../../lib/errors.js';
import { getActiveRankingConfig } from '../ranking/config.js';
import { getEditorialProfile } from '../ranking/profile.js';
import { scoreReference, visualScale } from '../ranking/score.js';
import { loadRow, toScorable } from './feed.js';
import { STATUS_META } from './status.js';
import { formatRefNumber } from './types.js';

interface MiniRef {
  id: string;
  refLabel: string;
  title: string | null;
  creatorName: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  status: string;
}

async function minis(ids: string[]): Promise<Map<string, MiniRef>> {
  if (!ids.length) return new Map();
  const r = await db().query<{ id: string; ref_number: number; title: string | null; creator_name: string | null; thumbnail_url: string | null; preview_url: string | null; status: string }>(
    'SELECT id, ref_number, title, creator_name, thumbnail_url, preview_url, status FROM reference_items WHERE id = ANY($1)',
    [ids],
  );
  return new Map(r.rows.map((x) => [x.id, { id: x.id, refLabel: formatRefNumber(x.ref_number), title: x.title, creatorName: x.creator_name, thumbnailUrl: x.thumbnail_url, previewUrl: x.preview_url, status: x.status }]));
}

export async function getReferenceDetail(refNumber: number) {
  const row = await loadRow('ref_number', refNumber);
  if (!row) throw notFound('Reference');
  const id = row.id;

  const [tags, entities, relations, discoveries, decisions, notes, research, drafts, finalCaption, publications, candidates] = await Promise.all([
    db().query('SELECT tag, origin, state, confidence FROM reference_tags WHERE reference_id = $1 ORDER BY origin, tag', [id]),
    db().query(
      `SELECT e.id AS entity_id, e.label, e.kind, e.wikidata_id, e.external_url, re.predicate, re.evidence, re.confidence, re.provenance, re.provenance_url
         FROM reference_entities re JOIN cultural_entities e ON e.id = re.entity_id WHERE re.reference_id = $1 ORDER BY re.evidence, e.label`,
      [id],
    ),
    db().query<{ id: string; other_id: string; kind: string; score: number | null; method: string; evidence: string }>(
      `SELECT id, CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS other_id, kind, score, method, evidence
         FROM reference_relations WHERE from_id = $1 OR to_id = $1`,
      [id],
    ),
    db().query(
      `SELECT d.id, d.method, d.query_text, d.path, d.rank_in_results, d.discovered_at, d.is_first, d.score_snapshot, d.source_id,
              s.id AS session_id, s.query AS session_query, s.mode AS session_mode
         FROM reference_discoveries d LEFT JOIN exploration_sessions s ON s.id = d.session_id
        WHERE d.reference_id = $1 ORDER BY d.discovered_at`,
      [id],
    ),
    db().query(
      `SELECT d.id, d.decision_type, d.reason_code, d.reason_scope, d.notes, d.previous_status, d.new_status, d.payload, d.created_at, u.display_name AS actor
         FROM editorial_decisions d LEFT JOIN users u ON u.id = d.actor_id WHERE d.reference_id = $1 ORDER BY d.created_at DESC`,
      [id],
    ),
    db().query(
      `SELECT n.id, n.body, n.created_at, n.updated_at, u.display_name AS author FROM research_notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.reference_id = $1 ORDER BY n.created_at DESC`,
      [id],
    ),
    db().query('SELECT id, url, title, publisher, kind, excerpt, added_by, accessed_at FROM research_sources WHERE reference_id = $1 ORDER BY accessed_at', [id]),
    db().query('SELECT id, version, origin, length_setting, purpose, created_at, left(body, 200) AS preview FROM caption_drafts WHERE reference_id = $1 ORDER BY version DESC', [id]),
    db().query('SELECT body, based_on_draft_id, updated_at FROM final_captions WHERE reference_id = $1', [id]),
    db().query('SELECT platform, permalink, published_on, verification, created_at FROM publication_reports WHERE reference_id = $1 ORDER BY created_at DESC', [id]),
    db().query<{ id: string; text_embedding: number[] | null; visual_embedding: number[] | null; creator_name: string | null; status: string }>(
      `SELECT id, text_embedding, visual_embedding, creator_name, status FROM reference_items
        WHERE id <> $1 AND deleted_at IS NULL ORDER BY discovered_at DESC LIMIT 3000`,
      [id],
    ),
  ]);

  // Related references, kept in separate lists so visual and semantic similarity are never conflated.
  const semantic = candidates.rows
    .map((c) => ({ id: c.id, score: cosine(row.text_embedding, c.text_embedding) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  // Visual: colour/tone vectors only. Near-identical images are handled as duplicate candidates.
  const visual = row.visual_embedding
    ? candidates.rows
        .filter((c) => c.visual_embedding)
        .map((c) => ({ id: c.id, score: visualScale(cosine(row.visual_embedding, c.visual_embedding)) }))
        .filter((x) => x.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
    : null;
  const sameCreator = row.creator_name
    ? candidates.rows.filter((c) => c.creator_name && c.creator_name.toLowerCase() === row.creator_name!.toLowerCase()).slice(0, 8).map((c) => ({ id: c.id, score: 1 }))
    : [];
  const sharedEntity = await db().query<{ id: string; n: number }>(
    `SELECT re2.reference_id AS id, count(*)::int AS n FROM reference_entities re1
       JOIN reference_entities re2 ON re2.entity_id = re1.entity_id AND re2.reference_id <> re1.reference_id
       JOIN reference_items r ON r.id = re2.reference_id AND r.deleted_at IS NULL
      WHERE re1.reference_id = $1 AND re1.evidence <> 'editor_rejected' AND re2.evidence <> 'editor_rejected'
      GROUP BY re2.reference_id ORDER BY n DESC LIMIT 8`,
    [id],
  );
  const allIds = [...new Set([...semantic, ...(visual ?? []), ...sameCreator, ...sharedEntity.rows].map((x) => x.id).concat(relations.rows.map((r) => r.other_id)))];
  const m = await minis(allIds);
  const attach = (list: { id: string; score: number }[]) => list.map((x) => ({ ...m.get(x.id)!, score: x.score })).filter((x) => x.refLabel);

  const [config, profile] = await Promise.all([getActiveRankingConfig(), getEditorialProfile()]);
  const score = scoreReference(toScorable(row), profile, config.weights, { mode: 'adjacent', novelty: 0.5, historicalExposurePenalty: config.diversity.historical_exposure_penalty });

  return {
    reference: {
      id: row.id,
      refNumber: row.ref_number,
      refLabel: formatRefNumber(row.ref_number),
      originalUrl: row.original_url,
      canonicalUrl: row.canonical_url,
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceItemId: row.source_item_id,
      creatorName: row.creator_name,
      creatorUrl: row.creator_url,
      title: row.title,
      description: row.description,
      publishedRaw: row.published_raw,
      publishedDate: row.published_date,
      publishedPrecision: row.published_precision,
      discoveredAt: row.discovered_at,
      previewUrl: row.preview_url,
      thumbnailUrl: row.thumbnail_url,
      mediaType: row.media_type,
      width: row.width,
      height: row.height,
      durationSeconds: row.duration_seconds,
      license: row.license,
      rightsStatement: row.rights_statement,
      verificationStatus: row.verification_status,
      attributionStatus: row.attribution_status,
      status: row.status,
      statusMeta: STATUS_META[row.status],
      duplicateGroupId: row.duplicate_group_id,
      deletedAt: row.deleted_at,
      embeddingModel: row.text_embedding ? 'lexical-hash-v1' : null,
      visualAnalysis: row.visual_embedding
        ? { state: 'analysed', at: row.visual_analyzed_at, model: 'colour-tone-v1 + dhash-64', note: 'Colour, tone and layout structure only. Subjects and style are not recognised.' }
        : row.visual_error
          ? { state: 'failed', at: row.visual_analyzed_at, error: row.visual_error }
          : { state: row.thumbnail_url || row.preview_url ? 'pending' : 'no_preview' },
    },
    tags: tags.rows,
    entities: entities.rows,
    duplicates: relations.rows
      .filter((r) => ['duplicate_candidate', 'confirmed_duplicate', 'not_duplicate'].includes(r.kind))
      .map((r) => ({ kind: r.kind, method: r.method, score: r.score, evidence: r.evidence, other: m.get(r.other_id) ?? null })),
    related: {
      semantic: attach(semantic),
      visual: visual ? attach(visual) : null,
      sameCreator: attach(sameCreator),
      sharedEntities: attach(sharedEntity.rows.map((r) => ({ id: r.id, score: r.n }))),
    },
    discoveries: discoveries.rows,
    decisions: decisions.rows,
    notes: notes.rows,
    researchSources: research.rows,
    captionDrafts: drafts.rows,
    finalCaption: finalCaption.rows[0] ?? null,
    publicationReports: publications.rows,
    score: { ...score, rankingVersion: config.version, mode: 'adjacent' },
  };
}
