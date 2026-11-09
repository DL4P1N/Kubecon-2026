import { expect, it } from "vitest";
import { RoomActivityCounter } from "../src/rooms/activity.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeEs } from "./helpers.js";
import Fastify from "fastify";
import { registerRoomRoutes } from "../src/routes/rooms.js";

it("publishes only coarse levels, never exact counts, percentages or capacity", () => {
  const counter = new RoomActivityCounter(() => 0);
  for (let count = 0; count <= 50; count++) {
    const level = count < 5 ? "quiet" : count < 20 ? "some recent check-ins" : "many recent check-ins";
    expect(counter.snapshot(["A"]).rooms[0]).toEqual({ room: "A", level });
    counter.recordAllowed("A");
  }
});
it("suppresses after summing minute buckets and after older buckets expire", () => {
  let now = 0;
  const counter = new RoomActivityCounter(() => now);
  for (let i = 0; i < 3; i++) counter.recordAllowed("A");
  now = 60_000;
  counter.recordAllowed("A");
  expect(counter.snapshot(["A"]).rooms[0]).toEqual({ room: "A", level: "quiet" });
  counter.recordAllowed("A");
  expect(counter.snapshot(["A"]).rooms[0]).toEqual({ room: "A", level: "some recent check-ins" });
  now = 10 * 60 * 1000;
  expect(counter.snapshot(["A"]).rooms[0]).toEqual({ room: "A", level: "quiet" });
});
it("rate limits before querying Elasticsearch", async () => {
  const es = fakeEs(() => ({ body: { aggregations: { rooms: { buckets: [] } } } }));
  const app = Fastify();
  registerRoomRoutes(app, es, new RoomActivityCounter(), 2);
  try {
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(200);
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(200);
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(429);
    expect(es.calls).toHaveLength(1);
  } finally { await app.close(); }
});
it("caches catalog rooms for one minute while scan activity stays fresh", async () => {
  let now = 0;
  const es = fakeEs(() => ({ body: { aggregations: { rooms: { buckets: [{ key: "A" }] } } } }));
  const counter = new RoomActivityCounter(() => now);
  const app = Fastify();
  registerRoomRoutes(app, es, counter, 120, () => now);
  try {
    const first = await app.inject("/api/rooms/occupancy");
    expect(first.json().rooms[0]).toEqual({ room: "A", level: "quiet" });
    expect(first.headers["cache-control"]).toBe("no-store");
    for (let i = 0; i < 5; i++) counter.recordAllowed("A");
    expect((await app.inject("/api/rooms/occupancy")).json().rooms[0]).toEqual({ room: "A", level: "some recent check-ins" });
    expect(es.calls).toHaveLength(1);
    now = 60_000;
    await app.inject("/api/rooms/occupancy");
    expect(es.calls).toHaveLength(2);
  } finally { await app.close(); }
});
it("public polling cannot reveal each additional scan within a coarse level", async () => {
  const counter = new RoomActivityCounter();
  const app = Fastify();
  registerRoomRoutes(app, fakeEs(() => ({ body: { aggregations: { rooms: { buckets: [{ key: "A" }] } } } })), counter);
  try {
    let previous = "";
    for (let count = 0; count <= 25; count++) {
      const response = await app.inject("/api/rooms/occupancy");
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json().rooms[0]).sort()).toEqual(["level", "room"]);
      if (![0, 5, 20].includes(count)) expect(response.body).toBe(previous);
      previous = response.body;
      counter.recordAllowed("A");
    }
  } finally { await app.close(); }
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
