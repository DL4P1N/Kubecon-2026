/**
 * In-process mirror of docs/telemetry-allowlist.md and the collector's
 * `transform/allowlist` processor (deploy/k8s/otel-collector/configmap.yaml,
 * deploy/compose/otel-config.yaml). Keep all four in sync.
 *
 * The collector is the enforcement point; these constants let our own code
 * (withSpan, metrics) drop unreviewed keys before they ever leave the process.
 * Never add identifiers (attendee.id), locations, tokens, or free text.
 */
export const RESOURCE_ATTRIBUTE_ALLOWLIST = [
  "service.name",
  "service.version",
  "service.namespace",
  "deployment.environment",
] as const;

export const SPAN_ATTRIBUTE_ALLOWLIST = [
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "url.path",
  "server.address",
  "server.port",
  "rpc.system",
  "rpc.service",
  "rpc.method",
  "db.system",
  "db.operation.name",
  "db.namespace",
  "room.id",
  "access.decision",
  "search.mode",
  "search.hits",
  "error.type",
  "retention.deleted",
] as const;

export const LOG_ATTRIBUTE_ALLOWLIST = [
  "log.severity",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "url.path",
  "room.id",
  "access.decision",
  "search.mode",
  "search.hits",
  "error.type",
  "retention.deleted",
] as const;

export const METRIC_ATTRIBUTE_ALLOWLIST = [
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "url.path",
  "room.id",
  "access.decision",
  "search.mode",
] as const;

export type SpanAttributeKey = (typeof SPAN_ATTRIBUTE_ALLOWLIST)[number];
export type MetricAttributeKey = (typeof METRIC_ATTRIBUTE_ALLOWLIST)[number];

type AttrValue = string | number | boolean;

/** Returns a copy of `attrs` containing only keys in `allowlist` with defined primitive values. */
export function pickAllowed(
  attrs: Record<string, unknown> | undefined,
  allowlist: readonly string[],
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (!attrs) return out;
  for (const [key, value] of Object.entries(attrs)) {
    if (!allowlist.includes(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
