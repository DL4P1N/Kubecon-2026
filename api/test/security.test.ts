import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, type ServerDeps } from "../src/server.js";
import { AGGREGATE_CACHE_MS } from "../src/routes/interests.js";
import { CATALOG_CACHE_MS } from "../src/routes/catalog.js";
import { BODY_LIMIT_BYTES, MAX_ANSWER_ITEMS, MAX_ANSWER_ITEM_LENGTH, MAX_FREE_TEXT_LENGTH, MAX_RAW_ANSWER_ITEMS } from "../src/routes/search.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import type { Db } from "../src/db/client.js";
import { insertTalks, testDb } from "./pg.js";
import { talk } from "./helpers.js";

const A = talk("a", 9, 10, { tags: ["security"] });
const NO_EXPIRY = "9999-12-31T23:59:59.999Z";

const sharedDb = await testDb();
await insertTalks(sharedDb, [{ ...A, level: "beginner" }]);
// 12 consenting attendees interested in kubernetes: above the aggregate's k-anonymity floor.
for (let i = 0; i < 12; i++) {
  await sharedDb.query(
    "insert into attendees (id, display_name, interests, consent_cluster_map, consent_qr_checkin, created_at, expires_at) values ($1, 'x', array['kubernetes'], true, true, now(), $2)",
    [`seed-${i}`, NO_EXPIRY],
  );
}

/** Server over the shared database; `queries` counts every SQL statement the routes ran. */
function setup(deps: Omit<ServerDeps, "db" | "embedder"> = {}) {
  const queries: string[] = [];
  const db: Db = {
    ...sharedDb,
    query: ((sql: string, params?: readonly unknown[]) => { queries.push(sql); return sharedDb.query(sql, params); }) as Db["query"],
  };
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { db, embedder: new LocalHashEmbedder(), ...deps });
  return { app, db, queries };
}

