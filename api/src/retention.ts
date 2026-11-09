import type { EsClient } from "./es/client.js";
import { withSpan } from "./telemetry/span.js";

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const RETENTION_INDICES = ["attendees", "schedules", "entitlements"] as const;

export function retentionQuery(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid retention clock");
  return { query: { bool: { minimum_should_match: 1, should: [
    { range: { created_at: { lt: new Date(now.getTime() - RETENTION_MS).toISOString() } } },
    { range: { expires_at: { lte: now.toISOString() } } },
  ] } } };
}

/** Fixed clock for the whole run; only the three attendee-data aliases are targeted. */
export async function runRetention(es: EsClient, now = new Date()): Promise<number> {
  const query = retentionQuery(now);
  return withSpan("retention.run", {}, async (span) => {
    let deleted = 0;
    let incomplete = false;
    for (const index of RETENTION_INDICES) {
      try {
        const { body } = await es.request<{ deleted: number; failures?: unknown[]; timed_out?: boolean; version_conflicts?: number }>(
          "POST", `/${index}/_delete_by_query?refresh=true&conflicts=proceed`, query,
        );
        if (body.timed_out || body.failures?.length || body.version_conflicts || !Number.isFinite(body.deleted) || body.deleted < 0) {
          incomplete = true;
        }
        if (Number.isFinite(body.deleted) && body.deleted > 0) deleted += body.deleted;
      } catch {
        incomplete = true;
      }
    }
    span.setAttribute("retention.deleted", deleted);
    if (incomplete) throw new Error("Retention cleanup incomplete");
    return deleted;
  });
}
