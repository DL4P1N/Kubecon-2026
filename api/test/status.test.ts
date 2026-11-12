import { afterEach, describe, expect, it } from "vitest";
import type { StatusResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { STATUS_CACHE_MS } from "../src/routes/status.js";
import { HYBRID_RECOVERY_SECONDS, createStatusTracker, percentile } from "../src/status/tracker.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import type { Db } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { mk, seededDb } from "./search-fixtures.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => {
  spans.length = 0;
});

interface World {
  dbUp: boolean;
  hybridFails: "none" | "overload" | "other";
  clock: number;
}

/** A live PGlite whose availability and hybrid (vector) queries the test can break. */
async function setup() {
  const world: World = { dbUp: true, hybridFails: "none", clock: 1_000_000 };
  const real = await seededDb([mk("a", 9, 10)]);
  const probes: string[] = [];
  const gate = async <T>(text: string, run: () => Promise<T>): Promise<T> => {
    if (!world.dbUp) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    if (text.includes("<=>") && world.hybridFails === "overload") throw Object.assign(new Error("too many connections"), { code: "53300" });
    if (text.includes("<=>") && world.hybridFails === "other") throw Object.assign(new Error("boom"), { code: "XX000" });
    return run();
  };
  const db: Db = {
    query: (text, params) => {
      if (text.startsWith("select count(*) from talks")) probes.push(text);
      return gate(text, () => real.query(text, params));
    },
    exec: (text) => real.exec(text),
    transaction: (fn) => real.transaction(fn),
    close: () => real.close(),
  };
  const tracker = createStatusTracker(() => world.clock);
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    db, embedder: new LocalHashEmbedder(), status: tracker, search: { now: () => new Date(world.clock) },
  });
  return { app, world, probes, tracker };
}

async function getStatus(app: Awaited<ReturnType<typeof setup>>["app"]) {
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
  it("is public, reports the database reachable and ok on a fresh server, and spans it with allowlisted attributes", async () => {
    const { app } = await setup();
    const { res, body } = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.api).toEqual({ up: true, version: "0.1.0" });
    expect(body.database.reachable).toBe(true);
    expect(body.search.hybrid.state).toBe("unknown");
    expect(body.search.keyword).toEqual({ samples: 0, p95Ms: null });
    expect(spans.find((s) => s.name === "status")?.set).toEqual({ "http.response.status_code": 200 });
    expect(spans.find((s) => s.name === "status")?.attrs).toEqual({ "http.request.method": "GET", "http.route": "/api/status" });
  });

  it("shows live search latency and ready hybrid after real searches, with no query text in the body", async () => {
    const { app, world } = await setup();
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
    const { app, world } = await setup();
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

  it("goes down when the database is unreachable", async () => {
    const { app, world } = await setup();
    world.dbUp = false;
    const { body } = await getStatus(app);
    expect(body.status).toBe("down");
    expect(body.database.reachable).toBe(false);
  });

  it("caches for 10 seconds and refreshes afterwards", async () => {
    const { app, world, probes } = await setup();
    await getStatus(app);
    await getStatus(app);
    expect(probes).toHaveLength(1);
    world.clock += STATUS_CACHE_MS + 1;
    await getStatus(app);
    expect(probes).toHaveLength(2);
  });

  it("counts 5xx responses as an error rate (but not /healthz or /api/status) and degrades past 5% over 20+ requests", async () => {
    const { app, world } = await setup();
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

  it("does not count an empty onboarding submit (never reaches the database) as a hybrid success", async () => {
    const { app, world, probes } = await setup();
    world.hybridFails = "overload";
    const failed = await app.inject({ method: "GET", url: "/api/search?q=x&mode=hybrid" });
    expect(failed.statusCode).toBe(503);
    const empty = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: [] } } });
    expect(empty.statusCode).toBe(200);
    world.clock += STATUS_CACHE_MS + 1;
    const { body } = await getStatus(app);
    expect(body.search.hybrid.state).toBe("warming_up");
    expect(body.status).toBe("degraded");
    expect(body.search.hybrid.samples).toBe(0);
  });
});
