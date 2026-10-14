import { cosine } from '../../lib/embedding.js';
import type { Diversity } from './config.js';

export interface DiversifiableItem {
  id: string;
  score: number;
  creator: string | null;
  source: string;
  tags: string[];
  embedding: number[] | null;
}

export interface DiversifiedItem<T> {
  item: T;
  adjusted: number;
  redundancy: { label: string; amount: number }[];
}

/**
 * Greedy re-ranking: at each step choose the item whose score, minus penalties for repeating
 * creators, sources, tags and near-identical content within the recent window, is highest.
 * Penalties are bounded, so a strong item is pushed down a few places rather than hidden.
 */
export function diversify<T extends DiversifiableItem>(items: T[], cfg: Diversity): DiversifiedItem<T>[] {
  const remaining = [...items].sort((a, b) => b.score - a.score);
  const out: DiversifiedItem<T>[] = [];
  // Only the head of the list needs careful ordering; beyond it, plain score order is fine.
  const HEAD = Math.min(remaining.length, 300);
  while (out.length < HEAD && remaining.length) {
    const recent = out.slice(-cfg.window).map((o) => o.item);
    let bestIdx = 0;
    let best: DiversifiedItem<T> | null = null;
    // Looking further than ~40 candidates ahead gives no practical benefit.
    for (let i = 0; i < Math.min(remaining.length, 40); i++) {
      const it = remaining[i]!;
      const red: { label: string; amount: number }[] = [];
      if (it.creator) {
        const n = recent.filter((r) => r.creator && r.creator.toLowerCase() === it.creator!.toLowerCase()).length;
        if (n) red.push({ label: `Same creator shown ${n}× recently`, amount: Math.min(0.5, cfg.creator_penalty * n) });
      }
      const ns = recent.filter((r) => r.source === it.source).length;
      if (ns > cfg.window / 2) red.push({ label: 'Source over-represented recently', amount: cfg.source_penalty * (ns - cfg.window / 2) });
      if (it.tags.length) {
        const tags = new Set(it.tags);
        const overlap = recent.reduce((acc, r) => acc + r.tags.filter((t) => tags.has(t)).length / Math.max(1, tags.size), 0);
        if (overlap >= 1) red.push({ label: 'Tags repeat recent items', amount: Math.min(0.3, cfg.tag_overlap_penalty * overlap) });
      }
      if (it.embedding) {
        const near = recent.some((r) => r.embedding && cosine(r.embedding, it.embedding) >= 0.85);
        if (near) red.push({ label: 'Near-identical to a recent item', amount: cfg.near_duplicate_penalty });
      }
      const adjusted = it.score - red.reduce((a, r) => a + r.amount, 0);
      if (!best || adjusted > best.adjusted) {
        best = { item: it, adjusted, redundancy: red };
        bestIdx = i;
      }
    }
    out.push(best!);
    remaining.splice(bestIdx, 1);
  }
  for (const it of remaining) out.push({ item: it, adjusted: it.score, redundancy: [] });
  return out;
}
