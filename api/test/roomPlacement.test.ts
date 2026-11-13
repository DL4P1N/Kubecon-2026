import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { RoomPlacementResponse } from "@cc/shared";
import { registerRoomPlacementRoutes } from "../src/routes/roomPlacement.js";
import { parseRoomCapacities, loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { failingDb, mk, recordingDb, seededDb } from "./search-fixtures.js";

/** 12 opted-in attendees on kubernetes, 7 on security, 2 on wasm (suppressed by the real aggregate code), plus two talks in one slot. */
async function setup(talks = [
  mk("sec", 9, 10, { room: "Big", tags: ["security"] }),
  mk("k8s", 9, 10, { room: "Small", tags: ["kubernetes", "wasm"] }),
]) {
  const db = recordingDb(await seededDb(talks));
  const groups: [string, number][] = [["kubernetes", 12], ["security", 7], ["wasm", 2]];
  let n = 0;
  for (const [topic, count] of groups) {
    for (let i = 0; i < count; i++) {
      await db.query(
        `insert into attendees (id, display_name, interests, consent_cluster_map, created_at, expires_at)
         values ($1, 'x', $2::text[], true, now(), '9999-12-31T23:59:59Z')`,
        [`att-${n++}`, [topic]],
      );
    }
  }
  db.statements.length = 0;
  return db;
}
const caps = { Big: 100, Small: 10 };
const URL = "/api/rooms/placement";

describe("GET /api/rooms/placement", () => {
  it("requires the organizer key: 401 without or with a wrong key", async () => {
    const app = Fastify();
    const db = await setup();
    registerRoomPlacementRoutes(app, { db, roomCapacities: caps, organizerKey: "s3cret-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", nodeEnv: "production" });
    expect((await app.inject({ url: URL })).statusCode).toBe(401);
    expect((await app.inject({ url: URL, headers: { "x-organizer-key": "nope" } })).statusCode).toBe(401);
    expect(db.statements).toHaveLength(0); // nothing is read before authorization
  });

  it("hides the route (404) in production when no key is configured", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: await setup(), nodeEnv: "production", organizerKey: undefined });
    expect((await app.inject({ url: URL })).statusCode).toBe(404);
  });

  it("answers 200 with slots, demand from suppressed counts and suggestions", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: await setup(), roomCapacities: caps, organizerKey: "s3cret-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", nodeEnv: "production" });
    const res = await app.inject({ url: URL, headers: { "x-organizer-key": "s3cret-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk" } });
    expect(res.statusCode).toBe(200);
    const body = res.json<RoomPlacementResponse>();
    expect(body).toMatchObject({ suppressedBelow: 5, capacitiesConfigured: true, skippedTalks: 0 });
    expect(body.slots).toHaveLength(1);
    const [first, second] = body.slots[0].talks;
    // wasm (2 attendees) is under k, so it adds nothing: k8s demand is 12, security 7.
    expect(first).toMatchObject({ talkId: "k8s", demand: 12, demandRank: 1, currentRoom: "Small", suggestedRoom: "Big", moved: true, overCapacity: true });
    expect(second).toMatchObject({ talkId: "sec", demand: 7, suggestedRoom: "Small", moved: true, overCapacity: false });
    expect(JSON.stringify(body)).not.toMatch(/attendee|wasm/i);
  });

  it("reports unknown capacity instead of inventing one", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: await setup(), organizerKey: "s3cret-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", nodeEnv: "production" });
    const body = (await app.inject({ url: URL, headers: { "x-organizer-key": "s3cret-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk" } })).json<RoomPlacementResponse>();
    expect(body.capacitiesConfigured).toBe(false);
    expect(body.slots[0].talks.every((x) => !x.capacityKnown && x.suggestedRoom === null)).toBe(true);
  });

  it("is open without a key outside production, like the clusters route", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: await setup(), nodeEnv: "test", organizerKey: undefined });
    expect((await app.inject({ url: URL })).statusCode).toBe(200);
  });

  it("answers 502 with a fixed body when the database fails, without echoing it", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: failingDb({ code: "XX000", message: "secret query text" }), nodeEnv: "test" });
    const res = await app.inject({ url: URL });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "placement_unavailable" });
    expect(res.body).not.toContain("secret");
  });

  it("is rate limited with the shared 429 body", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { db: await setup(), nodeEnv: "test", rateLimit: { max: 1 } });
    expect((await app.inject({ url: URL })).statusCode).toBe(200);
    const res = await app.inject({ url: URL });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ statusCode: 429, error: "rate_limited" });
  });

  it("is registered by buildServer with capacities from config", async () => {
    const app = buildServer(loadConfig({ NODE_ENV: "test", ROOM_CAPACITIES: JSON.stringify(caps) } as NodeJS.ProcessEnv), { db: await setup(), embedder: new LocalHashEmbedder() });
    const body = (await app.inject({ url: URL })).json<RoomPlacementResponse>();
    expect(body.capacitiesConfigured).toBe(true);
    await app.close();
  });
});

describe("ROOM_CAPACITIES", () => {
  it("parses a JSON map and treats unset or blank as no capacities", () => {
    expect(parseRoomCapacities('{"Hall A": 400}')).toEqual({ "Hall A": 400 });
    expect(parseRoomCapacities(undefined)).toEqual({});
    expect(parseRoomCapacities("  ")).toEqual({});
  });
  it("rejects malformed values rather than guessing", () => {
    for (const bad of ["nope", "[1]", '{"A": 0}', '{"A": "10"}', '{"A": 1.5}', '{"": 5}', "null"]) {
      expect(() => parseRoomCapacities(bad), bad).toThrow(/ROOM_CAPACITIES/);
    }
  });
});
