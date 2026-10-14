import yauzl, { type Entry, type ZipFile } from 'yauzl';

/**
 * Reads the posts of an Instagram "Download your information" export (JSON format) and ties each
 * one to a post already imported from the analytics CSV. A tie is made only when the evidence is
 * unambiguous; everything else is reported back unmatched rather than guessed.
 *
 * Export layout (as of 2024–2026): `…/content/posts_1.json` (older exports at the root, newer ones
 * under `your_instagram_activity/`). Each entry is
 *   { media: [{ uri, creation_timestamp, title }], title?, creation_timestamp? }
 * where single-image posts keep the caption and time on the media item and carousels keep them on
 * the post. `uri` is relative to the export root. Meta writes UTF-8 text as Latin-1 escapes.
 */

export interface ExportPost {
  /** index of the post in the export, for reporting */
  key: string;
  caption: string;
  /** seconds since the epoch (UTC), as written by Instagram */
  timestamp: number | null;
  media: { uri: string; position: number }[];
}

export interface CandidatePost {
  id: string;
  caption: string | null;
  /** milliseconds since the epoch */
  publishedAt: number | null;
}

export type MatchResult =
  | { key: string; postId: string; note: string }
  | { key: string; postId: null; reason: string };

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
export const isImageUri = (u: string) => IMAGE_EXT.test(u);
export const isVideoUri = (u: string) => VIDEO_EXT.test(u);

/** Undo Meta's mojibake: UTF-8 bytes written as individual Latin-1 code points. */
export function fixMetaEncoding(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[Â-ô][\u0080-¿]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const decoded = Buffer.from(s, 'latin1').toString('utf8');
  return decoded.includes('�') ? s : decoded;
}

export function normalizeCaption(s: string | null | undefined): string {
  return fixMetaEncoding(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/(…|\.\.\.)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_PREFIX = 30;
function captionsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Some exports cut long captions; accept a long enough prefix.
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

/** Analytics times may be in the account's local time zone, so a caption match tolerates a day's shift. */
const CAPTION_WINDOW_MS = 26 * 3600_000;
/** Without a caption, only an exact-to-the-minute time is trusted. */
const BARE_WINDOW_MS = 120_000;
const CLEARLY_CLOSER_MS = 3600_000;

export function matchExportPosts(exportPosts: ExportPost[], candidates: CandidatePost[]): MatchResult[] {
  const norm = candidates.map((c) => ({ ...c, n: normalizeCaption(c.caption) }));
  const proposals = exportPosts.map((e): MatchResult => {
    const caption = normalizeCaption(e.caption);
    const t = e.timestamp === null ? null : e.timestamp * 1000;
    const dist = (c: CandidatePost) => (t === null || c.publishedAt === null ? null : Math.abs(c.publishedAt - t));
    if (caption) {
      const hits = norm.filter((c) => c.n && captionsMatch(caption, c.n)).filter((c) => {
        const d = dist(c);
        return d === null || d <= CAPTION_WINDOW_MS;
      });
      if (!hits.length) return { key: e.key, postId: null, reason: 'No imported post has this caption around this date.' };
      if (hits.length === 1) return { key: e.key, postId: hits[0]!.id, note: 'Caption and date match.' };
      const timed = hits.filter((c) => dist(c) !== null).sort((a, b) => dist(a)! - dist(b)!);
      if (timed.length >= 2 && dist(timed[0]!)! + CLEARLY_CLOSER_MS < dist(timed[1]!)!) {
        return { key: e.key, postId: timed[0]!.id, note: 'Caption matches several posts; this one was published closest in time.' };
      }
      return { key: e.key, postId: null, reason: `Caption matches ${hits.length} imported posts and the dates do not settle which.` };
    }
    if (t === null) return { key: e.key, postId: null, reason: 'No caption and no date to match on.' };
    const bare = norm.filter((c) => !c.n && dist(c) !== null && dist(c)! <= BARE_WINDOW_MS);
    if (bare.length === 1) return { key: e.key, postId: bare[0]!.id, note: 'No caption; publish time matches to the minute.' };
    return {
      key: e.key, postId: null,
      reason: bare.length ? 'No caption, and several posts were published at that minute.' : 'No caption, and no imported post was published at that exact time.',
    };
  });
  // A post can take the images of only one export entry; contested posts are left unmatched.
  const claims = new Map<string, number>();
  for (const p of proposals) if (p.postId) claims.set(p.postId, (claims.get(p.postId) ?? 0) + 1);
  return proposals.map((p) =>
    p.postId && claims.get(p.postId)! > 1 ? { key: p.key, postId: null, reason: 'Another entry in the export matches the same post.' } : p,
  );
}

const PostsSchemaHint = 'Choose the JSON format (not HTML) when you request the download from Instagram.';

/** Turns the parsed contents of one posts_N.json into export posts. Unknown shapes are rejected. */
export function readPostsJson(data: unknown, fileKey: string): ExportPost[] {
  if (!Array.isArray(data)) throw new Error(`${fileKey} is not a list of posts. ${PostsSchemaHint}`);
  const out: ExportPost[] = [];
  data.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as { media?: unknown; title?: unknown; creation_timestamp?: unknown };
    if (!Array.isArray(p.media) || !p.media.length) return;
    const items = p.media.filter((m): m is { uri: string; title?: unknown; creation_timestamp?: unknown } => !!m && typeof (m as { uri?: unknown }).uri === 'string');
    if (!items.length) return;
    const first = items[0]!;
    const caption = typeof p.title === 'string' && p.title ? p.title : typeof first.title === 'string' ? first.title : '';
    const ts = typeof p.creation_timestamp === 'number' ? p.creation_timestamp : typeof first.creation_timestamp === 'number' ? first.creation_timestamp : null;
    out.push({ key: `${fileKey}#${i + 1}`, caption: fixMetaEncoding(caption), timestamp: ts, media: items.map((m, position) => ({ uri: m.uri, position })) });
  });
  return out;
}

