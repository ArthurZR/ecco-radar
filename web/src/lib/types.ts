export type Status =
  | 'discovered' | 'saved' | 'approved_consideration' | 'rejected' | 'archived'
  | 'caption_draft' | 'reviewed' | 'approved_publication' | 'manually_published';

export const STATUS_LABEL: Record<Status, string> = {
  discovered: 'Discovered',
  saved: 'Saved for research',
  approved_consideration: 'Approved for consideration',
  rejected: 'Rejected',
  archived: 'Archived',
  caption_draft: 'Caption draft',
  reviewed: 'Reviewed',
  approved_publication: 'Approved for manual publication',
  manually_published: 'Manually published',
};

export const STATUS_SHORT: Record<Status, string> = {
  discovered: 'NEW', saved: 'SAVED', approved_consideration: 'APPROVED', rejected: 'REJECTED', archived: 'ARCHIVED',
  caption_draft: 'DRAFTING', reviewed: 'REVIEWED', approved_publication: 'READY', manually_published: 'PUBLISHED*',
};

export const REJECTION_REASONS: { key: string; label: string }[] = [
  { key: 'off_identity', label: 'Outside eccö’s identity' },
  { key: 'low_quality', label: 'Low quality / poor scan' },
  { key: 'already_covered', label: 'Already covered' },
  { key: 'weak_attribution', label: 'Weak or unclear attribution' },
  { key: 'not_now', label: 'Not now' },
  { key: 'too_generic', label: 'Too generic' },
  { key: 'other', label: 'Other' },
];

export interface FeedItem {
  id: string;
  refNumber: number;
  refLabel: string;
  title: string | null;
  creatorName: string | null;
  sourceId: string;
  sourceName: string;
  originalUrl: string;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  width: number | null;
  height: number | null;
  publishedRaw: string | null;
  publishedDate: string | null;
  publishedPrecision: string;
  discoveredAt: string;
  status: Status;
  attributionStatus: string;
  tags: string[];
  duplicateCandidates: number;
  score: number | null;
  reasons: string[];
  caveats: string[];
  redundancy: { label: string; amount: number }[];
}

export interface FeedResponse {
  items: FeedItem[];
  total: number;
  nextOffset: number | null;
  rankingVersion: number | null;
  semanticModel: string | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  connector_type: string;
  enabled: boolean;
  status: string;
  requires_credentials: boolean;
  rate_limit_per_minute: number;
  baseline_reliability: number;
  attribution_requirements: string | null;
  terms_url: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  rate_limited_until: string | null;
  capabilities: Record<string, boolean>;
  accessNotes: string;
  missingConfiguration: string[];
  searchable: boolean;
  referenceCount: number;
}
