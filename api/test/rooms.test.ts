import { expect, it } from "vitest";
import { RoomActivityCounter } from "../src/rooms/activity.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { failingDb, mk, recordingDb, seededDb } from "./search-fixtures.js";
import Fastify from "fastify";
import { registerRoomRoutes } from "../src/routes/rooms.js";

const roomTalks = (...rooms: string[]) => rooms.map((room, i) => mk(`r${i}`, 9, 10, { room }));
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
it("rate limits before querying the database", async () => {
  const db = recordingDb(await seededDb([]));
  const app = Fastify();
  registerRoomRoutes(app, db, new RoomActivityCounter(), 2);
  try {
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(200);
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(200);
    expect((await app.inject("/api/rooms/occupancy")).statusCode).toBe(429);
    expect(db.statements).toHaveLength(1);
  } finally { await app.close(); }
});
it("caches catalog rooms for one minute while scan activity stays fresh", async () => {
  let now = 0;
  const db = recordingDb(await seededDb(roomTalks("A")));
  const counter = new RoomActivityCounter(() => now);
  const app = Fastify();
  registerRoomRoutes(app, db, counter, 120, () => now);
  try {
    const first = await app.inject("/api/rooms/occupancy");
    expect(first.json().rooms[0]).toEqual({ room: "A", level: "quiet" });
    expect(first.headers["cache-control"]).toBe("no-store");
    for (let i = 0; i < 5; i++) counter.recordAllowed("A");
    expect((await app.inject("/api/rooms/occupancy")).json().rooms[0]).toEqual({ room: "A", level: "some recent check-ins" });
    expect(db.statements).toHaveLength(1);
    now = 60_000;
    await app.inject("/api/rooms/occupancy");
    expect(db.statements).toHaveLength(2);
  } finally { await app.close(); }
});
it("public polling cannot reveal each additional scan within a coarse level", async () => {
  const counter = new RoomActivityCounter();
  const app = Fastify();
  registerRoomRoutes(app, await seededDb(roomTalks("A")), counter);
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
it("public occupancy returns catalog rooms only and handles database failure safely", async () => {
  const counter = new RoomActivityCounter();
  counter.recordAllowed("not-in-catalog");
  const embedder = new LocalHashEmbedder();
  const app = buildServer(loadConfig({}), { roomActivity: counter, embedder,
    db: await seededDb([...roomTalks("B", "A", "A"), mk("none", 9, 10, { room: "" })]) });
  try {
    const response = await app.inject("/api/rooms/occupancy");
    expect(response.statusCode).toBe(200);
    expect(response.json().rooms.map((item: { room: string }) => item.room)).toEqual(["A", "B"]);
    expect(response.body).not.toContain("not-in-catalog");
  } finally { await app.close(); }
  const down = buildServer(loadConfig({}), { embedder, db: failingDb({ code: "ECONNREFUSED", message: "secret" }) });
  try {
    const response = await down.inject("/api/rooms/occupancy");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "room_activity_unavailable" });
    expect(response.body).not.toContain("secret");
  } finally { await down.close(); }
});
