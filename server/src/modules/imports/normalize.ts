import { parse } from 'csv-parse/sync';

/** Pure CSV parsing and normalisation helpers (no database access), so they are unit-testable. */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

export function parseCsv(buf: Buffer): ParsedCsv {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // UTF-16 exports (some Excel saves) show up as NUL-padded text
  if (text.includes('\u0000')) text = buf.toString('utf16le').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const records = parse(text, {
    columns: (h: string[]) => h.map((x) => x.trim()),
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]!) : firstLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));
  return { headers, rows: records, delimiter };
}

export const MISSING_TOKENS = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', '—']);

export type NumberResult = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Parses a count metric. Missing markers return null (absent), never 0.
 * Thousands separators are accepted only in unambiguous grouped form (1,234 / 1.234.567 / 1 234).
 */
export function parseCount(raw: string | undefined): NumberResult {
  const s = (raw ?? '').replace(/[\u00A0\u202F]/g, ' ').trim();
  if (MISSING_TOKENS.has(s.toLowerCase())) return { ok: true, value: null };
  let t = s.replace(/ (?=\d{3}\b)/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, '');
  else if (/^\d{1,3}\.\d{3}$/.test(t)) {
    // "1.234" could be a decimal; counts are integers, so this is read as one thousand two hundred thirty-four
    t = t.replace('.', '');
  } else if (/^\d+,\d+$/.test(t)) return { ok: false, error: `ambiguous number "${s}"` };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: `not a non-negative number: "${s.slice(0, 40)}"` };
  const v = Number(t);
  if (!Number.isFinite(v)) return { ok: false, error: `not a number: "${s.slice(0, 40)}"` };
  return { ok: true, value: v };
}

export type DateOrder = 'auto' | 'MDY' | 'DMY' | 'ISO';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return dt.toISOString();
}

/**
 * Looks at all slash-style dates in a column to decide day/month order. Returns null when no
 * value disambiguates it (every first and second part ≤ 12): the user must then choose.
 */
export function detectDateOrder(values: string[]): 'MDY' | 'DMY' | 'ISO' | null {
  let mdy = false;
  let dmy = false;
  let anySlash = false;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (!m) continue;
    anySlash = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (!anySlash) return 'ISO';
  if (mdy && !dmy) return 'MDY';
  if (dmy && !mdy) return 'DMY';
  return null;
}

/** Parses a timestamp to ISO (UTC as written; exports carry no timezone, which is noted in the import summary). */
export function parseDateTime(raw: string | undefined, order: 'MDY' | 'DMY' | 'ISO'): { ok: true; value: string | null } | { ok: false; error: string } {
  const s = (raw ?? '').trim();
  if (MISSING_TOKENS.has(s.toLowerCase())) return { ok: true, value: null };
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) {
    if (m[7]) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? { ok: false, error: `invalid date "${s}"` } : { ok: true, value: d.toISOString() };
    }
    const v = iso(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return v ? { ok: true, value: v } : { ok: false, error: `invalid date "${s}"` };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m) {
    if (order === 'ISO') return { ok: false, error: `date "${s}" needs a day/month order` };
    const [a, b] = [+m[1]!, +m[2]!];
    const [mo, d] = order === 'MDY' ? [a, b] : [b, a];
    let h = +(m[4] ?? 0);
    if (m[7]) h = (h % 12) + (m[7].toLowerCase() === 'pm' ? 12 : 0);
    const v = iso(+m[3]!, mo, d, h, +(m[5] ?? 0), +(m[6] ?? 0));
    return v ? { ok: true, value: v } : { ok: false, error: `invalid date "${s}"` };
  }
  // "Sun, Oct 5, 2025" / "Oct 05, 2025" / "5 Oct 2025"
  const monthOf = (name: string) => MONTHS[name.toLowerCase().slice(0, 4)] ?? MONTHS[name.toLowerCase().slice(0, 3)];
  m = s.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && monthOf(m[1]!)) {
    const v = iso(+m[3]!, monthOf(m[1]!)!, +m[2]!);
    return v ? { ok: true, value: v } : { ok: false, error: `invalid date "${s}"` };
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m && monthOf(m[2]!)) {
    const v = iso(+m[3]!, monthOf(m[2]!)!, +m[1]!);
    return v ? { ok: true, value: v } : { ok: false, error: `invalid date "${s}"` };
  }
  return { ok: false, error: `unrecognised date "${s.slice(0, 40)}"` };
}

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
