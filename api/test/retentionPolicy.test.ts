import { describe, expect, it } from "vitest";
import { NO_EXPIRY, expiresAtFor, parseRetentionHours, retentionMsFromEnv } from "../src/retentionPolicy.js";
import { loadConfig } from "../src/config.js";
import { createScheduleStore } from "../src/search/service.js";
import { testDb } from "./pg.js";

describe("ATTENDEE_RETENTION_HOURS", () => {
  it("defaults to keeping profiles: unset, blank and 0 all mean off", () => {
    for (const raw of [undefined, "", "  ", "0"]) expect(parseRetentionHours(raw)).toBe(0);
    expect(retentionMsFromEnv({})).toBeNull();
    expect(retentionMsFromEnv({ ATTENDEE_RETENTION_HOURS: "0" })).toBeNull();
    expect(loadConfig({}).attendeeRetentionHours).toBe(0);
  });

  it("a positive whole number restores timed deletion", () => {
    expect(retentionMsFromEnv({ ATTENDEE_RETENTION_HOURS: "24" })).toBe(24 * 3600 * 1000);
    expect(loadConfig({ ATTENDEE_RETENTION_HOURS: "24" }).attendeeRetentionHours).toBe(24);
  });

  it("rejects anything else at startup", () => {
    for (const raw of ["-1", "1.5", "abc", "24h", "1e9", "999999999"]) {
      expect(() => parseRetentionHours(raw), raw).toThrow("Invalid ATTENDEE_RETENTION_HOURS");
    }
    expect(() => loadConfig({ ATTENDEE_RETENTION_HOURS: "-1" })).toThrow("ATTENDEE_RETENTION_HOURS");
  });

  it("expiresAtFor is the far-future sentinel when off and created + period when on", () => {
    const t = Date.parse("2026-11-09T12:00:00Z");
    expect(expiresAtFor(t, null)).toBe(NO_EXPIRY);
    expect(expiresAtFor(t, 24 * 3600 * 1000)).toBe("2026-11-10T12:00:00.000Z");
  });
});

describe("schedule TTL follows the setting", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  async function savedExpiry(env: string | undefined) {
    const prev = process.env.ATTENDEE_RETENTION_HOURS;
    if (env === undefined) delete process.env.ATTENDEE_RETENTION_HOURS; else process.env.ATTENDEE_RETENTION_HOURS = env;
    try {
      const db = await testDb();
      await createScheduleStore(db).save("a1", ["t1"], now);
      const row = (await db.query<{ expires_at: Date | string }>("select expires_at from schedules where attendee_id = 'a1'")).rows[0]!;
      await db.close();
      return new Date(row.expires_at).toISOString();
    } finally {
      if (prev === undefined) delete process.env.ATTENDEE_RETENTION_HOURS; else process.env.ATTENDEE_RETENTION_HOURS = prev;
    }
  }
  it("is kept by default and expires after 24 hours when the setting is 24", async () => {
    expect(await savedExpiry(undefined)).toBe(new Date(NO_EXPIRY).toISOString());
    expect(await savedExpiry("24")).toBe("2026-11-10T12:00:00.000Z");
  });
});
