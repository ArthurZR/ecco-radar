/**
 * Editorial states. None of them triggers any external action: they are records of the editor's
 * judgement. Publication happens outside the application and is only ever *reported* here.
 */
export const STATUSES = [
  'discovered',
  'saved',
  'approved_consideration',
  'rejected',
  'archived',
  'caption_draft',
  'reviewed',
  'approved_publication',
  'manually_published',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_META: Record<Status, { label: string; meaning: string }> = {
  discovered: { label: 'Discovered', meaning: 'Found by discovery or import. No editorial judgement yet.' },
  saved: { label: 'Saved for research', meaning: 'Worth investigating further. Not an approval.' },
  approved_consideration: {
    label: 'Approved for editorial consideration',
    meaning: 'Fits eccö and may be developed. This is not approval for publication.',
  },
  rejected: {
    label: 'Rejected',
    meaning: 'Not for eccö. Kept as a learning signal with its reason; it is not deleted.',
  },
  archived: { label: 'Archived', meaning: 'Kept in the archive but out of active consideration.' },
  caption_draft: { label: 'Caption draft', meaning: 'A caption is being prepared in Caption Studio.' },
  reviewed: {
    label: 'Reviewed',
    meaning: 'Context, attribution and caption have been checked by the editor.',
  },
  approved_publication: {
    label: 'Approved for manual publication',
    meaning: 'Ready for the editor to publish by hand outside RADAR. Nothing is sent anywhere.',
  },
  manually_published: {
    label: 'Manually published',
    meaning: 'The editor reports having published it outside RADAR. RADAR did not publish it.',
  },
};

/** Statuses an item may enter from anywhere (revisiting a decision is always allowed). */
const ALWAYS_REACHABLE: Status[] = ['discovered', 'saved', 'approved_consideration', 'rejected', 'archived'];

/**
 * The publication pipeline must be walked in order so that "ready" always means the editor
 * reviewed the material. Moving backwards is always possible.
 */
const PIPELINE_PREREQ: Partial<Record<Status, Status[]>> = {
  caption_draft: ['approved_consideration', 'saved', 'reviewed', 'approved_publication', 'caption_draft'],
  reviewed: ['caption_draft', 'approved_publication'],
  approved_publication: ['reviewed'],
  manually_published: ['approved_publication'],
};

export function canTransition(from: Status, to: Status): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'Item already has this status' };
  if (ALWAYS_REACHABLE.includes(to)) return { ok: true };
  const allowed = PIPELINE_PREREQ[to];
  if (allowed?.includes(from)) return { ok: true };
  const need = (allowed ?? []).map((s) => STATUS_META[s].label).join(' or ');
  return { ok: false, reason: `"${STATUS_META[to].label}" can only follow ${need}` };
}

export const REJECTION_REASONS = [
  'off_identity',
  'low_quality',
  'already_covered',
  'weak_attribution',
  'not_now',
  'too_generic',
  'other',
] as const;