// --- ZIP access -------------------------------------------------------------------------------

export const POSTS_FILE = /(^|\/)posts_\d+\.json$/;
const MAX_JSON_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export class ExportZip {
  private constructor(private zip: ZipFile, readonly entries: Map<string, Entry>) {}

  static open(path: string): Promise<ExportZip> {
    return new Promise((resolve, reject) => {
      yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (err, zip) => {
        if (err || !zip) return reject(new Error('This file is not a readable ZIP archive.'));
        const entries = new Map<string, Entry>();
        zip.on('entry', (e: Entry) => {
          if (!e.fileName.endsWith('/')) entries.set(e.fileName, e);
          if (entries.size > 200_000) {
            zip.close();
            return reject(new Error('The archive has too many files.'));
          }
          zip.readEntry();
        });
        zip.on('end', () => resolve(new ExportZip(zip, entries)));
        zip.on('error', () => reject(new Error('The ZIP archive is damaged.')));
        zip.readEntry();
      });
    });
  }

  /** Finds the file an export `uri` points to, wherever the export root sits inside the archive. */
  find(uri: string): Entry | undefined {
    const clean = uri.replace(/^\/+/, '');
    if (clean.split('/').includes('..')) return undefined;
    for (const prefix of this.prefixes) {
      const e = this.entries.get(prefix + clean);
      if (e) return e;
    }
    // First time a uri lives under an unknown folder: scan once and remember that folder.
    for (const [name, e] of this.entries) {
      if (name.endsWith(`/${clean}`)) {
        this.prefixes.push(name.slice(0, name.length - clean.length));
        return e;
      }
    }
    return undefined;
  }

  private prefixes: string[] = [''];

  read(entry: Entry, maxBytes: number): Promise<Buffer> {
    if (entry.uncompressedSize > maxBytes) return Promise.reject(new Error('too large'));
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('unreadable'));
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            stream.destroy();
            reject(new Error('too large'));
          } else chunks.push(c);
        });
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  async posts(): Promise<{ posts: ExportPost[]; files: string[] }> {
    const files = [...this.entries.keys()].filter((n) => POSTS_FILE.test(n) && !/__MACOSX/.test(n)).sort();
    const posts: ExportPost[] = [];
    for (const name of files) {
      let data: unknown;
      try {
        data = JSON.parse((await this.read(this.entries.get(name)!, MAX_JSON_BYTES)).toString('utf8'));
      } catch {
        throw new Error(`${name} could not be read as JSON. ${PostsSchemaHint}`);
      }
      posts.push(...readPostsJson(data, name.split('/').pop()!));
    }
    return { posts, files };
  }

  close(): void {
    this.zip.close();
  }
}

export const NO_POSTS_FILE = `No posts_1.json found in the archive. Request "Your Instagram activity → Content" (or "Posts") from Instagram's Download your information, in JSON format, and upload the ZIP as it arrives.`;
