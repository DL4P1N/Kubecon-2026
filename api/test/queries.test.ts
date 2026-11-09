import { describe, expect, it } from "vitest";
import {
  KEYWORD_FIELDS,
  SEMANTIC_FIELD,
  buildHybridBody,
  buildKeywordBody,
  filterClauses,
  levelsFor,
  onboardingFilters,
  onboardingText,
} from "../src/search/queries.js";

type Obj = Record<string, any>;

describe("buildKeywordBody", () => {
  it("is a BM25 multi_match over title, tags and abstract", () => {
    const body = buildKeywordBody("supply chain", 7) as Obj;
    expect(body.size).toBe(7);
    const mm = body.query.bool.must[0].multi_match;
    expect(mm.query).toBe("supply chain");
    expect(mm.fields).toEqual([...KEYWORD_FIELDS]);
    expect(body.query.bool.filter).toEqual([]);
    expect(body.retriever).toBeUndefined();
  });

  it("applies level and time filters", () => {
    const body = buildKeywordBody("x", 5, { levels: ["beginner"], from: "2026-11-10T09:00:00Z", to: "2026-11-10T17:00:00Z" }) as Obj;
    expect(body.query.bool.filter).toEqual([
      { terms: { level: ["beginner"] } },
      { range: { start: { gte: "2026-11-10T09:00:00Z" } } },
      { range: { end: { lte: "2026-11-10T17:00:00Z" } } },
    ]);
  });
});

describe("buildHybridBody", () => {
  it("fuses a BM25 leg and a semantic leg on content_semantic with RRF", () => {
    const body = buildHybridBody("keep my software safe", 10) as Obj;
    expect(body.query).toBeUndefined();
    const rrf = body.retriever.rrf;
    expect(rrf.retrievers).toHaveLength(2);
    const [kw, sem] = rrf.retrievers;
    expect(kw.standard._name).toBe("keyword");
    expect(kw.standard.query.bool.must[0].multi_match.query).toBe("keep my software safe");
    expect(sem.standard._name).toBe("semantic");
    expect(sem.standard.query.bool.must[0]).toEqual({
      semantic: { field: SEMANTIC_FIELD, query: "keep my software safe" },
    });
    expect(rrf.rank_window_size).toBeGreaterThanOrEqual(10);
  });

  it("uses no client-side vectors", () => {
    expect(JSON.stringify(buildHybridBody("x", 5))).not.toMatch(/query_vector|knn/);
  });

  it("repeats filters on both legs", () => {
    const body = buildHybridBody("x", 5, { levels: ["beginner", "intermediate"], from: "2026-11-10T09:00:00Z" }) as Obj;
    const expected = [
      { terms: { level: ["beginner", "intermediate"] } },
      { range: { start: { gte: "2026-11-10T09:00:00Z" } } },
    ];
    for (const leg of body.retriever.rrf.retrievers) expect(leg.standard.query.bool.filter).toEqual(expected);
  });

  it("widens the rank window for large page sizes", () => {
    const body = buildHybridBody("x", 200) as Obj;
    expect(body.retriever.rrf.rank_window_size).toBe(200);
  });
});

describe("filters and onboarding", () => {
  it("emits no clauses without filters", () => {
    expect(filterClauses({})).toEqual([]);
    expect(filterClauses({ levels: [] })).toEqual([]);
  });

  it("maps experience to nearby levels", () => {
    expect(levelsFor("beginner")).toEqual(["beginner", "intermediate"]);
    expect(levelsFor("advanced")).not.toContain("beginner");
  });

  it("builds query text from topics, goals and free text", () => {
    expect(
      onboardingText({ topics: ["security", " "], experience: "beginner", goals: ["learn the basics"], freeText: " supply chain " }),
    ).toBe("security learn the basics supply chain");
  });

  it("derives filters from onboarding answers", () => {
    expect(
      onboardingFilters({ topics: [], experience: "beginner", goals: [], availableFrom: "a", availableTo: "b" }),
    ).toEqual({ levels: ["beginner", "intermediate"], from: "a", to: "b" });
  });
});
