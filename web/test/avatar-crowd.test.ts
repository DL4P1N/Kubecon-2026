import { describe, expect, it } from "vitest";
import { AVATAR_KEY, DEFAULT_AVATAR, loadAvatar, parseAvatar, spriteRects, SPRITE_H, SPRITE_W } from "../src/navigation/avatar.js";
import { createCrowd } from "../src/navigation/crowd.js";
import { FLOOR, resolveRoom } from "../src/navigation/floor.js";

const good = { skin: "F1C9A5", hair: "5a3a1e", shirt: "c6f19d", pants: "24324a", hat: true };
const store = (value: string | null) => ({ getItem: (key: string) => (key === AVATAR_KEY ? value : null) });

describe("avatar validation", () => {
  it("accepts six-digit hex colours and a boolean hat, lower-casing the colours", () => {
    expect(parseAvatar(good)).toEqual({ ...good, skin: "f1c9a5" });
    expect(parseAvatar({ ...good, extra: 1 })).not.toBeNull();
  });
  it.each([
    ["a leading #", { ...good, skin: "#f1c9a5" }], ["three digits", { ...good, hair: "fff" }], ["non-hex", { ...good, shirt: "gggggg" }],
    ["a number", { ...good, pants: 123456 }], ["a string hat", { ...good, hat: "true" }], ["a missing field", { skin: "f1c9a5", hair: "5a3a1e", shirt: "c6f19d", pants: "24324a" }],
    ["null", null], ["an array", [good]], ["a string", "x"],
  ])("rejects %s", (_name, value) => expect(parseAvatar(value)).toBeNull());
  it("loads from storage and falls back to the default for missing, invalid or unreadable values", () => {
    expect(loadAvatar(store(JSON.stringify(good)))).toEqual({ ...good, skin: "f1c9a5" });
    expect(loadAvatar(store(null))).toBe(DEFAULT_AVATAR);
    expect(loadAvatar(store("{not json"))).toBe(DEFAULT_AVATAR);
    expect(loadAvatar(store(JSON.stringify({ ...good, hair: "zz" })))).toBe(DEFAULT_AVATAR);
    expect(loadAvatar({ getItem: () => { throw new Error("blocked"); } })).toBe(DEFAULT_AVATAR);
  });
  it("draws inside an 8 x 12 grid, with a cap only when asked", () => {
    for (const hat of [false, true]) {
      const rects = spriteRects({ ...DEFAULT_AVATAR, hat });
      expect(rects.length).toBeGreaterThan(10);
      for (const r of rects) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(SPRITE_W); expect(r.y).toBeLessThan(SPRITE_H); }
    }
    expect(spriteRects({ ...DEFAULT_AVATAR, hat: true })[0]!.fill).toBe(`#${DEFAULT_AVATAR.shirt}`);
    expect(spriteRects({ ...DEFAULT_AVATAR, hat: false })[0]!.fill).toBe(`#${DEFAULT_AVATAR.hair}`);
  });
});

describe("destination aliases", () => {
  it("maps the site's venue ids onto the plan and passes real ids through", () => {
    expect(resolveRoom("stage")).toBe("main-stage");
    expect(resolveRoom("keynote")).toBe("main-stage");
    expect(resolveRoom("scan")).toBe("room-b");
    expect(resolveRoom("room-c")).toBe("room-b");
    expect(resolveRoom("room-d")).toBe("lounge");
    expect(resolveRoom("room-a")).toBe("room-a");
    expect(resolveRoom("lounge")).toBe("lounge");
    expect(resolveRoom("Stage")).toBe("main-stage");
  });
  it("rejects unknown ids, including object-prototype names", () => {
    for (const bad of ["nowhere", "", null, undefined, "constructor", "__proto__", "toString"]) expect(resolveRoom(bad)).toBeNull();
  });
});

describe("simulated attendees", () => {
  const run = (seed: number, ticks: number) => { const c = createCrowd({ seed }); for (let i = 0; i < ticks; i++) c.step(); return c.people(); };
  it("is deterministic for a seed, varies between seeds, and has 14 to 18 varied people", () => {
    expect(run(11, 40)).toEqual(run(11, 40));
    expect(run(11, 40)).not.toEqual(run(12, 40));
    const people = run(11, 0);
    expect(people.length).toBeGreaterThanOrEqual(14);
    expect(people.length).toBeLessThanOrEqual(18);
    expect(new Set(people.map((p) => JSON.stringify(p.avatar))).size).toBeGreaterThan(8);
  });
  it("moves along the graph, stays on the plan, and reset restores the start", () => {
    const c = createCrowd();
    const start = c.people();
    let moved = 0;
    for (let i = 0; i < 120; i++) {
      c.step();
      for (const p of c.people()) { expect(p.x).toBeGreaterThanOrEqual(-0.01); expect(p.x).toBeLessThanOrEqual(FLOOR.width + 0.01); expect(p.y).toBeGreaterThanOrEqual(-0.01); expect(p.y).toBeLessThanOrEqual(FLOOR.height + 0.01); }
    }
    for (const [i, p] of c.people().entries()) if (Math.hypot(p.x - start[i]!.x, p.y - start[i]!.y) > 1) moved++;
    expect(moved).toBeGreaterThan(c.people().length / 2);
    c.reset();
    expect(c.people()).toEqual(start);
  });
});