describe("shared rate-limit policy", () => {
  const cases = [
    { name: "search", limits: { search: { max: 2 } }, req: { method: "GET" as const, url: "/api/search?q=kubernetes" } },
    { name: "catalog topics", limits: { catalogTopics: { max: 2 } }, req: { method: "GET" as const, url: "/api/catalog/topics" } },
    { name: "status", limits: { status: { max: 2 } }, req: { method: "GET" as const, url: "/api/status" } },
    { name: "interests aggregate", limits: { interestsAggregate: { max: 2 } }, req: { method: "GET" as const, url: "/api/interests/aggregate" } },
    { name: "interests clusters", limits: { interestsClusters: { max: 2 } }, req: { method: "GET" as const, url: "/api/interests/clusters" } },
    {
      name: "onboarding",
      limits: { onboarding: { max: 2 } },
      req: { method: "POST" as const, url: "/api/onboarding", payload: { answers: { topics: [] } } },
    },
  ];

  it.each(cases)("answers 429 with the shared JSON shape on $name after the limit", async ({ limits, req }) => {
    const { app } = setup({ rateLimits: limits });
    try {
      for (let i = 0; i < 2; i++) expect((await app.inject(req)).statusCode).toBe(200);
      const res = await app.inject(req);
      expect(res.statusCode).toBe(429);
      expect(Object.keys(res.json()).sort()).toEqual(["error", "message", "statusCode"]);
      expect(res.json()).toMatchObject({ statusCode: 429, error: "rate_limited" });
      expect(res.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("uses one 429 body shape in every scope (default and custom error handlers)", async () => {
    // search and suggest have custom error handlers; status, register and access use Fastify's default.
    const app = buildServer(loadConfig({ NODE_ENV: "test", REGISTER_RATE_LIMIT_PER_MINUTE: "1" } as NodeJS.ProcessEnv), {
      db: sharedDb,
      embedder: new LocalHashEmbedder(),
      rateLimits: { search: { max: 1 }, status: { max: 1 } },
    });
    try {
      const reqs = [
        { method: "GET" as const, url: "/api/search?q=k8s" },
        { method: "GET" as const, url: "/api/status" },
        { method: "POST" as const, url: "/api/register", payload: {} },
      ];
      const shapes = [];
      for (const req of reqs) {
        await app.inject(req);
        const res = await app.inject(req);
        expect(res.statusCode).toBe(429);
        const body = res.json() as Record<string, unknown>;
        shapes.push({ keys: Object.keys(body).sort(), statusCode: body.statusCode, error: body.error });
      }
      // suggest: 120/min default, so exhaust it.
      let last;
      for (let i = 0; i < 121; i++) last = await app.inject({ method: "GET", url: "/api/suggest?q=kub" });
      expect(last!.statusCode).toBe(429);
      const s = last!.json() as Record<string, unknown>;
      shapes.push({ keys: Object.keys(s).sort(), statusCode: s.statusCode, error: s.error });
      for (const shape of shapes) expect(shape).toEqual({ keys: ["error", "message", "statusCode"], statusCode: 429, error: "rate_limited" });
    } finally {
      await app.close();
    }
  });

  it("keys buckets per client IP", async () => {
    const { app } = setup({ rateLimits: { search: { max: 1 } } });
    try {
      const from = (ip: string) => app.inject({ method: "GET", url: "/api/search?q=k8s", remoteAddress: ip });
      expect((await from("198.51.100.1")).statusCode).toBe(200);
      expect((await from("198.51.100.1")).statusCode).toBe(429);
      expect((await from("198.51.100.2")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("never limits /healthz", async () => {
    const { app } = setup({ rateLimits: { search: { max: 1 }, status: { max: 1 } } });
    try {
      for (let i = 0; i < 50; i++) expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("aggregate caching", () => {
  it("serves a second request from memory, without another database query, until the window passes", async () => {
    let clock = Date.UTC(2026, 10, 10, 9);
    const { app, queries } = setup({ search: { now: () => new Date(clock) } });
    try {
      const first = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(first.statusCode).toBe(200);
      const attendeeQueries = () => queries.filter((q) => /attendees/.test(q)).length;
      expect(attendeeQueries()).toBeGreaterThan(0);
      const afterFirst = attendeeQueries();

      const second = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(second.json()).toEqual(first.json());
      expect(second.headers["cache-control"]).toBe(`public, max-age=${AGGREGATE_CACHE_MS / 1000}`);
      expect(attendeeQueries()).toBe(afterFirst);

      clock += AGGREGATE_CACHE_MS;
      await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(attendeeQueries()).toBeGreaterThan(afterFirst);
    } finally {
      await app.close();
    }
  });
});

describe("catalog caching", () => {
  it("serves catalog topics from memory within the cache window and refreshes after it", async () => {
    let clock = Date.UTC(2026, 10, 10, 9);
    const { app } = setup({ search: { now: () => new Date(clock) } });
    try {
      const first = await app.inject({ method: "GET", url: "/api/catalog/topics" });
      expect(first.json()).toEqual({ topics: ["security"] });
      await insertTalks(sharedDb, [{ ...talk("b", 11, 12, { tags: ["observability"] }), level: "beginner" }]);
      try {
        expect((await app.inject({ method: "GET", url: "/api/catalog/topics" })).json()).toEqual({ topics: ["security"] });
        clock += CATALOG_CACHE_MS;
        expect((await app.inject({ method: "GET", url: "/api/catalog/topics" })).json().topics).toContain("observability");
      } finally {
        await sharedDb.query("delete from talks where id = 'b'");
      }
    } finally {
      await app.close();
    }
  });
});

describe("input validation", () => {
  const post = (app: ReturnType<typeof setup>["app"], answers: unknown) =>
    app.inject({ method: "POST", url: "/api/onboarding", payload: { answers } });

  it("rejects oversized onboarding answers without echoing them", async () => {
    const { app, queries } = setup();
    try {
      const canary = "CANARY-" + "x".repeat(MAX_FREE_TEXT_LENGTH);
      const long = await post(app, { topics: ["security"], freeText: canary });
      expect(long.statusCode).toBe(400);
      expect(long.json()).toMatchObject({ error: "invalid_request" });
      expect(long.body).not.toContain("CANARY");

      expect((await post(app, { topics: ["y".repeat(101)] })).statusCode).toBe(400);
      expect((await post(app, { topics: [], goals: ["z".repeat(101)] })).statusCode).toBe(400);
      expect(queries).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("names the field when a topic or goal entry is not a string", async () => {
    const { app } = setup();
    try {
      const topics = await post(app, { topics: [1] });
      expect(topics.statusCode).toBe(400);
      expect(topics.json()).toEqual({ error: "invalid_request", message: "answers.topics must be an array of strings" });
      const goals = await post(app, { topics: [], goals: [true] });
      expect(goals.json()).toEqual({ error: "invalid_request", message: "answers.goals must be an array of strings" });
    } finally {
      await app.close();
    }
  });

  it("keeps the first 20 topics instead of rejecting a longer selection", async () => {
    const { app } = setup();
    try {
      const topics = Array.from({ length: MAX_ANSWER_ITEMS + 5 }, (_, i) => `topic${i}`);
      const res = await post(app, { topics });
      expect(res.statusCode).toBe(200);
      const kept = (res.json() as { query: { topics: string[] } }).query.topics;
      expect(kept).toHaveLength(MAX_ANSWER_ITEMS);
      expect(kept).toContain(`topic${MAX_ANSWER_ITEMS - 1}`);
      expect(kept).not.toContain(`topic${MAX_ANSWER_ITEMS}`);
    } finally {
      await app.close();
    }
  });

  it("rejects bodies over the onboarding body limit with 413", async () => {
    const { app } = setup();
    try {
      const res = await post(app, { topics: [], filler: "x".repeat(BODY_LIMIT_BYTES) });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: "payload_too_large", message: "request body too large" });
    } finally {
      await app.close();
    }
  });

  it("answers the largest valid tag set (1000 x 100 chars) instead of 413, and rejects more with a clean 400", async () => {
    const { app } = setup();
    try {
      const tags = (n: number) => Array.from({ length: n }, (_, i) => `${i}-`.padEnd(MAX_ANSWER_ITEM_LENGTH, "t"));
      const largest = await post(app, { topics: tags(MAX_RAW_ANSWER_ITEMS), goals: tags(MAX_ANSWER_ITEMS), freeText: "f".repeat(MAX_FREE_TEXT_LENGTH) });
      expect(largest.statusCode).toBe(200);
      const tooMany = await post(app, { topics: tags(MAX_RAW_ANSWER_ITEMS + 1) });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json()).toEqual({ error: "invalid_request", message: `answers.topics must have at most ${MAX_RAW_ANSWER_ITEMS} entries` });
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized search query", async () => {
    const { app } = setup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/search?q=${"q".repeat(501)}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
    } finally {
      await app.close();
    }
  });
});

describe("unknown routes", () => {
  it("answers 404 with a fixed body that does not echo the path or query", async () => {
    const { app } = setup();
    try {
      const res = await app.inject({ method: "GET", url: "/api/nope-CANARY?attendee=CANARY2" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found", message: "route not found" });
      expect(res.body).not.toContain("CANARY");
    } finally {
      await app.close();
    }
  });
});
