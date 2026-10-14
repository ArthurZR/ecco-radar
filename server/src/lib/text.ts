const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have in into is it its of on or that the this to was were ' +
    'with will not no so if then than too very can just via our we you your they their them he she his her ' +
    'i me my mine who what which when where why how all any each more most other some such only own same ' +
    'about after again against also am been before being below between both did do does doing down during ' +
    'few further here once out over under until up while http https www com html jpg png file').split(' '),
);

/** Lowercased word tokens (unicode letters/digits), stopwords removed. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []
  ).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d{1,2}$/.test(t));
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.slice(1).toLowerCase()))];
}

export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(/@[A-Za-z0-9_.]{2,30}/g) ?? []).map((h) => h.slice(1).toLowerCase().replace(/\.$/, '')))];
}

/** Years mentioned in text (1850–2039), used as weak period evidence. */
export function extractYears(text: string | null | undefined): number[] {
  if (!text) return [];
  return [...new Set((text.match(/\b(18[5-9]\d|19\d\d|20[0-3]\d)\b/g) ?? []).map(Number))];
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
