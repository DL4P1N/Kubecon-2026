import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HealthResponse, SearchResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import type { Db } from "../src/db/client.js";
import { insertTalks, testDb } from "./pg.js";
import { talk } from "./helpers.js";

describe("api stub", () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    db = await testDb();
    const t = talk("t1", 9, 10, { title: "Elasticsearch to Postgres", tags: ["search"] });
    await insertTalks(db, [{ ...t, level: "intermediate" }]);
    app = buildServer(loadConfig({}), { db, embedder: new LocalHashEmbedder() });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await db.close(); });

  it("serves /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as HealthResponse).status).toBe("ok");
  });

  it("returns contract-shaped search results", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=elasticsearch&mode=keyword" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.mode).toBe("keyword");
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it("rejects an invalid search mode", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=x&mode=bogus" });
    expect(res.statusCode).toBe(400);
  });

  it("registers an attendee", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: {
        name: "Ada",
        email: "ada@example.com",
        interests: ["kubernetes"],
        consent: { clusterMap: true, qrCheckin: true },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBeTruthy();
  });
});

describe("config", () => {
  it("reads settings from env", () => {
    const c = loadConfig({
      DATABASE_URL: "postgresql://app:pw@db.example.test:5432/postgres",
      TOKEN_SIGNING_KEY: "k",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
      PORT: "8080",
    });
    expect(c.databaseUrl).toBe("postgresql://app:pw@db.example.test:5432/postgres");
    expect(c.port).toBe(8080);
    expect(c.otelExporterOtlpEndpoint).toBe("http://otel:4318");
    expect(c.registerRateLimitPerMinute).toBe(120);
  });

  it("refuses to start in production with a placeholder signing key", () => {
    const prod = { NODE_ENV: "production", DATABASE_URL: "postgresql://app:pw@db.example.test:5432/postgres" };
    const db = {} as Db;
    expect(() => buildServer(loadConfig({ ...prod, TOKEN_SIGNING_KEY: "change-me" }), { db })).toThrow(/placeholder/);
    expect(() => buildServer(loadConfig({ ...prod, TOKEN_SIGNING_KEY: "too-short" }), { db })).toThrow(/at least/);
    expect(() => loadConfig({ ...prod })).toThrow(/TOKEN_SIGNING_KEY/);
  });
});
