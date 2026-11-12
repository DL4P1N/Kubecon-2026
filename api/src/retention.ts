import type { Db } from "./db/client.js";
import { withSpan } from "./telemetry/span.js";
import { logs, SeverityNumber } from "@opentelemetry/api";
import { retentionMsFromEnv } from "./retentionPolicy.js";

/** Tables holding attendee data; each carries `expires_at`. Static identifiers, never user input. */
export const RETENTION_TABLES = ["attendees", "schedules", "entitlements", "identities"] as const;

export const RETENTION_OFF_MESSAGE = "Retention is off (ATTENDEE_RETENTION_HOURS unset or 0): attendee profiles are kept, only already-expired rows are deleted";

/**
 * Fixed clock for the whole run; only the attendee-data tables are targeted.
 * `retentionMs` defaults to ATTENDEE_RETENTION_HOURS; null means retention is off, in which case
 * only rows whose `expires_at` has already passed are deleted (kept profiles carry the far-future sentinel).
 * With a positive period, `attendees` and `identities` are also deleted once older than the period by `created_at`.
 */
export async function runRetention(
  db: Db,
  now = new Date(),
  retentionMs: number | null = retentionMsFromEnv(),
): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid retention clock");
  if (retentionMs !== null && (!Number.isFinite(retentionMs) || retentionMs <= 0)) throw new Error("Invalid retention period");
  if (retentionMs === null) console.log(RETENTION_OFF_MESSAGE);
  const cutoff = retentionMs === null ? null : new Date(now.getTime() - retentionMs);
  return withSpan("retention.run", {}, async (span) => {
    let deleted = 0;
    let incomplete = false;
    for (const table of RETENTION_TABLES) {
      try {
        const byAge = cutoff !== null && (table === "attendees" || table === "identities");
        const r = byAge
          ? await db.query(`delete from ${table} where expires_at <= $1 or created_at < $2`, [now, cutoff])
          : await db.query(`delete from ${table} where expires_at <= $1`, [now]);
        deleted += r.rowCount;
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
