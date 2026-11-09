import { metrics, type Counter, type Histogram } from "@opentelemetry/api";
import { METRIC_ATTRIBUTE_ALLOWLIST, pickAllowed } from "./allowlist.js";

/**
 * Application metrics. HTTP request duration by route + status comes for free
 * from @opentelemetry/instrumentation-http as `http.server.request.duration`
 * (attributes http.request.method, http.route, http.response.status_code).
 *
 * Instruments are created lazily so they bind to the MeterProvider registered
 * by instrument.ts; when the SDK is not started they are no-ops.
 */
const METER_NAME = "companion-api";

/** Histogram boundaries in seconds (OTel HTTP semconv advice). 0.5 is the SLO threshold. */
export const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

let searchDuration: Histogram | undefined;
let accessScans: Counter | undefined;

function meter() {
  return metrics.getMeter(METER_NAME);
}

/** Search latency in seconds, by search.mode (hybrid | keyword). */
export function recordSearchLatency(seconds: number, mode: string): void {
  searchDuration ??= meter().createHistogram("companion.search.duration", {
    description: "Search request latency (API side, including Elasticsearch)",
    unit: "s",
    // Same boundaries as http.server.request.duration. The SDK default
    // (0, 5, 10, ... 10000) is meant for milliseconds and would put every
    // search into the 0-5 s bucket, making p95 and the 500 ms SLO meaningless.
    advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
  });
  searchDuration.record(seconds, pickAllowed({ "search.mode": mode }, METRIC_ATTRIBUTE_ALLOWLIST));
}

/**
 * Counts room access scans. Exported over OTLP as `access.scans`; Prometheus-
 * style backends (Dash0 PromQL) show it as `access_scans_total{access_decision,room_id}`.
 */
export function recordAccessScan(decision: "allow" | "deny" | string, room: string): void {
  accessScans ??= meter().createCounter("access.scans", {
    description: "Room access scans by decision and room",
  });
  accessScans.add(1, pickAllowed({ "access.decision": decision, "room.id": room }, METRIC_ATTRIBUTE_ALLOWLIST));
}

/** Convenience: times an async search call and records its latency. */
export async function timeSearch<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordSearchLatency((performance.now() - start) / 1000, mode);
  }
}

/** For tests: forget cached instruments so they rebind to a new MeterProvider. */
export function resetMetricsForTest(): void {
  searchDuration = undefined;
  accessScans = undefined;
}
