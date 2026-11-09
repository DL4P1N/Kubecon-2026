import { expect, it, vi } from "vitest";
import type { EsClient } from "../src/es/client.js";
import { retentionQuery, runRetention } from "../src/retention.js";

const now = new Date("2026-11-09T12:00:00Z");
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
  expect(await runRetention({ request } as unknown as EsClient, now)).toBe(6);
  expect(request.mock.calls.map((call) => call[1])).toEqual([
    "/attendees/_delete_by_query?refresh=true&conflicts=proceed",
    "/schedules/_delete_by_query?refresh=true&conflicts=proceed",
    "/entitlements/_delete_by_query?refresh=true&conflicts=proceed",
  ]);
  for (const kept of remaining.values()) expect(kept.map((doc) => doc.id)).toEqual(["new", "boundary", "valid"]);
});

it("reports incomplete deletion as failure", async () => {
  const es = { request: vi.fn().mockResolvedValue({ status: 200, body: { deleted: 0, failures: [{}] } }) };
  await expect(runRetention(es as unknown as EsClient, now)).rejects.toThrow("incomplete");
});
it("rejects an invalid clock before issuing deletion requests", () => {
  expect(() => retentionQuery(new Date("invalid"))).toThrow("Invalid retention clock");
});
