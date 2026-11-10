import { describe, expect, it } from "vitest";
import { distanceToRssi, rssiToDistance, smoothPosition, trilaterate, type Reading } from "../src/navigation/trilaterate.js";
import { FLOOR } from "../src/navigation/floor.js";
import { simulatedWalk } from "../src/navigation/positionSource.js";

const at = (x: number, y: number, noise: (i: number) => number = () => 0): Reading[] =>
  FLOOR.receivers.map((r, i) => ({ x: r.x, y: r.y, rssi: distanceToRssi(Math.hypot(r.x - x, r.y - y)) + noise(i) }));

describe("path loss", () => {
  it("round-trips distance and RSSI and reads -59 dBm at one metre", () => {
    expect(distanceToRssi(1)).toBeCloseTo(-59, 6);
    for (const d of [0.5, 3, 12, 30]) expect(rssiToDistance(distanceToRssi(d))).toBeCloseTo(d, 6);
    expect(rssiToDistance(-80)).toBeGreaterThan(rssiToDistance(-70));
  });
});

describe("trilaterate", () => {
  it("recovers a known point from noise-free readings", () => {
    for (const [x, y] of [[8, 11.5], [20.5, 4], [5, 20], [28, 18]] as const) {
      const p = trilaterate(at(x, y))!;
      expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(0.05);
      expect(p.accuracyMeters).toBeGreaterThan(0);
    }
  });
  it("works with exactly three receivers", () => {
    const p = trilaterate(at(10, 10).slice(0, 3))!;
    expect(Math.hypot(p.x - 10, p.y - 10)).toBeLessThan(0.05);
  });
  it("returns null with fewer than three usable readings", () => {
    expect(trilaterate([])).toBeNull();
    expect(trilaterate(at(10, 10).slice(0, 2))).toBeNull();
    const withBad = at(10, 10).slice(0, 2).concat([{ x: 5, y: 5, rssi: NaN }]);
    expect(trilaterate(withBad)).toBeNull();
  });
  it("returns null when the receivers are in a line", () => {
    const line = [0, 5, 10].map((x) => ({ x, y: 0, rssi: distanceToRssi(Math.hypot(x - 3, 4)) }));
    expect(trilaterate(line)).toBeNull();
  });
  it("stays within a bound with 2 dB of noise", () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * 3.46; // uniform, sd about 2 dB
    const errors = [] as number[];
    for (let k = 0; k < 40; k++) {
      const x = 3 + (k * 7) % 28, y = 2 + (k * 5) % 20;
      const p = trilaterate(at(x, y, rand))!;
      errors.push(Math.hypot(p.x - x, p.y - y));
    }
    expect(errors.reduce((a, b) => a + b, 0) / errors.length).toBeLessThan(5);
    expect(Math.max(...errors)).toBeLessThan(12);
  });
});

describe("smoothPosition", () => {
  it("moves a fraction of the way and passes the first fix through", () => {
    const first = { x: 0, y: 0, accuracyMeters: 2 };
    expect(smoothPosition(null, first)).toBe(first);
    const next = smoothPosition(first, { x: 10, y: 20, accuracyMeters: 4 }, 0.5);
    expect(next).toEqual({ x: 5, y: 10, accuracyMeters: 3 });
  });
});

describe("simulatedWalk", () => {
  it("is labelled, repeatable, finite, and tracked within a few metres", () => {
    const walk = simulatedWalk();
    expect(walk.label).toBe("Simulated signals");
    const first = walk.next();
    walk.reset();
    expect(walk.next()).toEqual(first);
    walk.reset();
    let steps = 0, worst = 0;
    while (!walk.done && steps++ < 200) {
      const readings = walk.next().map((r) => { const rx = FLOOR.receivers.find((a) => a.id === r.receiverId)!; return { x: rx.x, y: rx.y, rssi: r.rssi }; });
      const p = trilaterate(readings)!;
      const t = walk.truth();
      worst = Math.max(worst, Math.hypot(p.x - t.x, p.y - t.y));
    }
    expect(walk.done).toBe(true);
    expect(steps).toBeGreaterThan(20);
    expect(worst).toBeLessThan(8);
  });
});
