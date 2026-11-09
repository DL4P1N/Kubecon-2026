import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MeResponse, RegisterResponse } from "@cc/shared";
import { createTokenService } from "../src/auth/token.js";
import { createEsClient } from "../src/es/client.js";
import { registerRoutes, registerBodySchema } from "../src/routes/register.js";

const KEY = "test-signing-key-that-is-long-enough-0123456789";

/** In-memory fake of the ES document endpoints the routes use. */
function fakeEs() {
  const docs = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let failWrites = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const m = /^\/(\w+)\/(_create|_doc)\/([^/]+)$/.exec(u.pathname);
    if (!m) return new Response("{}", { status: 400 });
    const [, index, op, id] = m;
    const key = `${index}/${decodeURIComponent(id!)}`;
    if (method === "PUT") {
      if (failWrites) return new Response(`{"error":"boom ${u.pathname}"}`, { status: 500 });
      if (op === "_create" && docs.has(key)) return new Response("{}", { status: 409 });
      docs.set(key, JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: "created" }), { status: 201 });
    }
    if (method === "GET") {
      const src = docs.get(key);
      if (!src) return new Response(JSON.stringify({ found: false }), { status: 404 });
      const { interest_vector: _omit, ...rest } = src;
      return new Response(JSON.stringify({ found: true, _source: rest }), { status: 200 });
    }
    return new Response("{}", { status: 405 });
  }) as unknown as typeof fetch;
  return {
    docs,
    calls,
    setFailWrites: (v: boolean) => (failWrites = v),
    client: createEsClient({ esUrl: "http://es:9200", esUsername: "u", esPassword: "p" }, fetchImpl),
  };
}

const validBody = {
  name: "Ada",
  email: "ada@example.com",
  interests: ["Kubernetes", "opentelemetry", "kubernetes"],
  consent: { clusterMap: true, qrCheckin: false },
};

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

