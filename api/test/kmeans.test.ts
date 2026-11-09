import { describe, expect, it } from "vitest";
import { kmeans, seededRandom } from "../src/clusters/kmeans.js";

/** Three well separated 2-D blobs of `per` points each. */
function blobs(per: number, seed = 7): { points: number[][]; truth: number[] } {
  const rand = seededRandom(seed);
  const centers = [
    [0, 0],
    [10, 10],
    [-10, 10],
  ];
  const points: number[][] = [];
  const truth: number[] = [];
  centers.forEach((c, i) => {
    for (let n = 0; n < per; n++) {
      points.push([c[0]! + (rand() - 0.5), c[1]! + (rand() - 0.5)]);
      truth.push(i);
    }
  });
  return { points, truth };
}

describe("kmeans", () => {
  it("converges and recovers well separated clusters", () => {
    const { points, truth } = blobs(20);
    const r = kmeans(points, 3, { seed: 3 });
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThan(20);
    // Every true blob maps to exactly one cluster, and different blobs to different clusters.
    const mapped = [0, 1, 2].map((t) => new Set(r.assignments.filter((_, i) => truth[i] === t)));
    mapped.forEach((s) => expect(s.size).toBe(1));
    expect(new Set(mapped.map((s) => [...s][0])).size).toBe(3);
    // Each centroid sits near a blob centre.
    for (const c of r.centroids) {
      const near = [[0, 0], [10, 10], [-10, 10]].some(([x, y]) => Math.hypot(c[0]! - x!, c[1]! - y!) < 1);
      expect(near).toBe(true);
    }
  });

  it("does not increase inertia when given more clusters", () => {
    const { points } = blobs(15);
    const k1 = kmeans(points, 1).inertia;
    const k3 = kmeans(points, 3).inertia;
    const k6 = kmeans(points, 6).inertia;
    expect(k3).toBeLessThan(k1);
    expect(k6).toBeLessThanOrEqual(k3 + 1e-9);
  });

  it("is deterministic for a given seed", () => {
    const { points } = blobs(10);
    expect(kmeans(points, 3, { seed: 42 })).toEqual(kmeans(points, 3, { seed: 42 }));
  });

  it("reports non-convergence when capped, and handles identical points", () => {
    const { points } = blobs(10);
    expect(kmeans(points, 3, { maxIterations: 1, restarts: 1 }).converged).toBe(false);
    const same = Array.from({ length: 6 }, () => [1, 2, 3]);
    const r = kmeans(same, 3);
    expect(r.assignments).toHaveLength(6);
    expect(r.inertia).toBe(0);
  });

  it("rejects invalid input", () => {
    expect(() => kmeans([], 1)).toThrow();
    expect(() => kmeans([[1]], 0)).toThrow();
    expect(() => kmeans([[1]], 2)).toThrow();
    expect(() => kmeans([[1], [1, 2]], 1)).toThrow();
  });
});
