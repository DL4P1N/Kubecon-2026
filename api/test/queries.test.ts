import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNING,
  KEYWORD_FIELDS,
  SEMANTIC_FIELD,
  buildHybridBody,
  buildKeywordBody,
  eligibilityClauses,
  expandQueryText,
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

describe("attendee-vocabulary expansion (#52)", () => {
  const pagerQuery = "my pager keeps going off at night";

  it("expands both legs once from the same text", () => {
    const [keywordLeg, semanticLeg] = (buildHybridBody(pagerQuery, 10) as Obj).retriever.rrf.retrievers;
    const keywordText = keywordLeg.standard.query.bool.must[0].multi_match.query;
    const semanticText = semanticLeg.standard.query.bool.must[0].semantic.query;
    expect(keywordText).toBe(semanticText);
    expect(keywordText.startsWith(pagerQuery)).toBe(true);
    expect(keywordText).toContain("on-call incident response alert triage AI SRE");
    expect(keywordText.match(/on-call/g)).toHaveLength(1);
  });

  it("leaves unrelated queries untouched", () => {
    expect(expandQueryText("kubernetes network security")).toBe("kubernetes network security");
  });

  it("can be disabled through the tuning", () => {
    const [, semanticLeg] = (buildHybridBody(pagerQuery, 10, {}, { ...DEFAULT_TUNING, queryExpansion: "off" }) as Obj)
      .retriever.rrf.retrievers;
    expect(semanticLeg.standard.query.bool.must[0].semantic.query).toBe(pagerQuery);
  });

  it("expands keyword mode with the same bridge text", () => {
    const body = buildKeywordBody(pagerQuery, 10) as Obj;
    expect(body.query.bool.must[0].multi_match.query).toContain("on-call incident response alert triage AI SRE");
  });

  it("keeps an untouched query identical in both modes", () => {
    const plain = "kubernetes network security";
    const keywordBody = buildKeywordBody(plain, 10) as Obj;
    const [, semanticLeg] = (buildHybridBody(plain, 10) as Obj).retriever.rrf.retrievers;
    expect(keywordBody.query.bool.must[0].multi_match.query).toBe(plain);
    expect(semanticLeg.standard.query.bool.must[0].semantic.query).toBe(plain);
  });
});

describe("tuning", () => {
  const excl = { ...DEFAULT_TUNING, excludeTracks: ["Contribfest"] };
  const mustNot = { bool: { must_not: [{ terms: { track: ["Contribfest"] } }] } };

  it("adds the track exclusion after the level/time filters", () => {
    expect(eligibilityClauses({ levels: ["beginner"] }, excl)).toEqual([{ terms: { level: ["beginner"] } }, mustNot]);
    expect(eligibilityClauses({}, { ...DEFAULT_TUNING, excludeTracks: [] })).toEqual([]);
  });

  it("applies the same exclusion in keyword mode and on both hybrid legs", () => {
    expect((buildKeywordBody("x", 5, {}, excl) as Obj).query.bool.filter).toEqual([mustNot]);
    for (const leg of (buildHybridBody("x", 5, {}, excl) as Obj).retriever.rrf.retrievers) {
      expect(leg.standard.query.bool.filter).toEqual([mustNot]);
    }
  });

  it("passes RRF rank constant and window from the tuning", () => {
    const rrf = (buildHybridBody("x", 5, {}, { ...DEFAULT_TUNING, rankConstant: 20, rankWindowSize: 100 }) as Obj).retriever.rrf;
    expect(rrf.rank_constant).toBe(20);
    expect(rrf.rank_window_size).toBe(100);
  });

  it("sets minimum_should_match on the hybrid keyword leg only", () => {
    const t = { ...DEFAULT_TUNING, hybridKeywordMinimumShouldMatch: "30%" };
    const [kw, sem] = (buildHybridBody("x", 5, {}, t) as Obj).retriever.rrf.retrievers;
    expect(kw.standard.query.bool.must[0].multi_match.minimum_should_match).toBe("30%");
    expect(sem.standard.query.bool.must[0].semantic).toBeDefined();
    expect((buildKeywordBody("x", 5, {}, t) as Obj).query.bool.must[0].multi_match.minimum_should_match).toBeUndefined();
  });

  it("builds a weighted linear retriever with min-max normalization", () => {
    const body = buildHybridBody("x", 5, {}, { ...DEFAULT_TUNING, fusion: "linear", semanticWeight: 2 }) as Obj;
    expect(body.retriever.rrf).toBeUndefined();
    const [kw, sem] = body.retriever.linear.retrievers;
    expect(kw).toMatchObject({ weight: 1, normalizer: "minmax", retriever: { standard: { _name: "keyword" } } });
    expect(sem).toMatchObject({ weight: 2, normalizer: "minmax", retriever: { standard: { _name: "semantic" } } });
    expect(body.retriever.linear.rank_window_size).toBe(DEFAULT_TUNING.rankWindowSize);
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

describe("typo tolerance (#55)", () => {
  it("adds fuzziness to the keyword leg in both modes, and only there", () => {
    const kw = (buildKeywordBody("kuberentes", 5) as Obj).query.bool.must[0].multi_match;
    expect(kw).toMatchObject({ fuzziness: "AUTO", prefix_length: 1, type: "best_fields" });
    const hy = buildHybridBody("kuberentes", 5) as Obj;
    const legs = hy.retriever.rrf.retrievers as Obj[];
    expect(legs[0]!.standard.query.bool.must[0].multi_match).toMatchObject({ fuzziness: "AUTO", prefix_length: 1 });
    expect(JSON.stringify(legs[1])).not.toContain("fuzziness"); // the semantic leg is untouched
  });
  it("is off when the tuning leaves fuzziness unset (pre-#55 behaviour, used by the eval baseline)", () => {
    const t = { ...DEFAULT_TUNING, fuzziness: undefined, fuzzyPrefixLength: undefined };
    const mm = (buildKeywordBody("x", 5, {}, t) as Obj).query.bool.must[0].multi_match;
    expect(mm.fuzziness).toBeUndefined();
    expect(mm.prefix_length).toBeUndefined();
  });
});
