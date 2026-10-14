import { tokenize } from './text.js';

/**
 * Local text embedding: feature-hashed unigrams + bigrams with sublinear term frequency.
 * This is a lexical representation, not a neural model. It needs no external service and sends
 * no data anywhere. It captures shared vocabulary, not deeper meaning, and the UI labels it so.
 * A neural embedding provider can replace it through the EmbeddingProvider interface.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): number[];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class HashingEmbedding implements EmbeddingProvider {
  readonly model = 'lexical-hash-v1';
  constructor(readonly dimensions = 384) {}

  embed(text: string): number[] {
    const tokens = tokenize(text);
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      counts.set(t, (counts.get(t) ?? 0) + 1);
      // crude stem so "websites" and "website" share a feature
      if (t.length > 4 && t.endsWith('s')) counts.set(t.slice(0, -1), (counts.get(t.slice(0, -1)) ?? 0) + 0.5);
      if (i + 1 < tokens.length) {
        const bg = `${t}_${tokens[i + 1]}`;
        counts.set(bg, (counts.get(bg) ?? 0) + 0.7);
      }
    }
    const v = new Array<number>(this.dimensions).fill(0);
    for (const [feature, c] of counts) {
      const h = fnv1a(feature);
      const idx = h % this.dimensions;
      const sign = (h >>> 31) & 1 ? -1 : 1; // signed hashing reduces collision bias
      v[idx]! += sign * (1 + Math.log(c));
    }
    return normalize(v);
  }
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

export function cosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const c = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) c[i]! += v[i]!;
  return normalize(c);
}

export const textEmbedder: EmbeddingProvider = new HashingEmbedding();

export function referenceEmbeddingText(r: {
  title?: string | null;
  description?: string | null;
  creator_name?: string | null;
  tags?: string[];
}): string {
  return [r.title, r.creator_name, (r.tags ?? []).join(' '), r.description?.slice(0, 2000)].filter(Boolean).join('\n');
}
