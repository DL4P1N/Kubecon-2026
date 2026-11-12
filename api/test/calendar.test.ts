import { describe, expect, it, vi } from "vitest";
import ICAL from "ical.js";
import { createCalendar } from "../src/calendar/ical.js";
import { createTokenService } from "../src/auth/token.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { mk, recordingDb, seededDb } from "./search-fixtures.js";

const at = new Date("2026-11-09T12:00:00Z");
const item = mk("calendar-talk", 9, 10, {
  title: "Security, signing; Kubernetes\\cloud\nWorkshop " + "🚀é".repeat(40),
  room: "Hall A; Level 1, East",
  abstract: "First line\r\nSecond line; commas, and \\slashes\nBEGIN:VEVENT",
  start: "2026-11-10T09:00:00-07:00", end: "2026-11-10T10:00:00-07:00",
});
const parse = (text: string) => new ICAL.Component(ICAL.parse(text));

describe("calendar serialization", () => {
  it("round-trips escaped Unicode text, UTC times and stable UID through an independent parser", () => {
    const text = createCalendar([item, item], at);
    expect(text.endsWith("\r\n")).toBe(true);
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const calendar = parse(text);
    expect(calendar.getFirstPropertyValue("version")).toBe("2.0");
    const components = calendar.getAllSubcomponents("vevent");
    expect(components).toHaveLength(1);
    const event = new ICAL.Event(components[0]);
    expect(event.uid).toBe("calendar-talk@conference-companion");
    expect(event.summary).toBe(item.title);
    expect(event.location).toBe(item.room);
    expect(event.description).toContain("First line\nSecond line; commas, and \\slashes\nBEGIN:VEVENT");
    expect(event.startDate.toJSDate().toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(event.endDate.toJSDate().toISOString()).toBe("2026-11-10T17:00:00.000Z");
    expect(String(components[0]!.getFirstPropertyValue("dtstamp"))).toBe("2026-11-09T12:00:00Z");
  });

  it("supports an empty schedule and rejects invalid event dates", () => {
    expect(parse(createCalendar([], at)).getAllSubcomponents("vevent")).toHaveLength(0);
    expect(() => createCalendar([{ ...item, start: "invalid" }], at)).toThrow("Invalid calendar time");
    expect(() => createCalendar([{ ...item, end: item.start }], at)).toThrow("Invalid calendar interval");
  });
});

describe("GET /api/schedule.ics", () => {
  it("requires a signed session before reading personal data and exports only that attendee's saved talks", async () => {
    const attendeeId = "synthetic-attendee-private-canary";
    const tokens = createTokenService({ key: "test-only-calendar-signing-key-0123456789" });
    const db = recordingDb(await seededDb([item]));
    const store = { save: vi.fn(async () => {}), load: vi.fn(async (id: string) => id === attendeeId
      ? { talkIds: [item.id], updatedAt: at.toISOString() } : undefined) };
    const app = buildServer(loadConfig({}), { db, embedder: new LocalHashEmbedder(), tokens, search: { scheduleStore: store, now: () => at } });
    try {
      for (const authorization of [undefined, "Bearer stub.victim", "Bearer malformed"]) {
        const result = await app.inject({ method: "GET", url: "/api/schedule.ics", headers: authorization ? { authorization } : {} });
        expect(result.statusCode).toBe(401);
        expect(result.headers["cache-control"]).toBe("private, no-store");
      }
      expect(store.load).not.toHaveBeenCalled();
      expect(db.statements).toHaveLength(0);
      const signed = await tokens.sign(attendeeId);
      const headers = { authorization: `Bearer ${signed.token}` };
      const result = await app.inject({ method: "GET", url: "/api/schedule.ics", headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toContain("text/calendar");
      expect(result.headers["content-disposition"]).toBe('attachment; filename="conference-schedule.ics"');
      expect(parse(result.body).getAllSubcomponents("vevent")).toHaveLength(1);
      // The talk came back from the talks table with its text intact.
      expect(new ICAL.Event(parse(result.body).getAllSubcomponents("vevent")[0]).summary).toBe(item.title);
      expect(result.body).not.toContain(attendeeId);
      expect(result.body).not.toContain(signed.token);
      expect(store.load).toHaveBeenCalledWith(attendeeId, at);
      expect((await app.inject({ method: "GET", url: "/api/schedule.ics?talkId=other", headers })).statusCode).toBe(404);
      const single = await app.inject({ method: "GET", url: `/api/schedule.ics?talkId=${item.id}`, headers });
      expect(parse(single.body).getAllSubcomponents("vevent")).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: "/api/schedule.ics?talkId=a&talkId=b", headers })).statusCode).toBe(400);
      const other = await tokens.sign("another-synthetic-attendee");
      const empty = await app.inject({ method: "GET", url: "/api/schedule.ics", headers: { authorization: `Bearer ${other.token}` } });
      expect(parse(empty.body).getAllSubcomponents("vevent")).toHaveLength(0);
    } finally { await app.close(); }
  });
});
