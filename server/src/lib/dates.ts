export type DatePrecision = 'day' | 'month' | 'year' | 'decade' | 'unknown';

export interface ParsedDate {
  date: string | null; // ISO yyyy-mm-dd (first day of the period for coarse precision)
  precision: DatePrecision;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function valid(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Parses dates as sources give them, keeping honest precision. Ambiguous numeric formats such as
 * 03/04/2001 are not guessed: they return unknown precision and the raw value is kept by the caller.
 */
export function parseLooseDate(raw: string | null | undefined): ParsedDate {
  if (!raw) return { date: null, precision: 'unknown' };
  const s = raw.trim().replace(/^(c\.|ca\.|circa|about)\s*/i, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d) ? { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day' } : { date: null, precision: 'unknown' };
  }
  m = s.match(/^(\d{4}):(\d{2}):(\d{2})/); // EXIF style
  if (m && valid(Number(m[1]), Number(m[2]), Number(m[3]))) return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day' };
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { date: `${m[1]}-${m[2]}-01`, precision: 'month' };
  m = s.match(/^(\d{4})$/);
  if (m) return { date: `${m[1]}-01-01`, precision: 'year' };
  m = s.match(/^(\d{3})0s$/);
  if (m) return { date: `${m[1]}0-01-01`, precision: 'decade' };
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/); // March 3, 2001
  if (m) {
    const mo = MONTHS.findIndex((x) => x.startsWith(m![1]!.toLowerCase().slice(0, 3))) + 1;
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mo > 0 && valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day' };
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/); // 3 March 2001
  if (m) {
    const mo = MONTHS.findIndex((x) => x.startsWith(m![2]!.toLowerCase().slice(0, 3))) + 1;
    const d = Number(m[1]);
    const y = Number(m[3]);
    if (mo > 0 && valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day' };
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/); // March 2001
  if (m) {
    const mo = MONTHS.findIndex((x) => x.startsWith(m![1]!.toLowerCase().slice(0, 3))) + 1;
    if (mo > 0) return { date: `${m[2]}-${pad(mo)}-01`, precision: 'month' };
  }
  return { date: null, precision: 'unknown' };
}
