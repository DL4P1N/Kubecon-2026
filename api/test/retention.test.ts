import { afterEach, expect, it, vi } from "vitest";
import type { EsClient } from "../src/es/client.js";
import { retentionQuery, runRetention } from "../src/retention.js";

const now = new Date("2026-11-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
it("deletes old or expired documents and keeps new documents at a fixed clock", async () => {
  const docs = [
    { id: "old", created_at: "2026-11-08T11:59:59Z" },
    { id: "new", created_at: "2026-11-09T11:00:00Z" },
    { id: "boundary", created_at: "2026-11-08T12:00:00Z" },
    { id: "expired", expires_at: "2026-11-09T12:00:00Z" },
    { id: "valid", expires_at: "2026-11-10T12:00:00Z" },
  ];
  const remaining = new Map<string, typeof docs>();
  const request = vi.fn(async (_method, path, body) => {
    const rules = body.query.bool.should;
    const kept = docs.filter((doc) => !((doc.created_at && Date.parse(doc.created_at) < Date.parse(rules[0].range.created_at.lt)) ||
      (doc.expires_at && Date.parse(doc.expires_at) <= Date.parse(rules[1].range.expires_at.lte))));
    remaining.set(path, kept);
    return { status: 200, body: { deleted: docs.length - kept.length, failures: [] } };
  });
  expect(await runRetention({ request } as unknown as EsClient, now, DAY)).toBe(6);
  expect(request.mock.calls.map((call) => call[1])).toEqual([
    "/attendees/_delete_by_query?refresh=true&conflicts=proceed",
    "/schedules/_delete_by_query?refresh=true&conflicts=proceed",
    "/entitlements/_delete_by_query?refresh=true&conflicts=proceed",
  ]);
  for (const kept of remaining.values()) expect(kept.map((doc) => doc.id)).toEqual(["new", "boundary", "valid"]);
});

it("reports incomplete deletion as failure", async () => {
  const es = { request: vi.fn().mockResolvedValue({ status: 200, body: { deleted: 0, failures: [{}] } }) };
  await expect(runRetention(es as unknown as EsClient, now, DAY)).rejects.toThrow("incomplete");
  expect(es.request).toHaveBeenCalledTimes(3);
});
it("continues later indices after a request error", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ status: 200, body: { deleted: 2 } });
  await expect(runRetention({ request } as unknown as EsClient, now, DAY)).rejects.toThrow("incomplete");
  expect(request).toHaveBeenCalledTimes(3);
});
it("rejects an invalid clock before issuing deletion requests", () => {
  expect(() => retentionQuery(new Date("invalid"), DAY)).toThrow("Invalid retention clock");
});

it("builds an expires_at-only query when retention is off", () => {
  expect(retentionQuery(now, null)).toEqual({ query: { bool: { minimum_should_match: 1, should: [{ range: { expires_at: { lte: "2026-11-09T12:00:00.000Z" } } }] } } });
});

it("rejects a non-positive retention period before issuing deletion requests", () => {
  expect(() => retentionQuery(now, 0)).toThrow("Invalid retention period");
  expect(() => retentionQuery(now, Number.NaN)).toThrow("Invalid retention period");
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("with retention off (null) logs one line and deletes only expired documents, never by created_at", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const docs = [
    { id: "old-policy-expired", expires_at: "2026-11-09T11:59:59.000Z", created_at: "2026-11-08T00:00:00Z" },
    { id: "kept-sentinel", expires_at: "9999-12-31T23:59:59.999Z", created_at: "2020-01-01T00:00:00Z" },
  ];
  const request = vi.fn(async (_method, _path, body) => {
    const rule = body.query.bool.should[0].range.expires_at.lte;
    expect(body.query.bool.should).toHaveLength(1);
    const deleted = docs.filter((d) => Date.parse(d.expires_at) <= Date.parse(rule)).length;
    return { status: 200, body: { deleted, failures: [] } };
  });
  expect(await runRetention({ request } as unknown as EsClient, now, null)).toBe(3);
  expect(request).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(request.mock.calls[0]![2])).not.toContain("created_at");
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toMatch(/Retention is off/);
});

it("defaults to off when ATTENDEE_RETENTION_HOURS is unset or 0, still deleting only already-expired documents", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const request = vi.fn(async () => ({ status: 200, body: { deleted: 0 } }));
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "");
  expect(await runRetention({ request } as unknown as EsClient, now)).toBe(0);
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "0");
  expect(await runRetention({ request } as unknown as EsClient, now)).toBe(0);
  expect(request).toHaveBeenCalledTimes(6);
});

it("ATTENDEE_RETENTION_HOURS=24 purges attendees, schedules and entitlements older than 24 hours", async () => {
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "24");
  const request = vi.fn(async () => ({ status: 200, body: { deleted: 1, failures: [] } }));
  expect(await runRetention({ request } as unknown as EsClient, now)).toBe(3);
  expect(request).toHaveBeenCalledTimes(3);
  const body = (request.mock.calls[0] as unknown[])[2] as ReturnType<typeof retentionQuery>;
  expect(body.query.bool.should[0]).toEqual({ range: { created_at: { lt: "2026-11-08T12:00:00.000Z" } } });
  expect(body.query.bool.should[1]).toEqual({ range: { expires_at: { lte: "2026-11-09T12:00:00.000Z" } } });
});

it("ATTENDEE_RETENTION_HOURS=48 moves the cut-off to 48 hours", async () => {
  vi.stubEnv("ATTENDEE_RETENTION_HOURS", "48");
  const request = vi.fn(async () => ({ status: 200, body: { deleted: 0 } }));
  await runRetention({ request } as unknown as EsClient, now);
  const body = (request.mock.calls[0] as unknown[])[2] as ReturnType<typeof retentionQuery>;
  expect(body.query.bool.should[0]).toEqual({ range: { created_at: { lt: "2026-11-07T12:00:00.000Z" } } });
});
