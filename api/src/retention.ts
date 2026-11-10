import type { EsClient } from "./es/client.js";
import { withSpan } from "./telemetry/span.js";
import { logs, SeverityNumber } from "@opentelemetry/api";
import { retentionMsFromEnv } from "./retentionPolicy.js";

export const RETENTION_INDICES = ["attendees", "schedules", "entitlements"] as const;

/**
 * `retentionMs` is the attendee retention in ms (ATTENDEE_RETENTION_HOURS * 3600000), positive, or
 * null when retention is off: then only already-expired documents match (kept profiles carry the
 * far-future sentinel expiry, so they are untouched).
 */
export function retentionQuery(now: Date, retentionMs: number | null) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid retention clock");
  if (retentionMs === null) return { query: { bool: { minimum_should_match: 1, should: [
    { range: { expires_at: { lte: now.toISOString() } } },
  ] } } };
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("Invalid retention period");
  return { query: { bool: { minimum_should_match: 1, should: [
    { range: { created_at: { lt: new Date(now.getTime() - retentionMs).toISOString() } } },
    { range: { expires_at: { lte: now.toISOString() } } },
  ] } } };
}

export const RETENTION_OFF_MESSAGE = "Retention is off (ATTENDEE_RETENTION_HOURS unset or 0): attendee profiles are kept, only already-expired documents are deleted";

/**
 * Fixed clock for the whole run; only the three attendee-data aliases are targeted.
 * `retentionMs` defaults to ATTENDEE_RETENTION_HOURS; null means retention is off, in which case
 * only documents whose `expires_at` has already passed are deleted (e.g. left over from the old 24 h policy).
 */
export async function runRetention(
  es: EsClient,
  now = new Date(),
  retentionMs: number | null = retentionMsFromEnv(),
): Promise<number> {
  if (retentionMs === null) console.log(RETENTION_OFF_MESSAGE);
  const query = retentionQuery(now, retentionMs);
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
    logs.getLogger("companion-retention").emit({
      severityNumber: incomplete ? SeverityNumber.ERROR : SeverityNumber.INFO,
      body: "Retention cleanup",
      attributes: { "retention.deleted": deleted },
    });
    if (incomplete) throw new Error("Retention cleanup incomplete");
    return deleted;
  });
}
