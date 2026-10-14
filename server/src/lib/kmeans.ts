import { cosine, normalize } from './embedding.js';

/** Small deterministic PRNG so the same archive always clusters the same way. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KMeansResult {
  /** Cluster index for each input vector. */
  assignment: number[];
  /** Unit-length centroids. */
  centroids: number[][];
}

/**
 * Spherical k-means (cosine similarity) with k-means++ seeding. Vectors are compared by direction,
 * which suits both the lexical text vectors and the colour/tone vectors. Deterministic for a given
 * input order and seed. Empty clusters are re-seeded from the point furthest from its centroid.
 */
export function sphericalKMeans(vectors: number[][], k: number, opts: { seed?: number; maxIterations?: number } = {}): KMeansResult {
  const n = vectors.length;
  if (n === 0) return { assignment: [], centroids: [] };
  k = Math.max(1, Math.min(k, n));
  const rand = mulberry32(opts.seed ?? 1);
  const maxIterations = opts.maxIterations ?? 25;
  const units = vectors.map((v) => normalize([...v]));

  // k-means++: each new centroid is drawn with probability proportional to its distance (1 - cos).
  const centroids: number[][] = [units[Math.floor(rand() * n)]!];
  const dist = units.map((u) => 1 - cosine(u, centroids[0]));
  while (centroids.length < k) {
    const total = dist.reduce((s, d) => s + Math.max(d, 0), 0);
    let pick: number;
    if (total > 0) {
      let r = rand() * total;
      for (pick = 0; pick < n - 1; pick++) {
        r -= Math.max(dist[pick]!, 0);
        if (r <= 0) break;
      }
    } else pick = Math.floor(rand() * n);
    const c = units[pick]!;
    centroids.push(c);
    for (let i = 0; i < n; i++) dist[i] = Math.min(dist[i]!, 1 - cosine(units[i], c));
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let j = 0; j < centroids.length; j++) {
        const s = cosine(units[i], centroids[j]);
        if (s > bestSim) { bestSim = s; best = j; }
      }
      if (assignment[i] !== best) { assignment[i] = best; changed = true; }
    }
    const dim = units[0]!.length;
    const sums = centroids.map(() => new Array<number>(dim).fill(0));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const a = assignment[i]!;
      counts[a]!++;
      const u = units[i]!;
      const s = sums[a]!;
      for (let d = 0; d < dim; d++) s[d]! += u[d]!;
    }
    for (let j = 0; j < centroids.length; j++) {
      if (counts[j] === 0) {
        // Re-seed an empty cluster with the worst-fitting point.
        let worst = 0;
        let worstSim = Infinity;
        for (let i = 0; i < n; i++) {
          const s = cosine(units[i], centroids[assignment[i]!]);
          if (s < worstSim) { worstSim = s; worst = i; }
        }
        centroids[j] = units[worst]!;
        assignment[worst] = j;
        changed = true;
      } else centroids[j] = normalize(sums[j]!);
    }
    if (!changed) break;
  }
  return { assignment, centroids };
}

/** A modest number of groups for browsing: about sqrt(n / 2), between 2 and 12. */
export function suggestedK(n: number): number {
  return Math.max(2, Math.min(12, Math.round(Math.sqrt(n / 2))));
}
