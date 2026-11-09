import { describe, expect, it } from "vitest";
import type { SearchResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { facetAggs, parseFacets, parseSearchFilters } from "../src/search/facets.js";
import { buildHybridBody, buildKeywordBody, filterClauses } from "../src/search/queries.js";
import { esHit, fakeEs, talk } from "./helpers.js";

type Obj = Record<string, any>;

const filters = {
  day: "2026-11-10",
  from: "2026-11-10T08:00:00-07:00",
  to: "2026-11-10T12:00:00-07:00",
  levels: ["beginner" as const],
  tracks: ["Security", "Observability"],
};

const dayRange = {
  range: { start: { gte: "2026-11-10", lt: "2026-11-10||+1d", format: "strict_date", time_zone: "-07:00" } },
};

const aggregations = {
  track: { buckets: [{ key: "Security", doc_count: 4 }, { key: "Observability", doc_count: 2 }] },
  level: { buckets: [{ key: "beginner", doc_count: 3 }, { key: "advanced", doc_count: 0 }] },
  day: { buckets: [{ key: 1794268800000, key_as_string: "2026-11-10", doc_count: 6 }] },
};

describe("filter clauses", () => {
  it("adds track terms and a local-day range on start", () => {
    const clauses = filterClauses(filters);
    expect(clauses).toContainEqual({ terms: { track: ["Security", "Observability"] } });
    expect(clauses).toContainEqual({ terms: { level: ["beginner"] } });
    expect(clauses).toContainEqual(dayRange);
    expect(clauses).toContainEqual({ range: { start: { gte: filters.from } } });
    expect(clauses).toContainEqual({ range: { end: { lte: filters.to } } });
  });

  it("applies the filters in keyword mode", () => {
    const body = buildKeywordBody("x", 5, filters) as Obj;
    expect(body.query.bool.filter).toEqual(filterClauses(filters));
  });

  it("applies the filters inside both RRF retriever legs", () => {
    const body = buildHybridBody("x", 5, filters) as Obj;
    const legs = body.retriever.rrf.retrievers as Obj[];
    expect(legs).toHaveLength(2);
    for (const leg of legs) expect(leg.standard.query.bool.filter).toEqual(filterClauses(filters));
  });
});

describe("facets", () => {
  it("aggregates track and level terms and a per-day histogram in the event offset", () => {
    const aggs = facetAggs() as Obj;
    expect(aggs.track.terms.field).toBe("track");
    expect(aggs.level.terms.field).toBe("level");
    expect(aggs.day.date_histogram).toMatchObject({ field: "start", calendar_interval: "day", time_zone: "-07:00", format: "yyyy-MM-dd" });
  });

  it("parses buckets and skips empty or malformed ones", () => {
    expect(parseFacets(aggregations)).toEqual({
      track: [{ value: "Security", count: 4 }, { value: "Observability", count: 2 }],
      level: [{ value: "beginner", count: 3 }],
      day: [{ value: "2026-11-10", count: 6 }],
    });
    expect(parseFacets({ track: { buckets: [{ key: 5, doc_count: 1 }, null] }, level: "x" })).toEqual({ track: [], level: [], day: [] });
    expect(parseFacets(undefined)).toBeUndefined();
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

describe("GET /api/search with filters", () => {
  function setup() {
    const es = fakeEs((call) =>
      call.path.startsWith("/talks/_search")
        ? { body: { took: 2, hits: { hits: [esHit(talk("a", 9, 10), 1, ["keyword"])] }, aggregations } }
        : undefined,
    );
    return { es, app: buildServer(loadConfig({}), { es }) };
  }

  it.each(["keyword", "hybrid"])("%s mode sends filters and aggs and returns facets", async (mode) => {
    const { es, app } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/search?q=supply&mode=${mode}&day=2026-11-10&level=beginner&track=Security&track=Observability`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.facets?.track).toEqual([{ value: "Security", count: 4 }, { value: "Observability", count: 2 }]);
    expect(body.facets?.day).toEqual([{ value: "2026-11-10", count: 6 }]);
    const sent = es.calls[0]!.body as Obj;
    expect(sent.aggs).toEqual(facetAggs());
    const filterLists: Obj[][] =
      mode === "hybrid" ? sent.retriever.rrf.retrievers.map((l: Obj) => l.standard.query.bool.filter) : [sent.query.bool.filter];
    for (const f of filterLists) {
      expect(f).toContainEqual({ terms: { track: ["Security", "Observability"] } });
      expect(f).toContainEqual({ terms: { level: ["beginner"] } });
      expect(f).toContainEqual(dayRange);
    }
  });

  it("keeps working without filters or aggregations in the ES response", async () => {
    const es = fakeEs(() => ({ body: { took: 1, hits: { hits: [] } } }));
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x&mode=keyword" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SearchResponse).facets).toBeUndefined();
  });

  it("rejects bad filters with 400 before calling Elasticsearch", async () => {
    const { es, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/search?q=x&level=guru" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(es.calls).toHaveLength(0);
  });
});
