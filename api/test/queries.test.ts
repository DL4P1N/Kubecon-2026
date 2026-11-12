import { describe, expect, it } from "vitest";
import { vectorLiteral } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import {
  DEFAULT_TUNING,
  buildHybridPlan,
  buildKeywordPlan,
  dayBounds,
  expandQueryText,
  fuzzyTerms,
  levelsFor,
  onboardingFilters,
  onboardingText,
  type SearchFilters,
  type SearchTuning,
} from "../src/search/queries.js";
import { C, CATALOG, D, mk, seededDb } from "./search-fixtures.js";

const embedder = new LocalHashEmbedder();

async function run(db: Awaited<ReturnType<typeof seededDb>>, plan: { hits: { text: string; params: unknown[] } }) {
  return (await db.query<{ id: string; score: number; in_keyword: boolean; in_semantic: boolean }>(plan.hits.text, plan.hits.params)).rows;
}
const hybrid = async (db: Awaited<ReturnType<typeof seededDb>>, text: string, size = 10, f: SearchFilters = {}, t: SearchTuning = DEFAULT_TUNING) =>
  run(db, buildHybridPlan(text, vectorLiteral(await embedder.embed(text, "query")), size, f, t));
const keyword = (db: Awaited<ReturnType<typeof seededDb>>, text: string, size = 10, f: SearchFilters = {}, t: SearchTuning = DEFAULT_TUNING) =>
  run(db, buildKeywordPlan(text, size, f, t));

