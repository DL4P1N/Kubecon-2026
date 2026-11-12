/**
 * Plain k-means (Lloyd's algorithm) with k-means++ seeding, in Node.
 * This runs in the batch job process, NOT inside the database: Postgres only stores
 * the input vectors and the resulting cluster rows.
 *
 * Deterministic for a given seed so runs and tests are reproducible.
 */

export interface KMeansOptions {
  seed?: number;
  maxIterations?: number;
  /** Independent k-means++ starts; the lowest-inertia result wins. */
  restarts?: number;
}

export interface KMeansResult {
  /** Cluster index (0..k-1) for each input point. */
  assignments: number[];
  centroids: number[][];
  iterations: number;
  /** False only when maxIterations was hit before assignments stopped changing. */
  converged: boolean;
  /** Sum of squared distances from each point to its centroid. */
  inertia: number;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sqDist(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - b[i]!;
    d += x * x;
  }
  return d;
}

function nearest(point: number[], centroids: number[][]): { index: number; dist: number } {
  let index = 0;
  let dist = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = sqDist(point, centroids[c]!);
    if (d < dist) {
      dist = d;
      index = c;
    }
  }
  return { index, dist };
}

function seedCentroids(points: number[][], k: number, rand: () => number): number[][] {
  const centroids: number[][] = [points[Math.floor(rand() * points.length)]!.slice()];
  const dists = points.map((p) => sqDist(p, centroids[0]!));
  while (centroids.length < k) {
    const total = dists.reduce((s, d) => s + d, 0);
    let pick = 0;
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < dists.length; i++) {
        r -= dists[i]!;
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    } else {
      pick = Math.floor(rand() * points.length); // all remaining points coincide with a centroid
    }
    const chosen = points[pick]!.slice();
    centroids.push(chosen);
    for (let i = 0; i < points.length; i++) dists[i] = Math.min(dists[i]!, sqDist(points[i]!, chosen));
  }
  return centroids;
}

function runOnce(points: number[][], k: number, rand: () => number, maxIterations: number): KMeansResult {
  const dims = points[0]!.length;
  let centroids = seedCentroids(points, k, rand);
  const assignments = new Array<number>(points.length).fill(-1);
  let iterations = 0;
  let converged = false;

  while (iterations < maxIterations) {
    iterations++;
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      const { index } = nearest(points[i]!, centroids);
      if (assignments[i] !== index) {
        assignments[i] = index;
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
    const sums = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      const c = assignments[i]!;
      counts[c]!++;
      const p = points[i]!;
      const s = sums[c]!;
      for (let d = 0; d < dims; d++) s[d]! += p[d]!;
    }
    centroids = sums.map((s, c) => (counts[c]! > 0 ? s.map((v) => v / counts[c]!) : centroids[c]!));
    // Re-seed any empty cluster at the point farthest from its centroid.
    for (let c = 0; c < k; c++) {
      if (counts[c]! > 0) continue;
      let far = 0;
      let farDist = -1;
      for (let i = 0; i < points.length; i++) {
        const d = sqDist(points[i]!, centroids[assignments[i]!]!);
        if (d > farDist) {
          farDist = d;
          far = i;
        }
      }
      centroids[c] = points[far]!.slice();
    }
  }

  let inertia = 0;
  for (let i = 0; i < points.length; i++) inertia += sqDist(points[i]!, centroids[assignments[i]!]!);
  return { assignments, centroids, iterations, converged, inertia };
}

export function kmeans(points: number[][], k: number, opts: KMeansOptions = {}): KMeansResult {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  if (points.length === 0) throw new Error("kmeans needs at least one point");
  if (k > points.length) throw new Error("k cannot exceed the number of points");
  const dims = points[0]!.length;
  if (points.some((p) => p.length !== dims)) throw new Error("all points must have the same dimension");

  const { seed = 1, maxIterations = 100, restarts = 5 } = opts;
  const rand = seededRandom(seed);
  let best: KMeansResult | undefined;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    const result = runOnce(points, k, rand, maxIterations);
    if (!best || result.inertia < best.inertia - 1e-12) best = result;
  }
  return best!;
}
