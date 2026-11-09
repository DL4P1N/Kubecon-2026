import { expect, it } from "vitest";
import { RoomActivityCounter, roomCapacities } from "../src/rooms/activity.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeEs } from "./helpers.js";

it("suppresses counts and percentages for every count below five", () => {
  const counter = new RoomActivityCounter(new Map([["A", 10]]), () => 0);
  for (let count = 0; count < 5; count++) {
    expect(counter.snapshot(["A"]).rooms[0]).toEqual({ room: "A", level: "quiet", recentScans: null, percentage: null, capacity: 10 });
    counter.recordAllowed("A");
  }
  expect(counter.snapshot(["A"]).rooms[0]).toMatchObject({ level: "busy", recentScans: 5, percentage: 50 });
  for (let i = 0; i < 3; i++) counter.recordAllowed("A");
  expect(counter.snapshot(["A"]).rooms[0]).toMatchObject({ level: "almost full", percentage: 80 });
});
it("expires old minute buckets and never fabricates unknown capacity", () => {
  let now = 0;
  const counter = new RoomActivityCounter(new Map(), () => now);
  for (let i = 0; i < 5; i++) counter.recordAllowed("A");
  expect(counter.snapshot(["A"]).rooms[0]).toMatchObject({ level: "busy", capacity: null, percentage: null, recentScans: 5 });
  now = 10 * 60 * 1000;
  expect(counter.snapshot(["A"]).rooms[0]).toMatchObject({ level: "quiet", recentScans: null });
});
it("validates configured capacities", () => {
  expect(roomCapacities('{"A":20}').get("A")).toBe(20);
  for (const raw of ['[]', 'null', '{"A":0}', '{"A":2.5}', '{"A":"10"}']) expect(() => roomCapacities(raw)).toThrow();
});
it("public occupancy returns catalog rooms only and handles ES failure safely", async () => {
  const counter = new RoomActivityCounter();
  counter.recordAllowed("not-in-catalog");
  const app = buildServer(loadConfig({}), { roomActivity: counter,
    es: fakeEs(() => ({ body: { aggregations: { rooms: { buckets: [{ key: "A" }, { key: "B" }] } } } })) });
  try {
    const response = await app.inject("/api/rooms/occupancy");
    expect(response.statusCode).toBe(200);
    expect(response.json().rooms.map((item: { room: string }) => item.room)).toEqual(["A", "B"]);
    expect(response.body).not.toContain("not-in-catalog");
  } finally { await app.close(); }
  const down = buildServer(loadConfig({}), { es: fakeEs(() => ({ status: 503, body: {} })) });
  try {
    const response = await down.inject("/api/rooms/occupancy");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "room_activity_unavailable" });
  } finally { await down.close(); }
});
