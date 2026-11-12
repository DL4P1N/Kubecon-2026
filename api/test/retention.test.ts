import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { runRetention } from "../src/retention.js";
import { testDb } from "./pg.js";

const now = new Date("2026-11-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NO_EXPIRY = "9999-12-31T23:59:59.999Z";

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await db.close(); });

async function seed(id: string, createdAt: string, expiresAt: string) {
  await db.query("insert into attendees (id, display_name, created_at, expires_at) values ($1, 'x', $2, $3)", [id, createdAt, expiresAt]);
  await db.query("insert into schedules (attendee_id, talk_ids, updated_at, expires_at) values ($1, '{}', $2, $3)", [id, createdAt, expiresAt]);
  await db.query("insert into entitlements (attendee_id, pass_type, rooms, updated_at, expires_at) values ($1, 'general', '{*}', $2, $3)", [id, createdAt, expiresAt]);
  await db.query("insert into identities (id, attendee_id, created_at, expires_at) values ($1, $1, $2, $3)", [id, createdAt, expiresAt]);
}
const ids = async (table: string, col = "attendee_id") => (await db.query<{ k: string }>(`select ${col} as k from ${table} order by 1`)).rows.map((r) => r.k);

it("deletes old or expired rows in all four tables and keeps new rows at a fixed clock", async () => {
  await seed("old", "2026-11-08T11:59:59Z", NO_EXPIRY); // older than 24 h by created_at
  await seed("new", "2026-11-09T11:00:00Z", "2026-11-10T11:00:00Z");
  await seed("boundary", "2026-11-08T12:00:00Z", "2026-11-10T12:00:00Z"); // exactly 24 h old: kept
  await seed("expired", "2026-11-09T11:00:00Z", "2026-11-09T12:00:00Z"); // expires_at == now: deleted
  await seed("valid", "2026-11-09T11:00:00Z", "2026-11-10T12:00:00Z");
  expect(await runRetention(db, now, DAY)).toBe(6); // old: attendee + identity by age; expired: all four by expires_at
  for (const [table, col] of [["attendees", "id"], ["identities", "id"]] as const) {
    expect(await ids(table, col)).toEqual(["boundary", "new", "valid"]);
  }
  // schedules and entitlements carry no created_at: they follow expires_at (set to created + period when retention is on).
  for (const table of ["schedules", "entitlements"]) expect(await ids(table)).toEqual(["boundary", "new", "old", "valid"]);
});

it("with retention off (null) logs one line and deletes only expired rows, never by created_at", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await seed("old-policy-expired", "2026-11-08T00:00:00Z", "2026-11-09T11:59:59Z");
  await seed("kept-sentinel", "2020-01-01T00:00:00Z", NO_EXPIRY);
  expect(await runRetention(db, now, null)).toBe(4);
  expect(await ids("attendees", "id")).toEqual(["kept-sentinel"]);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toMatch(/Retention is off/);
});

it("defaults to off when ATTENDEE_RETENTION_HOURS is unset or 0, still deleting only already-expired rows", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await seed("kept", "2020-01-01T00:00:00Z", NO_EXPIRY);
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "");
  expect(await runRetention(db, now)).toBe(0);
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "0");
  expect(await runRetention(db, now)).toBe(0);
  expect(await ids("attendees", "id")).toEqual(["kept"]);
});

it("ATTENDEE_RETENTION_HOURS=24 purges attendees and identities older than 24 hours; =48 moves the cut-off", async () => {
  await seed("a30h", "2026-11-08T06:00:00Z", NO_EXPIRY);
  await seed("a2h", "2026-11-09T10:00:00Z", NO_EXPIRY);
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "48");
  expect(await runRetention(db, now)).toBe(0);
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "24");
  expect(await ids("attendees", "id")).toEqual(["a2h", "a30h"]);
  expect(await runRetention(db, now)).toBe(2); // attendee + identity
});

it("reports a failing table as incomplete after trying the rest", async () => {
  await seed("expired", "2026-11-09T11:00:00Z", "2026-11-09T11:30:00Z");
  const seen: string[] = [];
  const failing: Db = {
    ...db,
    query: ((sql: string, params?: readonly unknown[]) => {
      seen.push(sql);
      return /from schedules/.test(sql) ? Promise.reject(new Error("unavailable")) : db.query(sql, params);
    }) as Db["query"],
  };
  await expect(runRetention(failing, now, DAY)).rejects.toThrow("incomplete");
  expect(seen).toHaveLength(4);
  expect(await ids("attendees", "id")).toEqual([]);
  expect(await ids("schedules")).toEqual(["expired"]);
});

it("rejects an invalid clock or period before deleting anything", async () => {
  await seed("expired", "2026-11-09T11:00:00Z", "2026-11-09T11:30:00Z");
  await expect(runRetention(db, new Date("invalid"), DAY)).rejects.toThrow("Invalid retention clock");
  await expect(runRetention(db, now, 0)).rejects.toThrow("Invalid retention period");
  await expect(runRetention(db, now, Number.NaN)).rejects.toThrow("Invalid retention period");
  expect(await ids("attendees", "id")).toEqual(["expired"]);
});
