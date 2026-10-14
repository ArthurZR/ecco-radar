import { flagUnsupported, type FactSheet, type VerificationFlag } from './grounding.js';

/**
 * The publication pack: everything the editor needs to post a reference by hand, assembled only from
 * stored facts. RADAR does not post it anywhere. The credit line never names a creator whose
 * attribution was reported incorrect, and says "unknown" rather than guessing.
 */
export interface PackInput {
  refLabel: string;
  status: string;
  attributionStatus: string;
  originalUrl: string;
  creatorUrl: string | null;
  previewUrl: string | null;
  sourceName: string;
  finalCaption: string | null;
  researchSources: { url: string; title: string | null }[];
}

export interface PublicationPack {
  refLabel: string;
  caption: string | null;
  creditLine: string;
  links: { label: string; url: string }[];
  /** Things to settle before posting. Each one is a reminder, not a blocker the app enforces. */
  checks: { key: string; text: string }[];
  captionFlags: VerificationFlag[];
  researchSources: { url: string; title: string | null }[];
  /** Plain text for copying or the .txt export. The part below the marker is for the editor only. */
  text: string;
  notice: string;
}

export const EDITOR_ONLY_MARKER = '--- for the editor only, not for posting ---';

export function creditLine(sheet: FactSheet, sourceName: string): string {
  const get = (k: string) => sheet.facts.find((f) => f.key === k)?.value;
  const title = get('title');
  const creator = get('creator');
  const date = get('date');
  const license = get('license');
  const work = [title ? `“${title}”` : 'Untitled', creator ?? 'creator unknown', date].filter(Boolean).join(', ');
  return [`${work}.`, `Via ${sourceName}.`, license ? `${license}.` : null].filter(Boolean).join(' ').replace(/\.\./g, '.');
}

export function buildPublicationPack(sheet: FactSheet, input: PackInput): PublicationPack {
  const credit = creditLine(sheet, input.sourceName);
  const links = [
    { label: 'Original page', url: input.originalUrl },
    ...(input.creatorUrl ? [{ label: 'Creator page', url: input.creatorUrl }] : []),
    ...(input.previewUrl ? [{ label: 'Image (from the source; check its terms before reposting)', url: input.previewUrl }] : []),
  ];
  const captionFlags = input.finalCaption ? flagUnsupported(input.finalCaption, sheet) : [];

  const checks: PublicationPack['checks'] = [];
  if (!input.finalCaption) checks.push({ key: 'caption', text: 'No final caption saved yet.' });
  if (captionFlags.length) checks.push({ key: 'flags', text: `The final caption has ${captionFlags.length} claim(s) the fact sheet does not support.` });
  if (input.attributionStatus === 'reported_incorrect') checks.push({ key: 'attribution', text: 'Attribution was reported incorrect; the credit line leaves the creator out.' });
  else if (input.attributionStatus !== 'editor_confirmed') checks.push({ key: 'attribution', text: 'Creator is as stated by the source and not yet confirmed by you.' });
  if (!sheet.facts.some((f) => f.key === 'license')) checks.push({ key: 'rights', text: 'The source states no licence or rights; check before reposting the image.' });
  if (input.status !== 'approved_publication' && input.status !== 'manually_published') {
    checks.push({ key: 'status', text: 'Not yet approved for manual publication.' });
  }

  const text = [
    input.finalCaption ?? '(no final caption saved)',
    '',
    credit,
    '',
    EDITOR_ONLY_MARKER,
    `eccö RADAR ${input.refLabel}`,
    ...links.map((l) => `${l.label}: ${l.url}`),
    ...(input.researchSources.length ? ['Research sources:', ...input.researchSources.map((s) => `- ${s.title ? `${s.title} ` : ''}${s.url}`)] : []),
    ...(checks.length ? ['Before posting:', ...checks.map((c) => `- ${c.text}`)] : ['Before posting: nothing outstanding.']),
  ].join('\n');

  return {
    refLabel: input.refLabel, caption: input.finalCaption, creditLine: credit, links, checks, captionFlags,
    researchSources: input.researchSources, text,
    notice: 'Prepared for manual publication. eccö RADAR does not publish or schedule anything.',
  };
}
