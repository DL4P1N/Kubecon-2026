import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, type ServerDeps } from "../src/server.js";
import { AGGREGATE_CACHE_MS } from "../src/routes/interests.js";
import { MAX_ANSWER_ITEMS, MAX_FREE_TEXT_LENGTH } from "../src/routes/search.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const A = talk("a", 9, 10);

function setup(deps: Omit<ServerDeps, "es"> = {}) {
  const handler: FakeHandler = (call) => {
    if (call.path.startsWith("/talks/_search")) return { body: { took: 1, hits: { hits: [esHit(A, 1)] } } };
    if (call.path === "/talks/_count") return { body: { count: 1 } };
    if (call.path === "/attendees/_search") {
      return { body: { hits: { total: { value: 12 }, hits: [] }, aggregations: { topics: { buckets: [{ key: "kubernetes", doc_count: 12 }] } } } };
    }
    if (call.path === "/attendees/_count") return { body: { count: 0 } };
    if (call.path === "/interest_clusters/_search") return { body: { hits: { hits: [] } } };
    if (call.path.startsWith("/interest_clusters/")) return { body: { deleted: 0, result: "created", errors: false, items: [] } };
    return undefined;
  };
  const es = fakeEs(handler);
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { es, ...deps });
  return { app, es };
}

describe("shared rate-limit policy", () => {
  const cases = [
    { name: "search", limits: { search: { max: 2 } }, req: { method: "GET" as const, url: "/api/search?q=kubernetes" } },
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
      expect(res.json()).toMatchObject({ error: "rate_limited" });
      expect(res.headers["retry-after"]).toBeDefined();
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
  it("serves a second request from memory without another Elasticsearch call", async () => {
    let clock = Date.UTC(2026, 10, 10, 9);
    const { app, es } = setup({ search: { now: () => new Date(clock) } });
    try {
      const first = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(first.statusCode).toBe(200);
      const searches = () => es.calls.filter((c) => c.path === "/attendees/_search").length;
      expect(searches()).toBe(1);

      const second = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(second.json()).toEqual(first.json());
      expect(second.headers["cache-control"]).toBe(`public, max-age=${AGGREGATE_CACHE_MS / 1000}`);
      expect(searches()).toBe(1);

      clock += AGGREGATE_CACHE_MS;
      await app.inject({ method: "GET", url: "/api/interests/aggregate" });
      expect(searches()).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe("input validation", () => {
  const post = (app: ReturnType<typeof setup>["app"], answers: unknown) =>
    app.inject({ method: "POST", url: "/api/onboarding", payload: { answers } });

  it("rejects oversized onboarding answers without echoing them", async () => {
    const { app, es } = setup();
    try {
      const canary = "CANARY-" + "x".repeat(MAX_FREE_TEXT_LENGTH);
      const long = await post(app, { topics: ["security"], freeText: canary });
      expect(long.statusCode).toBe(400);
      expect(long.json()).toMatchObject({ error: "invalid_request" });
      expect(long.body).not.toContain("CANARY");

      const many = await post(app, { topics: Array.from({ length: MAX_ANSWER_ITEMS + 1 }, (_, i) => `t${i}`) });
      expect(many.statusCode).toBe(400);
      expect((await post(app, { topics: ["y".repeat(101)] })).statusCode).toBe(400);
      expect((await post(app, { topics: [], goals: ["z".repeat(101)] })).statusCode).toBe(400);
      expect(es.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects bodies over the onboarding body limit with 413", async () => {
    const { app } = setup();
    try {
      const res = await post(app, { topics: [], filler: "x".repeat(20_000) });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: "payload_too_large", message: "request body too large" });
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
