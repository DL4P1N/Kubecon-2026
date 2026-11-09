import { afterEach, describe, expect, it } from "vitest";
import type { StatusResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { STATUS_CACHE_MS } from "../src/routes/status.js";
import { HYBRID_RECOVERY_SECONDS, createStatusTracker, percentile } from "../src/status/tracker.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => {
  spans.length = 0;
});

const A = talk("a", 9, 10);

interface World {
  esUp: boolean;
  hybridFails: "none" | "overload" | "other";
  clock: number;
}

function setup() {
  const world: World = { esUp: true, hybridFails: "none", clock: 1_000_000 };
  const handler: FakeHandler = (call) => {
    if (call.path === "/talks/_count") return world.esUp ? { body: { count: 417 } } : { status: 503, body: { error: { type: "unavailable_shards_exception" } } };
    if (call.path.startsWith("/talks/_search")) {
      const isHybrid = JSON.stringify(call.body).includes("rrf");
      if (isHybrid && world.hybridFails === "overload") return { status: 429, body: { error: { type: "inference_exception" } } };
      if (isHybrid && world.hybridFails === "other") return { status: 500, body: { error: { type: "boom" } } };
      return { body: { took: 3, hits: { hits: [esHit(A, 1)] } } };
    }
    return undefined;
  };
  const es = fakeEs(handler);
  const tracker = createStatusTracker(() => world.clock);
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { es, status: tracker, search: { now: () => new Date(world.clock) } });
  return { app, world, es, tracker };
}

async function getStatus(app: ReturnType<typeof setup>["app"]) {
  const res = await app.inject({ method: "GET", url: "/api/status" });
  return { res, body: res.json() as StatusResponse };
}

describe("tracker", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });

  it("drops samples older than the window", () => {
    let t = 0;
    const tr = createStatusTracker(() => t);
    tr.recordSearch("keyword", 10, "ok");
    tr.recordRequest(500);
    t = 301_000;
    expect(tr.searchStat("keyword")).toEqual({ samples: 0, p95Ms: null });
    expect(tr.errorRate()).toEqual({ requests: 0, serverErrors: 0, ratio: 0 });
  });

  it("reports hybrid warming up after a failure, then recovered or unknown", () => {
    let t = 0;
    const tr = createStatusTracker(() => t);
    expect(tr.hybridState()).toBe("unknown");
    tr.recordSearch("hybrid", 5, "overloaded");
    expect(tr.hybridState()).toBe("warming_up");
    t += (HYBRID_RECOVERY_SECONDS + 1) * 1000;
    expect(tr.hybridState()).toBe("unknown");
    tr.recordSearch("hybrid", 5, "ok");
    expect(tr.hybridState()).toBe("ready");
  });
});

describe("GET /api/status", () => {
  it("is public, reports ES reachable and ok on a fresh server, and spans it with allowlisted attributes", async () => {
    const { app } = setup();
    const { res, body } = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.api).toEqual({ up: true, version: "0.1.0" });
    expect(body.elasticsearch.reachable).toBe(true);
    expect(body.search.hybrid.state).toBe("unknown");
    expect(body.search.keyword).toEqual({ samples: 0, p95Ms: null });
    expect(spans.find((s) => s.name === "status")?.set).toEqual({ "http.response.status_code": 200 });
    expect(spans.find((s) => s.name === "status")?.attrs).toEqual({ "http.request.method": "GET", "url.path": "/api/status" });
  });

  it("shows live search latency and ready hybrid after real searches, with no query text in the body", async () => {
    const { app, world } = setup();
    for (const mode of ["keyword", "hybrid"]) {
      const r = await app.inject({ method: "GET", url: `/api/search?q=secret-attendee-question&mode=${mode}` });
      expect(r.statusCode).toBe(200);
    }
    world.clock += STATUS_CACHE_MS + 1;
    const { res, body } = await getStatus(app);
    expect(body.search.keyword.samples).toBe(1);
    expect(body.search.keyword.p95Ms).toBeTypeOf("number");
    expect(body.search.hybrid.samples).toBe(1);
    expect(body.search.hybrid.state).toBe("ready");
    expect(res.body).not.toContain("secret-attendee-question");
  });

  it("goes degraded with hybrid warming up after a 503 search_overloaded, keyword still ok", async () => {
    const { app, world } = setup();
    world.hybridFails = "overload";
    const failed = await app.inject({ method: "GET", url: "/api/search?q=x&mode=hybrid" });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "search_overloaded" });
    const kw = await app.inject({ method: "GET", url: "/api/search?q=x&mode=keyword" });
    expect(kw.statusCode).toBe(200);
    world.clock += STATUS_CACHE_MS + 1;
    const { body } = await getStatus(app);
    expect(body.status).toBe("degraded");
    expect(body.search.hybrid.state).toBe("warming_up");
    expect(body.search.keyword.samples).toBe(1);
    expect(body.search.hybrid.samples).toBe(0); // latency only counts successful searches
  });

  it("goes down when Elasticsearch is unreachable", async () => {
    const { app, world } = setup();
    world.esUp = false;
    const { body } = await getStatus(app);
    expect(body.status).toBe("down");
    expect(body.elasticsearch.reachable).toBe(false);
  });

  it("caches for 10 seconds and refreshes afterwards", async () => {
    const { app, world, es } = setup();
    await getStatus(app);
    await getStatus(app);
    expect(es.calls.filter((c) => c.path === "/talks/_count")).toHaveLength(1);
    world.clock += STATUS_CACHE_MS + 1;
    await getStatus(app);
    expect(es.calls.filter((c) => c.path === "/talks/_count")).toHaveLength(2);
  });

  it("counts 5xx responses as an error rate (but not /healthz or /api/status) and degrades past 5% over 20+ requests", async () => {
    const { app, world } = setup();
    world.hybridFails = "other";
    for (let i = 0; i < 18; i++) await app.inject({ method: "GET", url: "/api/search?q=x&mode=keyword" });
    await app.inject({ method: "GET", url: "/healthz" });
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "GET", url: "/api/search?q=x&mode=hybrid" });
      expect(r.statusCode).toBe(502);
    }
    world.clock += STATUS_CACHE_MS + 1;
    const { body } = await getStatus(app);
    expect(body.errorRate).toEqual({ requests: 20, serverErrors: 2, ratio: 0.1 });
    expect(body.status).toBe("degraded");
  });

  it("does not count an empty onboarding submit (never reaches ES) as a hybrid success", async () => {
    const { app, world, es } = setup();
    world.hybridFails = "overload";
    const failed = await app.inject({ method: "GET", url: "/api/search?q=x&mode=hybrid" });
    expect(failed.statusCode).toBe(503);
    const searchesBefore = es.calls.filter((c) => c.path.startsWith("/talks/_search")).length;
    const empty = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: [] } } });
    expect(empty.statusCode).toBe(200);
    expect(es.calls.filter((c) => c.path.startsWith("/talks/_search"))).toHaveLength(searchesBefore); // no ES query ran
    world.clock += STATUS_CACHE_MS + 1;
    const { body } = await getStatus(app);
    expect(body.search.hybrid.state).toBe("warming_up");
    expect(body.status).toBe("degraded");
    expect(body.search.hybrid.samples).toBe(0);
  });
});
