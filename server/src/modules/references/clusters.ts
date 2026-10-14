import { db } from '../../db/pool.js';
import { cosine } from '../../lib/embedding.js';
import { sphericalKMeans, suggestedK } from '../../lib/kmeans.js';
import { VISUAL_MODEL } from '../../lib/visual.js';
import { formatRefNumber } from './types.js';

export type ClusterBasis = 'text' | 'visual';

const LIMIT = 2000;
const MIN_ITEMS = 6;
const MEMBERS_SHOWN = 12;

export interface Cluster {
  index: number;
  size: number;
  /** Mean cosine similarity of members to the cluster centre (0..1): how tight the group is. */
  cohesion: number;
  /** Tags carried by at least 40% of members, most common first. Empty when members share none. */
  sharedTags: { tag: string; share: number }[];
  statusCounts: Record<string, number>;
  members: { refNumber: number; refLabel: string; title: string | null; creatorName: string | null; thumbnailUrl: string | null; status: string }[];
}

export interface ClusterResult {
  basis: ClusterBasis;
  model: string;
  considered: number;
  /** References left out because they have no vector of this kind yet. */
  withoutVector: number;
  truncated: boolean;
  clusters: Cluster[];
  note: string;
}

const NOTES: Record<ClusterBasis, string> = {
  text: 'Grouped by shared wording in titles, descriptions, creators and tags (lexical-hash-v1). Groups reflect vocabulary, not meaning or images.',
  visual: `Grouped by colour and tone (${VISUAL_MODEL}). Groups reflect palette and brightness, not subject or style.`,
};

/**
 * Groups the live archive (rejected and deleted references excluded) so the editor can see which
 * territories it already covers. Grouping is descriptive: it changes no score and no record.
 */
export async function clusterReferences(basis: ClusterBasis): Promise<ClusterResult> {
  const column = basis === 'text' ? 'text_embedding' : 'visual_embedding';
  const rows = (await db().query<{
    ref_number: number; title: string | null; creator_name: string | null; thumbnail_url: string | null; preview_url: string | null;
    status: string; vec: number[] | null; tags: string[];
  }>(
    `SELECT r.ref_number, r.title, r.creator_name, r.thumbnail_url, r.preview_url, r.status, r.${column} AS vec,
            coalesce((SELECT array_agg(DISTINCT lower(t.tag)) FROM reference_tags t WHERE t.reference_id = r.id AND t.state <> 'rejected'), '{}') AS tags
       FROM reference_items r
      WHERE r.deleted_at IS NULL AND r.status <> 'rejected'
      ORDER BY r.ref_number DESC
      LIMIT ${LIMIT + 1}`,
  )).rows;
  const truncated = rows.length > LIMIT;
  const live = rows.slice(0, LIMIT);
  const items = live.filter((r) => r.vec && r.vec.length > 0);
  const base = {
    basis, model: basis === 'text' ? 'lexical-hash-v1' : VISUAL_MODEL, considered: items.length,
    withoutVector: live.length - items.length, truncated, note: NOTES[basis],
  };
  if (items.length < MIN_ITEMS) return { ...base, clusters: [] };

  // Oldest first, so a new reference does not reshuffle the seeding of the existing groups.
  items.reverse();
  const { assignment, centroids } = sphericalKMeans(items.map((r) => r.vec!), suggestedK(items.length));

  const clusters: Cluster[] = centroids.map((c, index) => {
    const members = items
      .map((r, i) => ({ r, i, sim: cosine(r.vec, c) }))
      .filter((m) => assignment[m.i] === index)
      .sort((a, b) => b.sim - a.sim);
    const tagCounts = new Map<string, number>();
    const statusCounts: Record<string, number> = {};
    for (const { r } of members) {
      for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }
    const size = members.length;
    const sharedTags = [...tagCounts.entries()]
      .filter(([, n]) => size > 0 && n / size >= 0.4 && n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([tag, n]) => ({ tag, share: Math.round((n / size) * 100) / 100 }));
    return {
      index, size, statusCounts, sharedTags,
      cohesion: size ? Math.round((members.reduce((s, m) => s + m.sim, 0) / size) * 100) / 100 : 0,
      members: members.slice(0, MEMBERS_SHOWN).map(({ r }) => ({
        refNumber: r.ref_number, refLabel: formatRefNumber(r.ref_number), title: r.title, creatorName: r.creator_name,
        thumbnailUrl: r.thumbnail_url ?? r.preview_url, status: r.status,
      })),
    };
  });
  return {
    ...base,
    clusters: clusters.filter((c) => c.size > 0).sort((a, b) => b.size - a.size).map((c, i) => ({ ...c, index: i })),
  };
}
