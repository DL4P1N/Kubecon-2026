import type { HybridState, SearchLatencyStat } from "@cc/shared";

/**
 * In-process rolling counters behind GET /api/status. Counts and timings only:
 * no query text, attendee ids or locations are ever stored. State is per API
 * replica and resets on restart, which the status page says.
 */
export type SearchOutcome = "ok" | "overloaded" | "error";

export const WINDOW_SECONDS = 300;
/** Hybrid is reported as warming up for this long after its latest overload or error. */
export const HYBRID_RECOVERY_SECONDS = 60;
const MAX_SAMPLES = 1000;

interface SearchSample {
  at: number;
  ms: number;
  outcome: SearchOutcome;
}
interface RequestSample {
  at: number;
  serverError: boolean;
}

export interface StatusTracker {
  recordSearch(mode: "keyword" | "hybrid", ms: number, outcome: SearchOutcome): void;
  recordRequest(statusCode: number): void;
  searchStat(mode: "keyword" | "hybrid"): SearchLatencyStat;
  hybridState(): HybridState;
  errorRate(): { requests: number; serverErrors: number; ratio: number };
}

/** Nearest-rank percentile of an unsorted list (returns null for an empty list). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function createStatusTracker(now: () => number = Date.now): StatusTracker {
  const search: Record<"keyword" | "hybrid", SearchSample[]> = { keyword: [], hybrid: [] };
  let requests: RequestSample[] = [];
  let lastHybrid: { at: number; outcome: SearchOutcome } | undefined;

  const cutoff = () => now() - WINDOW_SECONDS * 1000;
  const trim = <T extends { at: number }>(list: T[]): T[] => {
    const c = cutoff();
    const kept = list.filter((x) => x.at >= c);
    return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept;
  };

  return {
    recordSearch(mode, ms, outcome) {
      const at = now();
      search[mode] = trim([...search[mode], { at, ms, outcome }]);
      if (mode === "hybrid") lastHybrid = { at, outcome };
    },
    recordRequest(statusCode) {
      requests = trim([...requests, { at: now(), serverError: statusCode >= 500 }]);
    },
    searchStat(mode) {
      // Latency of successful searches only; failures are reflected in hybridState and errorRate.
      const ok = trim(search[mode]).filter((s) => s.outcome === "ok").map((s) => s.ms);
      const p = percentile(ok, 95);
      return { samples: ok.length, p95Ms: p === null ? null : Math.round(p) };
    },
    hybridState() {
      if (!lastHybrid) return "unknown";
      if (lastHybrid.outcome === "ok") return "ready";
      return now() - lastHybrid.at <= HYBRID_RECOVERY_SECONDS * 1000 ? "warming_up" : "unknown";
    },
    errorRate() {
      const live = trim(requests);
      const serverErrors = live.filter((r) => r.serverError).length;
      return { requests: live.length, serverErrors, ratio: live.length === 0 ? 0 : serverErrors / live.length };
    },
  };
}
