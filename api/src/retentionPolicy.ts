/**
 * Attendee-data retention policy (docs/retention.md).
 *
 * ATTENDEE_RETENTION_HOURS: integer >= 0. Unset or 0 (the default) keeps attendee profiles
 * indefinitely; a positive value restores timed deletion (e.g. 24). Door tokens, session tokens,
 * scan logs and room-activity windows are short-lived regardless of this setting.
 */

/** `expires_at` written when retention is off. Far future, so every fail-closed expiry check
 * (access.ts, aggregate and cluster filters) keeps working unchanged and a missing expiry still
 * means "hand-edited, deny". The retention job never matches it on `expires_at`. */
export const NO_EXPIRY = "9999-12-31T23:59:59.999Z";

const HOUR_MS = 60 * 60 * 1000;
/** Keep the resulting timestamp inside Date's range: ~100 years. */
const MAX_HOURS = 24 * 365 * 100;

/** Parses the raw env value to whole hours. Throws on anything but an integer >= 0. */
export function parseRetentionHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_HOURS) {
    throw new Error(`Invalid ATTENDEE_RETENTION_HOURS: ${raw} (use a whole number of hours, 0 to keep indefinitely)`);
  }
  return n;
}

/** Retention in milliseconds, or null when attendee data is kept indefinitely. */
export function retentionMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const hours = parseRetentionHours(env.ATTENDEE_RETENTION_HOURS);
  return hours === 0 ? null : hours * HOUR_MS;
}

/** The `expires_at` value for a document created at `createdMs`. */
export function expiresAtFor(createdMs: number, retentionMs: number | null = retentionMsFromEnv()): string {
  return retentionMs === null ? NO_EXPIRY : new Date(createdMs + retentionMs).toISOString();
}
