import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { RoomPlacementResponse } from "@cc/shared";
import { registerRoomPlacementRoutes } from "../src/routes/roomPlacement.js";
import { parseRoomCapacities, loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { esHit, fakeEs, talk } from "./helpers.js";

/** Fake ES: 12 attendees on kubernetes, 7 on security, 2 on wasm (suppressed by the real aggregate code). */
function setup() {
  return fakeEs((call) => {
    if (call.path === "/attendees/_search") {
      return {
        body: {
          hits: { total: { value: 20 }, hits: [] },
          aggregations: { topics: { buckets: [
            { key: "kubernetes", doc_count: 12 }, { key: "security", doc_count: 7 }, { key: "wasm", doc_count: 2 },
          ] } },
        },
      };
    }
    if (call.path === "/attendees/_count") return { body: { count: 2 } };
    if (call.path === "/talks/_search") {
      return { body: { hits: { hits: [
        esHit(talk("sec", 9, 10, { room: "Big", tags: ["security"] }), 1),
        esHit(talk("k8s", 9, 10, { room: "Small", tags: ["kubernetes", "wasm"] }), 1),
      ] } } };
    }
    return undefined;
  });
}
const caps = { Big: 100, Small: 10 };
const URL = "/api/rooms/placement";

describe("GET /api/rooms/placement", () => {
  it("requires the organizer key: 401 without or with a wrong key", async () => {
    const app = Fastify();
    const es = setup();
    registerRoomPlacementRoutes(app, { es, roomCapacities: caps, organizerKey: "s3cret", nodeEnv: "production" });
    expect((await app.inject({ url: URL })).statusCode).toBe(401);
    expect((await app.inject({ url: URL, headers: { "x-organizer-key": "nope" } })).statusCode).toBe(401);
    expect(es.calls).toHaveLength(0); // nothing is read before authorization
  });

  it("refuses in production when no key is configured (503)", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { es: setup(), nodeEnv: "production", organizerKey: undefined });
    expect((await app.inject({ url: URL })).statusCode).toBe(503);
  });

  it("answers 200 with slots, demand from suppressed counts and suggestions", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { es: setup(), roomCapacities: caps, organizerKey: "s3cret", nodeEnv: "production" });
    const res = await app.inject({ url: URL, headers: { "x-organizer-key": "s3cret" } });
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
    registerRoomPlacementRoutes(app, { es: setup(), organizerKey: "s3cret", nodeEnv: "production" });
    const body = (await app.inject({ url: URL, headers: { "x-organizer-key": "s3cret" } })).json<RoomPlacementResponse>();
    expect(body.capacitiesConfigured).toBe(false);
    expect(body.slots[0].talks.every((x) => !x.capacityKnown && x.suggestedRoom === null)).toBe(true);
  });

  it("is open without a key outside production, like the clusters route", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { es: setup(), nodeEnv: "test", organizerKey: undefined });
    expect((await app.inject({ url: URL })).statusCode).toBe(200);
  });

  it("answers 502 with a fixed body when Elasticsearch fails, without echoing it", async () => {
    const app = Fastify();
    const failing = fakeEs(() => ({ status: 500, body: { error: "secret query text" } }));
    registerRoomPlacementRoutes(app, { es: failing, nodeEnv: "test" });
    const res = await app.inject({ url: URL });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "placement_unavailable" });
  });

  it("is rate limited with the shared 429 body", async () => {
    const app = Fastify();
    registerRoomPlacementRoutes(app, { es: setup(), nodeEnv: "test", rateLimit: { max: 1 } });
    expect((await app.inject({ url: URL })).statusCode).toBe(200);
    const res = await app.inject({ url: URL });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ statusCode: 429, error: "rate_limited" });
  });

  it("is registered by buildServer with capacities from config", async () => {
    const app = buildServer(loadConfig({ NODE_ENV: "test", ROOM_CAPACITIES: JSON.stringify(caps) } as NodeJS.ProcessEnv), { es: setup() });
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
