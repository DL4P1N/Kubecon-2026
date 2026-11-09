export interface Fingerprint { room: string; signals: number[] }

/** 1-nearest-neighbor Euclidean distance on synthetic AP vectors only. */
export function estimateRoom(signals: number[], fingerprints: Fingerprint[]): string | null {
  if (signals.length === 0 || !signals.every(Number.isFinite)) return null;
  let nearest: string | null = null;
  let distance = Infinity;
  for (const fingerprint of fingerprints) {
    if (!fingerprint.room || fingerprint.signals.length !== signals.length || !fingerprint.signals.every(Number.isFinite)) continue;
    const squared = signals.reduce((sum, signal, i) => sum + (signal - fingerprint.signals[i]!) ** 2, 0);
    // Stable tie breaking: the first fingerprint wins.
    if (squared < distance) { distance = squared; nearest = fingerprint.room; }
  }
  return nearest;
}
