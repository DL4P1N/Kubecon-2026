import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HealthResponse, SearchResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

describe("api stub", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer(loadConfig({}));
    await app.ready();
  });
  afterAll(() => app.close());

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
      ES_URL: "https://es:9200",
      ES_USERNAME: "svc",
      ES_PASSWORD: "pw",
      TOKEN_SIGNING_KEY: "k",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
      PORT: "8080",
    });
    expect(c.esUrl).toBe("https://es:9200");
    expect(c.port).toBe(8080);
    expect(c.otelExporterOtlpEndpoint).toBe("http://otel:4318");
  });
});
