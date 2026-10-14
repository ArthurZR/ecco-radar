/**
 * Grounding for Caption Studio: builds the fact sheet a caption may draw on, assembles restrained
 * captions without AI, and flags statements in any draft that the fact sheet does not support.
 */

export interface Fact {
  key: string;
  label: string;
  value: string;
  basis: 'source_metadata' | 'editor_confirmed' | 'editor_note' | 'documented_relation';
  sourceUrl?: string;
}

export interface FactSheet {
  facts: Fact[];
  unknown: string[];
}

export interface CaptionReference {
  title: string | null;
  creator_name: string | null;
  attribution_status: string;
  published_raw: string | null;
  published_precision: string;
  description: string | null;
  source_name: string;
  original_url: string;
  license: string | null;
  media_type: string;
}

export function buildFactSheet(
  r: CaptionReference,
  entities: { label: string; kind: string; predicate: string; evidence: string; provenance: string }[],
  notes: string[],
): FactSheet {
  const facts: Fact[] = [];
  const unknown: string[] = [];
  const confirmed = r.attribution_status === 'editor_confirmed';
  if (r.title) facts.push({ key: 'title', label: 'Title (as given by source)', value: r.title, basis: 'source_metadata', sourceUrl: r.original_url });
  else unknown.push('title');
  if (r.creator_name && r.attribution_status !== 'reported_incorrect') {
    facts.push({ key: 'creator', label: confirmed ? 'Creator (confirmed by editor)' : 'Creator (as stated by source)', value: r.creator_name, basis: confirmed ? 'editor_confirmed' : 'source_metadata', sourceUrl: r.original_url });
  } else unknown.push(r.attribution_status === 'reported_incorrect' ? 'creator (reported incorrect; do not attribute)' : 'creator');
  if (r.published_raw) facts.push({ key: 'date', label: `Date (as given by source; precision: ${r.published_precision})`, value: r.published_raw, basis: 'source_metadata' });
  else unknown.push('date');
  facts.push({ key: 'source', label: 'Found on', value: r.source_name, basis: 'source_metadata', sourceUrl: r.original_url });
  if (r.description) facts.push({ key: 'description', label: 'Source description', value: r.description.slice(0, 2500), basis: 'source_metadata' });
  if (r.license) facts.push({ key: 'license', label: 'Rights', value: r.license, basis: 'source_metadata' });
  for (const e of entities) {
    if (e.evidence !== 'documented' && e.evidence !== 'editor_confirmed') continue;
    facts.push({ key: `entity:${e.label}`, label: `${e.predicate.replace(/_/g, ' ')} (${e.provenance})`, value: e.label, basis: e.evidence === 'editor_confirmed' ? 'editor_confirmed' : 'documented_relation' });
  }
  notes.forEach((n, i) => facts.push({ key: `note:${i}`, label: 'Editor research note', value: n.slice(0, 2000), basis: 'editor_note' }));
  return { facts, unknown };
}

const firstSentence = (s: string) => (s.match(/^[^.!?]{10,300}[.!?]/)?.[0] ?? s.slice(0, 200)).trim();

/**
 * A caption assembled only from the fact sheet, without any AI. Restrained by design: when
 * creator or date are unknown it says less rather than more.
 */
export function groundedTemplate(sheet: FactSheet, length: 'short' | 'medium' | 'long'): string {
  const get = (k: string) => sheet.facts.find((f) => f.key === k)?.value;
  const title = get('title');
  const creator = get('creator');
  const date = get('date');
  const head = [title, creator, date].filter(Boolean).join(', ');
  const parts: string[] = [];
  if (head) parts.push(`${head}.`);
  const desc = get('description');
  if (length !== 'short' && desc) parts.push(firstSentence(desc));
  const movement = sheet.facts.find((f) => f.key.startsWith('entity:') && /movement/.test(f.label))?.value;
  if (length === 'long' && movement) parts.push(`Associated with ${movement}.`);
  if (!parts.length) parts.push('Creator and date unknown.');
  return parts.join(' ').replace(/\.\./g, '.').trim();
}

export interface VerificationFlag {
  claim: string;
  reason: string;
}

const EVALUATIVE = /\b(first|earliest|pioneer(?:ing|ed)?|iconic|legendary|revolutionary|groundbreaking|influential|most famous|invented|definitive|seminal|cult classic)\b/gi;

/**
 * Flags statements that are not supported by the fact sheet: years, numbers, names and strong
 * evaluative claims. This is a safety net for the editor, not proof of accuracy.
 */
export function flagUnsupported(text: string, sheet: FactSheet): VerificationFlag[] {
  const corpus = sheet.facts.map((f) => f.value).join(' \n ').toLowerCase();
  const flags: VerificationFlag[] = [];
  const seen = new Set<string>();
  const add = (claim: string, reason: string) => {
    const k = `${claim}|${reason}`;
    if (!seen.has(k)) {
      seen.add(k);
      flags.push({ claim, reason });
    }
  };
  for (const m of text.match(/\[verify[^\]]*\]/gi) ?? []) add(m, 'Marked for verification by the draft');
  for (const y of text.match(/\b(1[5-9]\d\d|20\d\d)s?\b/g) ?? []) {
    if (!corpus.includes(y.replace(/s$/, ''))) add(y, 'Year not found in the source metadata or notes');
  }
  for (const n of text.match(/\b\d[\d,.]*\b/g) ?? []) {
    if (/^(1[5-9]\d\d|20\d\d)$/.test(n)) continue;
    if (!corpus.includes(n)) add(n, 'Number not found in the source metadata or notes');
  }
  // Capitalised name-like sequences (two+ words) that the facts never mention
  for (const m of text.matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+(?:[A-Z][\p{L}'’-]+|de|van|von|der|da|di|la|le)){1,4})\b/gu)) {
    const phrase = m[1]!;
    if (m.index === 0 || /[.!?]\s*$/.test(text.slice(0, m.index))) {
      // sentence-initial capital: only check if the remaining words are also capitalised
      if (phrase.split(/\s+/).length < 2) continue;
    }
    if (!corpus.includes(phrase.toLowerCase())) add(phrase, 'Name not found in the source metadata or notes');
  }
  for (const m of text.match(EVALUATIVE) ?? []) add(m, 'Evaluative or historical claim; needs a source');
  return flags;
}
