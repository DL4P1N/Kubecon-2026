import { describe, expect, it } from "vitest";
import { MIN_CLUSTER_SIZE, type InterestTopicCount } from "@cc/shared";
import { planPlacement, talkDemand, type PlacementTalk } from "../src/rooms/placement.js";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();
const t = (id: string, room: string, tags: string[], start = 9, end = 10): PlacementTalk => ({
  id, title: `Talk ${id}`, room, start: at(start), end: at(end), tags,
});
const plan = (talks: PlacementTalk[], aggregate: InterestTopicCount[], capacities: Record<string, number>) =>
  planPlacement({ talks, aggregate, capacities, suppressedBelow: MIN_CLUSTER_SIZE, generatedAt: at(8) });
const agg: InterestTopicCount[] = [
  { topic: "kubernetes", count: 40 },
  { topic: "security", count: 12 },
  { topic: "other", count: 9 },
];

describe("talkDemand", () => {
  it("sums the aggregate counts of the talk's distinct tags, ignoring case and the merged other bucket", () => {
    expect(talkDemand(["Kubernetes", " security ", "kubernetes"], agg)).toBe(52);
    expect(talkDemand(["other", "wasm"], agg)).toBe(0);
  });
});

describe("planPlacement", () => {
  const caps = { Big: 300, Mid: 100, Small: 30 };

  it("gives the highest-demand talk the largest room within a slot, and flags moves", () => {
    const r = plan([t("a", "Big", ["security"]), t("b", "Small", ["kubernetes"]), t("c", "Mid", ["wasm"])], agg, caps);
    expect(r.slots).toHaveLength(1);
    const by = Object.fromEntries(r.slots[0].talks.map((x) => [x.talkId, x]));
    expect(r.slots[0].talks.map((x) => x.talkId)).toEqual(["b", "a", "c"]);
    expect(by.b).toMatchObject({ demand: 40, demandRank: 1, suggestedRoom: "Big", moved: true, overCapacity: true, capacityKnown: true });
    expect(by.a).toMatchObject({ demand: 12, suggestedRoom: "Mid", moved: true, overCapacity: false });
    expect(by.c).toMatchObject({ demand: 0, suggestedRoom: "Small", moved: true });
    expect(r.capacitiesConfigured).toBe(true);
  });

  it("keeps rooms where nothing needs to change", () => {
    const r = plan([t("a", "Big", ["kubernetes"]), t("b", "Small", ["security"])], agg, caps);
    expect(r.slots[0].talks.every((x) => !x.moved && !x.overCapacity)).toBe(true);
  });

  it("flags over capacity even when the room is already the best choice", () => {
    const r = plan([t("a", "Small", ["kubernetes"])], agg, caps);
    expect(r.slots[0].talks[0]).toMatchObject({ suggestedRoom: "Small", moved: false, overCapacity: true });
  });

  it("breaks demand ties by current room size then id, so tied talks keep their rooms", () => {
    const r = plan([t("a", "Small", ["security"]), t("b", "Big", ["security"])], agg, caps);
    expect(r.slots[0].talks.map((x) => [x.talkId, x.demandRank, x.suggestedRoom, x.moved])).toEqual([
      ["b", 1, "Big", false],
      ["a", 2, "Small", false],
    ]);
    const r2 = plan([t("b", "Mid", []), t("a", "Mid2", [])], agg, { Mid: 50, Mid2: 50 });
    expect(r2.slots[0].talks.map((x) => [x.talkId, x.moved])).toEqual([["a", false], ["b", false]]);
  });

  it("is deterministic regardless of input order", () => {
    const talks = [t("a", "Big", ["security"]), t("b", "Small", ["kubernetes"]), t("c", "Mid", ["security"]), t("d", "Big", [], 11, 12)];
    expect(plan([...talks].reverse(), agg, caps)).toEqual(plan(talks, agg, caps));
  });

  it("groups by identical start and end, ordered by time", () => {
    const r = plan([t("late", "Big", [], 14, 15), t("early", "Big", [], 9, 10), t("odd", "Mid", [], 9, 11)], agg, caps);
    expect(r.slots.map((s) => [s.start, s.end, s.talks.map((x) => x.talkId)])).toEqual([
      [at(9), at(10), ["early"]],
      [at(9), at(11), ["odd"]],
      [at(14), at(15), ["late"]],
    ]);
  });

  it("never invents a capacity: unknown rooms get no suggestion and only a demand rank", () => {
    const r = plan([t("a", "Mystery", ["kubernetes"]), t("b", "Big", ["security"]), t("c", "Mid", ["wasm"])], agg, caps);
    const by = Object.fromEntries(r.slots[0].talks.map((x) => [x.talkId, x]));
    expect(by.a).toMatchObject({ capacityKnown: false, currentCapacity: null, suggestedRoom: null, moved: false, overCapacity: false, demandRank: 1 });
    // The rooms that can be ranked are re-dealt among themselves only.
    expect(by.b).toMatchObject({ suggestedRoom: "Big", moved: false });
    expect(by.c).toMatchObject({ suggestedRoom: "Mid", moved: false });
  });

  it("with no capacities at all, suggests nothing and reports demand order only", () => {
    const r = plan([t("a", "A", ["security"]), t("b", "B", ["kubernetes"])], agg, {});
    expect(r.capacitiesConfigured).toBe(false);
    expect(r.slots[0].talks.map((x) => [x.talkId, x.demandRank, x.suggestedRoom, x.capacityKnown, x.moved, x.overCapacity])).toEqual([
      ["b", 1, null, false, false, false],
      ["a", 2, null, false, false, false],
    ]);
  });

  it("gives zero demand for an empty aggregate and never moves rooms because of it", () => {
    const r = plan([t("a", "Big", ["kubernetes"]), t("b", "Small", ["security"])], [], caps);
    expect(r.slots[0].talks.map((x) => [x.demand, x.moved, x.overCapacity])).toEqual([[0, false, false], [0, false, false]]);
  });

  it("respects suppression: a topic missing from the aggregate adds nothing and is not reconstructed", () => {
    // "wasm" had fewer than MIN_CLUSTER_SIZE attendees, so it is not in the aggregate.
    const r = plan([t("a", "Big", ["wasm", "security"])], agg, caps);
    expect(r.slots[0].talks[0].demand).toBe(12);
    expect(JSON.stringify(r)).not.toMatch(/wasm/);
  });

  it("skips talks with unreadable times and says so", () => {
    const bad = { ...t("x", "Big", []), start: "soon" };
    const r = plan([bad, t("a", "Big", [])], agg, caps);
    expect(r.skippedTalks).toBe(1);
    expect(r.slots[0].talks.map((x) => x.talkId)).toEqual(["a"]);
  });

  it("leaves a double-booked room where it is rather than inventing a second one", () => {
    const r = plan([t("a", "Big", ["kubernetes"]), t("b", "Big", ["security"])], agg, caps);
    expect(r.slots[0].talks.map((x) => x.suggestedRoom)).toEqual(["Big", "Big"]);
  });

  it("carries no attendee identifiers in its output keys", () => {
    const r = plan([t("a", "Big", ["security"])], agg, caps);
    expect(JSON.stringify(r)).not.toMatch(/attendee/i);
  });
});