describe("POST /api/register and GET /api/me", () => {
  let app: FastifyInstance;
  let es: ReturnType<typeof fakeEs>;
  let t = Date.parse("2026-11-09T12:00:00Z");
  const now = () => t;

  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  beforeEach(async () => {
    t = Date.parse("2026-11-09T12:00:00Z");
    exporter.reset();
    es = fakeEs();
    app = Fastify({ logger: false });
    await app.register(registerRoutes, {
      es: es.client,
      tokens: createTokenService({ key: KEY, now }),
      embed: async () => [1, 0, 0, 0],
      rateLimitPerMinute: 3,
      now,
    });
    await app.ready();
  });

  const register = (payload: unknown = validBody) => app.inject({ method: "POST", url: "/api/register", payload: payload as object });

  it("round-trips register -> me and stores only allowed fields", async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    const reg = res.json() as RegisterResponse;
    expect(reg.attendeeId).toMatch(/^[0-9a-f-]{36}$/);

    const attendee = es.docs.get(`attendees/${reg.attendeeId}`)!;
    expect(Object.keys(attendee).sort()).toEqual(
      ["consent", "created_at", "display_name", "expires_at", "id", "interest_vector", "interests"].sort(),
    );
    expect(attendee.interests).toEqual(["kubernetes", "opentelemetry"]);
    expect(JSON.stringify(attendee)).not.toContain("ada@example.com");
    expect(Date.parse(attendee.expires_at as string) - Date.parse(attendee.created_at as string)).toBe(24 * 3600 * 1000);
    expect(es.docs.get(`entitlements/${reg.attendeeId}`)).toMatchObject({ pass_type: "general", rooms: ["*"] });

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json() as MeResponse).toEqual({
      attendeeId: reg.attendeeId,
      name: "Ada",
      interests: ["kubernetes", "opentelemetry"],
      consent: { clusterMap: true, qrCheckin: false },
      onboarded: false,
    });
  });

  it("returns 401 for /api/me without, with a bad, or with an expired token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer a.b.c" } });
    expect(bad.statusCode).toBe(401);

    const reg = (await register()).json() as RegisterResponse;
    t += 9 * 3600 * 1000; // past the 8h token lifetime
    const expired = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().message).toBe("token expired");
  });

  it("returns 401 when the attendee no longer exists", async () => {
    const reg = (await register()).json() as RegisterResponse;
    es.docs.clear();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(me.statusCode).toBe(401);
  });

  it("returns 503 without leaking the attendee ID when ES writes fail", async () => {
    es.setFailWrites(true);
    const res = await register();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("still registers when the embedder is down, without interest_vector", async () => {
    const app2 = Fastify({ logger: false });
    await app2.register(registerRoutes, {
      es: es.client,
      tokens: createTokenService({ key: KEY }),
      embed: async () => {
        throw new Error("inference down");
      },
    });
    const res = await app2.inject({ method: "POST", url: "/api/register", payload: validBody });
    expect(res.statusCode).toBe(201);
    expect(es.docs.get(`attendees/${res.json().attendeeId}`)).not.toHaveProperty("interest_vector");
    await app2.close();
  });

  it("rate limits registration", async () => {
    for (let i = 0; i < 3; i++) expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(429);
  });

  it("emits a `register` span with allowlisted attributes only, never the attendee ID", async () => {
    const reg = (await register()).json() as RegisterResponse;
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "register");
    expect(spans).toHaveLength(1);
    const allow = new Set([
      "http.request.method", "http.response.status_code", "url.path", "server.address", "server.port",
      "rpc.system", "rpc.service", "rpc.method", "db.system", "db.operation.name", "db.namespace",
      "room.id", "access.decision", "search.mode", "search.hits",
    ]);
    for (const key of Object.keys(spans[0]!.attributes)) expect(allow.has(key)).toBe(true);
    expect(spans[0]!.attributes["http.response.status_code"]).toBe(201);
    expect(JSON.stringify(spans[0]!.attributes)).not.toContain(reg.attendeeId);
    expect(JSON.stringify(spans[0]!.events)).not.toContain(reg.attendeeId);
  });
});

describe("register body validation", () => {
  const rejects = (body: unknown) => expect(registerBodySchema.safeParse(body).success).toBe(false);

  it("accepts a valid body and drops unknown fields", () => {
    const r = registerBodySchema.safeParse({ ...validBody, religion: "x", health: "y" });
    expect(r.success).toBe(true);
    expect(Object.keys(r.data!).sort()).toEqual(["consent", "email", "interests", "name"]);
  });

  it("accepts a body without email", () => {
    const { email: _e, ...noEmail } = validBody;
    expect(registerBodySchema.safeParse(noEmail).success).toBe(true);
  });

  it("rejects bad bodies", () => {
    rejects(undefined);
    rejects({ ...validBody, name: "   " });
    rejects({ ...validBody, name: "x".repeat(81) });
    rejects({ ...validBody, interests: [] });
    rejects({ ...validBody, interests: "kubernetes" });
    rejects({ ...validBody, interests: [""] });
    rejects({ ...validBody, interests: ["x".repeat(65)] });
    rejects({ ...validBody, interests: Array.from({ length: 21 }, (_, i) => `t${i}`) });
    rejects({ ...validBody, interests: [42] });
    rejects({ ...validBody, consent: undefined });
    rejects({ ...validBody, consent: { clusterMap: "yes", qrCheckin: true } });
  });

  it("returns 400 over HTTP without echoing values", async () => {
    const app = Fastify({ logger: false });
    await app.register(registerRoutes, {
      es: fakeEs().client,
      tokens: createTokenService({ key: KEY }),
      embed: async () => [1],
    });
    const res = await app.inject({ method: "POST", url: "/api/register", payload: { ...validBody, name: "", interests: ["secret-value".repeat(10)] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("secret-value");
    await app.close();
  });
});