describe("keyword plan", () => {
  it("matches any term (like the old OR multi_match) and ranks talks matching more terms first", async () => {
    const db = await seededDb();
    const rows = await keyword(db, "supply chain kubernetes");
    const ids = rows.map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]); // supply + chain in the title
    expect(ids).toContain("c"); // kubernetes only
    expect(ids).not.toContain("d");
    expect(rows.every((r) => r.in_keyword && !r.in_semantic)).toBe(true);
  });

  it('"all" requires every term (websearch AND semantics)', async () => {
    const db = await seededDb();
    const rows = await keyword(db, "supply kubernetes", 10, {}, { ...DEFAULT_TUNING, keywordMatch: "all", fuzzyThreshold: undefined });
    expect(rows).toEqual([]);
  });

  it("weights title above abstract", async () => {
    const db = await seededDb([
      mk("t", 9, 10, { title: "Observability pipelines", abstract: "plain" }),
      mk("ab", 9, 10, { title: "Plain talk", abstract: "all about observability" }),
    ]);
    expect((await keyword(db, "observability")).map((r) => r.id)).toEqual(["t", "ab"]);
  });

  it("applies level, time, track and track-exclusion filters", async () => {
    const db = await seededDb();
    const ids = async (f: SearchFilters, t = DEFAULT_TUNING) => (await keyword(db, "kubernetes security observability", 10, f, t)).map((r) => r.id).sort();
    expect(await ids({ levels: ["advanced"] })).toEqual(["d"]);
    expect(await ids({ tracks: ["Platform", "Observability"] })).toEqual(["c", "d"]);
    expect(await ids({ from: C.start, to: C.end })).toEqual(["c", "e"]);
    expect(await ids({ from: C.start })).toEqual(["c", "d", "e"]);
    expect(await ids({}, { ...DEFAULT_TUNING, excludeTracks: ["Contribfest"] })).not.toContain("e");
  });

  it("filters by local conference day (UTC-7), not UTC day", async () => {
    const db = await seededDb([
      mk("late", 0, 1, { title: "kubernetes late", start: "2026-11-11T05:00:00Z", end: "2026-11-11T06:00:00Z" }), // Nov 10 22:00 local
      mk("next", 0, 1, { title: "kubernetes next", start: "2026-11-11T07:30:00Z", end: "2026-11-11T08:30:00Z" }), // Nov 11 00:30 local
      mk("early", 0, 1, { title: "kubernetes early", start: "2026-11-10T06:59:00Z", end: "2026-11-10T08:00:00Z" }), // Nov 9 23:59 local
    ]);
    const day = async (d: string) => (await keyword(db, "kubernetes", 10, { day: d })).map((r) => r.id);
    expect(await day("2026-11-10")).toEqual(["late"]);
    expect(await day("2026-11-11")).toEqual(["next"]);
    expect(await day("2026-11-09")).toEqual(["early"]);
    expect(dayBounds("2026-11-10")).toEqual({ start: "2026-11-10T07:00:00.000Z", end: "2026-11-11T07:00:00.000Z" });
  });

  it("caps the page at size", async () => {
    const db = await seededDb();
    expect(await keyword(db, "kubernetes security observability", 2)).toHaveLength(2);
  });

  it("is parameterised: the SQL never contains the query text, only placeholders", () => {
    const plan = buildKeywordPlan("zebra-secret'; drop table talks; --", 5, { tracks: ["Sec'urity"], day: "2026-11-10" });
    expect(plan.hits.text).not.toMatch(/zebra|drop table|Sec'urity|2026/);
    expect(plan.hits.text).toContain("$1");
    expect(plan.hits.params[0]).toEqual(expect.stringContaining("zebra-secret'; drop table talks; --"));
    const referenced = new Set([...plan.hits.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect([...referenced].sort((a, b) => a - b)).toEqual(plan.hits.params.map((_, i) => i + 1));
  });
});

describe("hybrid plan", () => {
  it("fuses both legs with RRF and marks which legs matched", async () => {
    const db = await seededDb();
    const rows = await hybrid(db, "supply chain builds");
    expect(rows.slice(0, 2).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ in_keyword: true, in_semantic: true });
    const d = rows.find((r) => r.id === "d")!;
    expect(d).toMatchObject({ in_keyword: false, in_semantic: true });
    // RRF score of a talk ranked first in both legs: 2 / (60 + 1).
    const both = rows.find((r) => r.in_keyword && r.in_semantic)!;
    expect(Number(both.score)).toBeLessThanOrEqual(2 / 61 + 1e-9);
    expect(Number(rows[0]!.score)).toBeGreaterThanOrEqual(Number(rows[1]!.score));
  });

  it("passes the rank constant and window from the tuning", async () => {
    const db = await seededDb();
    const k20 = await hybrid(db, "supply chain builds", 10, {}, { ...DEFAULT_TUNING, rankConstant: 20 });
    expect(Number(k20[0]!.score)).toBeGreaterThan(2 / 61);
    expect(Number(k20[0]!.score)).toBeLessThanOrEqual(2 / 21 + 1e-9);
    const narrow = await hybrid(db, "supply chain builds", 1, {}, { ...DEFAULT_TUNING, rankWindowSize: 2 });
    expect(narrow).toHaveLength(1);
    const windowed = await run(db, buildHybridPlan("supply chain builds", vectorLiteral(await embedder.embed("x", "query")), 1, {}, { ...DEFAULT_TUNING, rankWindowSize: 1 }));
    expect(windowed).toHaveLength(1);
  });

  it("limits each leg to the rank window (widened to size)", async () => {
    const db = await seededDb();
    const rows = await hybrid(db, "kubernetes", 10, {}, { ...DEFAULT_TUNING, rankWindowSize: 2 });
    // window = max(2, size 10): every talk reachable through the semantic leg
    expect(rows).toHaveLength(CATALOG.length);
    const small = await hybrid(db, "kubernetes", 1, {}, { ...DEFAULT_TUNING, rankWindowSize: 2 });
    expect(small).toHaveLength(1);
  });

  it("supports min-max linear fusion with a semantic weight", async () => {
    const db = await seededDb();
    const linear = { ...DEFAULT_TUNING, fusion: "linear" as const };
    const w1 = await hybrid(db, "supply chain builds", 10, {}, linear);
    const w2 = await hybrid(db, "supply chain builds", 10, {}, { ...linear, semanticWeight: 2 });
    // Best of both legs normalises to 1 each: top score is 1 + weight when one talk leads both legs.
    expect(Number(w1[0]!.score)).toBeCloseTo(2, 5);
    expect(Number(w2[0]!.score)).toBeCloseTo(3, 5);
    expect(w1.slice(0, 2).map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("repeats the filters on both legs", async () => {
    const db = await seededDb();
    const f = async (filters: SearchFilters, t = DEFAULT_TUNING) => (await hybrid(db, "kubernetes security", 10, filters, t)).map((r) => r.id).sort();
    expect(await f({ levels: ["beginner"] })).toEqual(["a", "b", "e"]);
    expect(await f({ tracks: ["Observability"] })).toEqual(["d"]);
    expect(await f({}, { ...DEFAULT_TUNING, excludeTracks: ["Contribfest"] })).toEqual(["a", "b", "c", "d"]);
    expect(await f({ from: D.start })).toEqual(["d"]);
  });

  it("all params are referenced and the statement holds no user text", async () => {
    const q = "zebra-secret";
    const plan = buildHybridPlan(q, vectorLiteral(await embedder.embed(q, "query")), 5, { levels: ["beginner"] });
    expect(plan.hits.text).not.toContain(q);
    const referenced = new Set([...plan.hits.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect([...referenced].sort((a, b) => a - b)).toEqual(plan.hits.params.map((_, i) => i + 1));
  });
});

describe("attendee-vocabulary expansion (#52)", () => {
  const pagerQuery = "my pager keeps going off at night";

  it("appends catalog vocabulary once", () => {
    const text = expandQueryText(pagerQuery);
    expect(text.startsWith(pagerQuery)).toBe(true);
    expect(text).toContain("on-call incident response alert triage");
    expect(text.match(/on-call/g)).toHaveLength(1);
  });

  it("leaves unrelated queries untouched", () => {
    expect(expandQueryText("kubernetes network security")).toBe("kubernetes network security");
  });

  it("feeds the keyword leg, and can be disabled through the tuning", async () => {
    const db = await seededDb([mk("oncall", 9, 10, { title: "Incident response and alert triage", abstract: "x" })]);
    expect((await keyword(db, pagerQuery)).map((r) => r.id)).toEqual(["oncall"]);
    expect(await keyword(db, pagerQuery, 10, {}, { ...DEFAULT_TUNING, queryExpansion: "off", fuzzyThreshold: undefined })).toEqual([]);
  });
});

describe("typo tolerance (#55)", () => {
  it("finds a misspelled title word by trigram similarity, below exact matches", async () => {
    const db = await seededDb();
    const rows = await keyword(db, "kuberentes");
    expect(rows.map((r) => r.id)).toContain("c");
  });
  it("is off when the tuning leaves fuzzyThreshold unset (eval baseline)", async () => {
    const db = await seededDb();
    expect(await keyword(db, "kuberentes", 10, {}, { ...DEFAULT_TUNING, fuzzyThreshold: undefined })).toEqual([]);
  });
  it("only fuzzes content words of 5+ letters", () => {
    expect(fuzzyTerms("how do I fix my kuberentes pod")).toEqual(["kuberentes"]);
  });
});

describe("filters and onboarding", () => {
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

