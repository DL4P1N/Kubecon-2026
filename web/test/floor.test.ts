import { describe, expect, it } from "vitest";
import { FLOOR, clampToFloor, roomAt, route } from "../src/navigation/floor.js";

describe("roomAt", () => {
  it("finds the six areas and nothing outside the plan", () => {
    expect(roomAt(8, 4)?.id).toBe("main-stage");
    expect(roomAt(20, 4)?.id).toBe("room-a");
    expect(roomAt(30, 4)?.id).toBe("room-b");
    expect(roomAt(17, 11)?.id).toBe("hallway");
    expect(roomAt(5, 20)?.id).toBe("lobby");
    expect(roomAt(25, 20)?.id).toBe("lounge");
    expect(roomAt(-1, 5)).toBeNull();
    expect(roomAt(34, 24)?.id).toBe("lounge");
    expect(FLOOR.rooms).toHaveLength(6);
  });
  it("clamps to the plan", () => expect(clampToFloor({ x: -3, y: 40 })).toEqual({ x: 0, y: 24 }));
});

describe("route", () => {
  it("goes through the hallway and the door, by the shortest way", () => {
    const r = route({ x: 6.5, y: 19 }, "room-a")!;
    // lobby -> lobby entrance (5) -> hallway (2.5) -> along to x=20.5 (14) -> door (2.5) -> room (4.5)
    expect(r.meters).toBeCloseTo(5 + 2.5 + 14 + 2.5 + 4.5, 5);
    expect(r.points.at(-1)).toEqual({ x: 20.5, y: 4.5 });
    expect(r.steps.length).toBeGreaterThanOrEqual(3);
    expect(r.steps[0]!.text).toMatch(/^Head north/);
    expect(r.steps.some((s) => /Turn right and walk east/.test(s.text))).toBe(true);
    expect(r.steps.at(-1)!.text).toMatch(/Turn left and walk north/);
    expect(r.arrived).toBe(false);
  });
  it("stays inside the room you are in and reports arrival", () => {
    const r = route({ x: 20, y: 5 }, "room-a")!;
    expect(r.arrived).toBe(true);
    expect(r.meters).toBeCloseTo(1, 5);
  });
  it("routes from the lounge to the stage the short way round", () => {
    const r = route({ x: 20.5, y: 19 }, "main-stage")!;
    expect(r.meters).toBeCloseTo(5 + 2.5 + 3.5 + 9 + 2.5 + 4.5, 5);
  });
  it("joins the corridor where you stand and never starts by walking the wrong way", () => {
    const r = route({ x: 14.6, y: 11.4 }, "main-stage")!; // between the stage door (x=8) and the hallway middle (x=17)
    expect(r.meters).toBeCloseTo(0.1 + 6.6 + 2.5 + 4.5, 1);
    expect(r.steps[0]!.text).toMatch(/^Head west/);
    expect(r.steps).toHaveLength(2);
  });
  it("returns null for an unknown room", () => expect(route({ x: 1, y: 1 }, "room-z")).toBeNull());
});
