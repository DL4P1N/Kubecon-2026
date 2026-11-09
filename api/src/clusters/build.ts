import { MIN_CLUSTER_SIZE } from "@cc/shared";
import { kmeans } from "./kmeans.js";

/** Never ask k-means for more clusters than this; a map with more bubbles is unreadable. */
export const DEFAULT_MAX_K = 8;
export const OTHER_ID = "other";
const MAX_TOP_INTERESTS = 5;
const MAX_LABEL_INTERESTS = 2;

export interface ClusterInput {
  interests: string[];
  vector: number[];
}

export interface ClusterOutput {
  /** "c1", "c2", ... in descending size order, or "other". */
  clusterId: string;
  label: string;
  size: number;
  topInterests: string[];
  /** Mean vector of the members; absent for the "other" bucket (not a coherent group). */
  centroid?: number[];
  other: boolean;
}

export interface ClusterRun {
  /** Every cluster here has at least `minSize` members. */
  clusters: ClusterOutput[];
  /** Attendees whose group was below the minimum and could not even form a large-enough "other". */
  suppressed: number;
  /** Input attendees (all opted in). */
  attendees: number;
  /** k requested from k-means (0 when there were too few attendees to cluster). */
  k: number;
}

export interface BuildOptions {
  minSize?: number;
  maxK?: number;
  seed?: number;
}

/**
 * k by population: about sqrt(n/2), capped at maxK, and never more than
 * floor(n / minSize) so the average cluster can reach the minimum size.
 */
export function chooseK(n: number, minSize = MIN_CLUSTER_SIZE, maxK = DEFAULT_MAX_K): number {
  if (n < minSize) return 0;
  const byRule = Math.round(Math.sqrt(n / 2));
  return Math.max(1, Math.min(byRule, maxK, Math.floor(n / minSize)));
}

function titleCase(interest: string): string {
  return interest.replace(/(^|[\s-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Top interests of a group. An interest is only reported when at least
 * `minSize` members share it, so labels cannot expose something only one or two
 * attendees typed (free-form text could be identifying).
 */
export function topInterests(members: ClusterInput[], minSize = MIN_CLUSTER_SIZE): string[] {
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const i of new Set(m.interests)) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minSize)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOP_INTERESTS)
    .map(([i]) => i);
}

export function labelFor(interests: string[]): string {
  return interests.length === 0 ? "Mixed interests" : interests.slice(0, MAX_LABEL_INTERESTS).map(titleCase).join(" + ");
}

function mean(vectors: number[][]): number[] {
  const out = new Array<number>(vectors[0]!.length).fill(0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  return out.map((x) => x / vectors.length);
}

/**
 * Cluster opted-in attendees and apply k-anonymity:
 *  1. k-means over the interest vectors (k from chooseK).
 *  2. Clusters with fewer than minSize members are pooled into "other".
 *  3. "other" is shown only if the pool itself has at least minSize members;
 *     otherwise those attendees are counted as suppressed and not shown.
 *  4. A final guard drops anything under minSize, so no code path above can
 *     leak a small cluster.
 */
export function buildClusters(inputs: ClusterInput[], opts: BuildOptions = {}): ClusterRun {
  const minSize = opts.minSize ?? MIN_CLUSTER_SIZE;
  const k = chooseK(inputs.length, minSize, opts.maxK);
  if (k === 0) return { clusters: [], suppressed: inputs.length, attendees: inputs.length, k: 0 };

  const { assignments } = kmeans(inputs.map((i) => i.vector), k, { seed: opts.seed });
  const groups: ClusterInput[][] = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => groups[c]!.push(inputs[i]!));

  const kept: { members: ClusterInput[]; centroid: number[] }[] = [];
  const pooled: ClusterInput[] = [];
  groups.forEach((members) => {
    if (members.length >= minSize) kept.push({ members, centroid: mean(members.map((m) => m.vector)) });
    else pooled.push(...members);
  });
  kept.sort((a, b) => b.members.length - a.members.length);

  const clusters: ClusterOutput[] = kept.map(({ members, centroid }, idx) => {
    const top = topInterests(members, minSize);
    return { clusterId: `c${idx + 1}`, label: labelFor(top), size: members.length, topInterests: top, centroid, other: false };
  });

  let suppressed = 0;
  if (pooled.length >= minSize) {
    const top = topInterests(pooled, minSize);
    clusters.push({ clusterId: OTHER_ID, label: "Other", size: pooled.length, topInterests: top, other: true });
  } else {
    suppressed = pooled.length;
  }

  return finalize({ clusters, suppressed, attendees: inputs.length, k }, minSize);
}

/** Last line of defence: removes any cluster under minSize and counts its members as suppressed. */
export function finalize(run: ClusterRun, minSize = MIN_CLUSTER_SIZE): ClusterRun {
  const shown = run.clusters.filter((c) => c.size >= minSize);
  const dropped = run.clusters.filter((c) => c.size < minSize).reduce((s, c) => s + c.size, 0);
  return { ...run, clusters: shown, suppressed: run.suppressed + dropped };
}
