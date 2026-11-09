import { describe, expect, it } from "vitest";
import { buildSchedule, overlaps } from "../src/search/schedule.js";
import { talk } from "./helpers.js";

const scored = (id: string, s: number, e: number, score: number) => ({ talk: talk(id, s, e), score });

function assertNoOverlap(ts: { talk: { id: string; start: string; end: string } }[]) {
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) expect(overlaps(ts[i]!.talk, ts[j]!.talk)).toBe(false);
  }
}

describe("overlaps", () => {
  it("treats back-to-back talks as non-overlapping", () => {
    expect(overlaps(talk("a", 9, 10), talk("b", 10, 11))).toBe(false);
  });
  it("detects partial and nested overlap", () => {
    expect(overlaps(talk("a", 9, 11), talk("b", 10, 12))).toBe(true);
    expect(overlaps(talk("a", 9, 13), talk("b", 10, 11))).toBe(true);
  });
});

describe("buildSchedule", () => {
  it("keeps the higher scoring of two overlapping talks", () => {
    const r = buildSchedule([scored("low", 9, 10, 1), scored("high", 9, 10, 5)]);
    expect(r.chosen.map((c) => c.talk.id)).toEqual(["high"]);
    expect(r.dropped).toEqual(["low"]);
  });

  it("returns chosen talks ordered by start and never overlapping", () => {
    const r = buildSchedule([
      scored("c", 13, 14, 3),
      scored("a", 9, 10.5, 9),
      scored("b", 10, 11, 8), // overlaps a
      scored("d", 10.5, 11.5, 7), // fits after a
      scored("e", 13.5, 15, 2), // overlaps c
    ]);
    expect(r.chosen.map((c) => c.talk.id)).toEqual(["a", "d", "c"]);
    expect(r.dropped.sort()).toEqual(["b", "e"]);
    assertNoOverlap(r.chosen);
  });

  it("breaks score ties by input order", () => {
    const r = buildSchedule([scored("first", 9, 10, 1), scored("second", 9, 10, 1)]);
    expect(r.chosen.map((c) => c.talk.id)).toEqual(["first"]);
  });

  it("honours maxTalks", () => {
    const r = buildSchedule([scored("a", 9, 10, 3), scored("b", 10, 11, 2), scored("c", 11, 12, 1)], 2);
    expect(r.chosen.map((c) => c.talk.id)).toEqual(["a", "b"]);
    expect(r.dropped).toEqual(["c"]);
  });

  it("drops duplicates and talks with invalid times", () => {
    const bad = { talk: { ...talk("bad", 9, 10), end: "nonsense" }, score: 10 };
    const r = buildSchedule([bad, scored("a", 9, 10, 2), scored("a", 9, 10, 2)]);
    expect(r.chosen.map((c) => c.talk.id)).toEqual(["a"]);
    expect(r.dropped).toEqual(["bad"]);
  });

  it("handles an empty candidate list", () => {
    expect(buildSchedule([])).toEqual({ chosen: [], dropped: [], skipped: [] });
  });
});

describe("buildSchedule skipped", () => {
  const skippedIds = (r: ReturnType<typeof buildSchedule>) =>
    r.skipped.map((s) => ({ talkId: s.talk.id, conflictsWith: s.conflictsWith }));

  it("reports each overlap-dropped talk with the kept talk it conflicts with", () => {
    const r = buildSchedule([scored("high", 9, 10, 5), scored("low", 9.5, 10.5, 1), scored("free", 11, 12, 0)]);
    expect(skippedIds(r)).toEqual([{ talkId: "low", conflictsWith: ["high"] }]);
    expect(r.skipped[0]!.talk.title).toBe("Talk low");
  });

  it("lists every kept talk a skipped talk overlaps", () => {
    const r = buildSchedule([scored("a", 9, 10, 3), scored("b", 10, 11, 2), scored("wide", 9, 11, 1)]);
    expect(skippedIds(r)).toEqual([{ talkId: "wide", conflictsWith: ["a", "b"] }]);
  });

  it("does not report cap, invalid-time or duplicate drops as conflicts", () => {
    const bad = { talk: { ...talk("bad", 9, 10), end: "nonsense" }, score: 10 };
    const r = buildSchedule([bad, scored("a", 9, 10, 3), scored("b", 9, 11, 2), scored("a", 9, 10, 2)], 1);
    expect(r.dropped).toEqual(["bad", "b"]);
    expect(r.skipped).toEqual([]);
  });

  it("reports overlaps found before the cap is reached but not after", () => {
    const r = buildSchedule([scored("a", 9, 10, 4), scored("clash", 9, 10, 3), scored("b", 11, 12, 2), scored("late", 11, 12, 1)], 2);
    expect(r.dropped).toEqual(["clash", "late"]);
    expect(skippedIds(r)).toEqual([{ talkId: "clash", conflictsWith: ["a"] }]);
  });
});
