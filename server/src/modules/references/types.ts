import { z } from 'zod';
import type { Status } from './status.js';

export const MEDIA_TYPES = ['image', 'video', 'audio', 'text', 'webpage', 'collection', 'unknown'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const ENTITY_KINDS = [
  'person', 'organization', 'work', 'album', 'film', 'game', 'movement', 'community', 'institution',
  'publication', 'technology', 'period', 'location', 'technique', 'concept', 'other',
] as const;

export const ProvenanceStep = z.object({
  kind: z.enum(['query', 'expansion', 'entity', 'reference', 'source', 'feed', 'manual']),
  label: z.string().max(500),
  detail: z.string().max(1000).optional(),
  ref: z.string().max(300).optional(),
});
export type ProvenanceStep = z.infer<typeof ProvenanceStep>;

/** What a source adapter hands to the archive. Every field is source-stated; nothing is inferred here. */
export const DiscoveredItemSchema = z.object({
  sourceId: z.string(),
  sourceItemId: z.string().max(500).optional(),
  originalUrl: z.string().url().max(2000),
  creatorName: z.string().max(500).optional(),
  creatorUrl: z.string().url().max(2000).optional(),
  title: z.string().max(1000).optional(),
  description: z.string().max(20000).optional(),
  publishedRaw: z.string().max(200).optional(),
  previewUrl: z.string().url().max(2000).optional(),
  thumbnailUrl: z.string().url().max(2000).optional(),
  mediaType: z.enum(MEDIA_TYPES),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  license: z.string().max(500).optional(),
  rightsStatement: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(120)).max(80).default([]),
  entities: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        kind: z.enum(ENTITY_KINDS),
        wikidataId: z.string().regex(/^Q\d+$/).optional(),
        predicate: z.enum(['created_by', 'published_in', 'depicts', 'associated_with', 'appeared_in',
          'uses_technique', 'belongs_to_period', 'related_movement']),
        provenance: z.string().max(300),
      }),
    )
    .max(40)
    .default([]),
  researchSources: z
    .array(z.object({ url: z.string().url(), title: z.string().max(500).optional(), kind: z.enum(['original_source', 'creator_page', 'knowledge_base', 'archive', 'article']) }))
    .max(10)
    .default([]),
});
export type DiscoveredItem = z.input<typeof DiscoveredItemSchema>;
export type DiscoveredItemParsed = z.output<typeof DiscoveredItemSchema>;

export interface ReferenceRow {
  id: string;
  ref_number: number;
  original_url: string;
  canonical_url: string;
  source_id: string;
  source_name?: string;
  source_item_id: string | null;
  creator_name: string | null;
  creator_url: string | null;
  title: string | null;
  description: string | null;
  published_raw: string | null;
  published_date: string | null;
  published_precision: 'day' | 'month' | 'year' | 'decade' | 'unknown';
  discovered_at: string;
  preview_url: string | null;
  thumbnail_url: string | null;
  media_type: MediaType;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  license: string | null;
  rights_statement: string | null;
  verification_status: string;
  attribution_status: string;
  status: Status;
  duplicate_group_id: string | null;
  text_embedding: number[] | null;
  visual_hash: string | null;
  visual_embedding: number[] | null;
  visual_analyzed_at: string | null;
  visual_error: string | null;
  deleted_at: string | null;
  updated_at: string;
  tags?: string[];
}

export function formatRefNumber(n: number): string {
  return `#${String(n).padStart(5, '0')}`;
}

export function parseRefNumber(input: string): number | null {
  const m = input.trim().match(/^#?0*(\d{1,12})$/);
  return m ? Number(m[1]) : null;
}
