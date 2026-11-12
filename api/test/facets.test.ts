import { describe, expect, it } from "vitest";
import type { SearchResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { buildServer } from "../src/server.js";
import { parseFacets, parseSearchFilters } from "../src/search/facets.js";
import { mk, recordingDb, seededDb } from "./search-fixtures.js";

describe("parseFacets", () => {
  it("orders tracks by count then name, levels likewise, days chronologically, and skips empty or malformed rows", () => {
    expect(
      parseFacets([
        { facet: "track", value: "Observability", n: 2 },
        { facet: "track", value: "Security", n: "4" },
        { facet: "track", value: "Apps", n: 2 },
        { facet: "track", value: "", n: 9 },
        { facet: "level", value: "beginner", n: 3 },
        { facet: "level", value: "advanced", n: 0 },
        { facet: "level", value: null, n: 5 },
        { facet: "day", value: "2026-11-11", n: 1 },
        { facet: "day", value: "2026-11-10", n: 6 },
      ]),
    ).toEqual({
      track: [{ value: "Security", count: 4 }, { value: "Apps", count: 2 }, { value: "Observability", count: 2 }],
      level: [{ value: "beginner", count: 3 }],
      day: [{ value: "2026-11-10", count: 6 }, { value: "2026-11-11", count: 1 }],
    });
    expect(parseFacets([])).toEqual({ track: [], level: [], day: [] });
  });
});

describe("parseSearchFilters", () => {
  it("accepts single and repeated values and dedupes them", () => {
    const r = parseSearchFilters({ day: "2026-11-10", level: ["beginner", "beginner"], track: "Security" });
    expect(r).toEqual({ filters: { day: "2026-11-10", levels: ["beginner"], tracks: ["Security"] } });
    expect(parseSearchFilters({})).toEqual({ filters: {} });
  });

  it.each([
    [{ day: "2026-13-40" }, "day"],
    [{ day: "tomorrow" }, "day"],
    [{ from: "9am" }, "from"],
    [{ from: "2026-11-10T12:00:00Z", to: "2026-11-10T09:00:00Z" }, "from"],
    [{ level: "expert" }, "level"],
    [{ level: ["beginner", "intermediate", "advanced", "beginner"] }, "level"],
    [{ track: "x".repeat(101) }, "track"],
    [{ track: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "track"],
    [{ track: "  " }, "track"],
  ])("rejects %j", (query, field) => {
    const r = parseSearchFilters(query);
    expect("error" in r && r.error.startsWith(`${field}:`)).toBe(true);
  });
});

describe("GET /api/search with filters and facets", () => {
  const TALKS = [
    mk("s1", 0, 1, { title: "Supply chain one", track: "Security", level: "beginner", start: "2026-11-10T16:00:00Z", end: "2026-11-10T17:00:00Z" }),
    mk("s2", 0, 1, { title: "Supply chain two", track: "Security", level: "advanced", start: "2026-11-10T18:00:00Z", end: "2026-11-10T19:00:00Z" }),
    mk("o1", 0, 1, { title: "Supply chain observability", track: "Observability", level: "beginner", start: "2026-11-11T16:00:00Z", end: "2026-11-11T17:00:00Z" }),
    mk("late", 0, 1, { title: "Supply chain night owl", track: "Security", level: "intermediate", start: "2026-11-11T05:00:00Z", end: "2026-11-11T06:00:00Z" }), // Nov 10 22:00 local
    mk("other", 0, 1, { title: "Something else entirely", track: "Platform", level: "beginner" }),
  ];
  async function setup() {
    const db = recordingDb(await seededDb(TALKS));
    return { db, app: buildServer(loadConfig({}), { db, embedder: new LocalHashEmbedder() }) };
  }
  const search = async (app: ReturnType<typeof buildServer>, qs: string) => {
    const res = await app.inject({ method: "GET", url: `/api/search?${qs}` });
    expect(res.statusCode).toBe(200);
    return res.json() as SearchResponse;
  };

  it("keyword mode counts the matching talks by track, level and local day", async () => {
    const { app } = await setup();
    const body = await search(app, "q=supply&mode=keyword");
    expect(body.hits.map((h) => h.talk.id).sort()).toEqual(["late", "o1", "s1", "s2"]);
    expect(body.facets).toEqual({
      track: [{ value: "Security", count: 3 }, { value: "Observability", count: 1 }],
      level: [{ value: "beginner", count: 2 }, { value: "advanced", count: 1 }, { value: "intermediate", count: 1 }],
      // 16:00Z is 09:00 local; the 05:00Z talk belongs to the previous local day.
      day: [{ value: "2026-11-10", count: 3 }, { value: "2026-11-11", count: 1 }],
    });
  });

  it.each(["keyword", "hybrid"])("%s mode applies day, level and track filters and facets reflect them", async (mode) => {
    const { app } = await setup();
    const body = await search(app, `q=supply&mode=${mode}&day=2026-11-10&level=beginner&level=advanced&track=Security&track=Observability`);
    const matched = body.hits.filter((h) => ["s1", "s2", "o1", "late"].includes(h.talk.id)).map((h) => h.talk.id).sort();
    expect(matched).toEqual(["s1", "s2"]);
    expect(body.hits.map((h) => h.talk.id)).not.toContain("o1");
    expect(body.hits.map((h) => h.talk.id)).not.toContain("late");
    expect(body.hits.map((h) => h.talk.id)).not.toContain("other");
    expect(body.facets?.track).toEqual([{ value: "Security", count: 2 }]);
    expect(body.facets?.day).toEqual([{ value: "2026-11-10", count: 2 }]);
  });

  it("from/to bound the talk start and end", async () => {
    const { app } = await setup();
    const body = await search(app, "q=supply&mode=keyword&from=2026-11-10T17:30:00Z&to=2026-11-10T20:00:00Z");
    expect(body.hits.map((h) => h.talk.id)).toEqual(["s2"]);
  });

  it("returns empty facets for a query nothing matches", async () => {
    const { app } = await setup();
    const body = await search(app, "q=zzzzzzzz&mode=keyword");
    expect(body.hits).toEqual([]);
    expect(body.facets).toEqual({ track: [], level: [], day: [] });
  });

  it("rejects bad filters with 400 before touching the database", async () => {
    const { db, app } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/search?q=x&level=guru" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(db.statements).toHaveLength(0);
  });
});
