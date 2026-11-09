import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { esHit, fakeEs, talk } from "./helpers.js";

const { logLines } = vi.hoisted(() => ({ logLines: [] as string[] }));
// Exercise the production serializers, redaction and hooks, with an in-memory destination.
vi.mock("../src/telemetry/logger.js", async (original) => {
  const mod = await original<typeof import("../src/telemetry/logger.js")>();
  return { ...mod, loggerOptions: { ...mod.loggerOptions, level: "info", stream: {
    write: (line: string) => { logLines.push(line); },
  } } };
});

const readRepo = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const documented = readRepo("docs/telemetry-allowlist.md");
function allowed(signal: string): string[] {
  const row = documented.split("\n").find((line) => line.startsWith(`| ${signal} |`));
  if (!row) throw new Error(`Missing documented allowlist: ${signal}`);
  return [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function assertAttributes(attrs: Record<string, unknown>, allowlist: string[], forbidden: string[]) {
  for (const [key, value] of Object.entries(attrs)) {
    expect(allowlist, `unreviewed telemetry attribute: ${key}`).toContain(key);
    for (const secret of forbidden) expect(JSON.stringify(value), `sensitive value in ${key}`).not.toContain(secret);
  }
}

// Catalog room IDs are intentionally allowlisted; precise user location is not.
const LOCATION = "private-gps-40.7608,-111.8910";
const PRIVATE_NAME = "Synthetic privacy canary";
const QUERY = `security ${LOCATION}`;

describe("attendee flow telemetry privacy", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
    setSpanRunner();
  });
  beforeEach(() => { exporter.reset(); logLines.length = 0; });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    setSpanRunner();
  });

  it("exports allowlisted spans and safe logs through register, search, allow and revoked scan", async () => {
    const docs = new Map<string, unknown>();
    let failReads = false;
    const es = fakeEs((call) => {
      if (call.path === "/talks/_search") return { body: { hits: { hits: [esHit(talk("t1", 9, 10), 1)] } } };
      if (call.path === "/talks/_count") {
        return { body: { count: JSON.stringify(call.body).includes(LOCATION) ? 0 : 1 } };
      }
      const path = call.path.split("?")[0]!;
      const match = /^\/(attendees|entitlements)\/_(?:create|doc)\/([^/]+)$/.exec(path);
      if (!match) throw new Error(`Unexpected ES request: ${call.method} ${path}`);
      const key = `${match[1]}/${decodeURIComponent(match[2]!)}`;
      if (call.method === "PUT") { docs.set(key, call.body); return { body: { result: "created" } }; }
      if (failReads) throw new Error(`storage failed for ${key} at ${LOCATION}`);
      return docs.has(key) ? { body: { found: true, _source: docs.get(key) } } : { status: 404, body: { found: false } };
    });
    vi.stubEnv("EMBEDDINGS_PROVIDER", "local");
    const app = buildServer(loadConfig({}), { es });
    try {
      const reg = await app.inject({ method: "POST", url: "/api/register", payload: {
        name: PRIVATE_NAME, interests: ["security"], location: LOCATION,
        consent: { clusterMap: false, qrCheckin: true },
      } });
      expect(reg.statusCode).toBe(201);
      const { attendeeId, token } = reg.json<{ attendeeId: string; token: string }>();
      expect(attendeeId).toBeTruthy();
      const headers = { authorization: `Bearer ${token}` };
      const search = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(QUERY)}&mode=keyword`, headers });
      expect(search.statusCode).toBe(200);
      const issue = await app.inject({ method: "POST", url: "/api/access/token", headers });
      expect(issue.statusCode).toBe(200);
      const qrToken = issue.json<{ token: string }>().token;
      const scan = (room: string) => app.inject({ method: "POST", url: "/api/access/scan", payload: { token: qrToken, room, location: LOCATION } });
      expect((await scan("Hall A")).json()).toMatchObject({ decision: "allow" });
      docs.delete(`entitlements/${attendeeId}`);
      expect((await scan("Hall A")).json()).toMatchObject({ decision: "deny" });
      expect((await scan(LOCATION)).statusCode).toBe(400);
      failReads = true;
      expect((await app.inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(503);
      // Also exercise Fastify's own URL-containing 404 log message.
      await app.inject({ method: "GET", url: `/api/missing?q=${encodeURIComponent(LOCATION)}&attendee=${attendeeId}`, headers });
      await app.close();
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["register", "search", "access.token", "access.scan", "me"]));
      expect(spans.filter((span) => span.name === "access.scan").map((span) => span.attributes["access.decision"])).toEqual(["allow", "deny", "deny"]);
      const forbidden = [attendeeId, token, qrToken, LOCATION, encodeURIComponent(LOCATION), PRIVATE_NAME, QUERY];
      for (const span of spans) {
        expect(span.ended).toBe(true);
        assertAttributes(span.attributes, allowed("Trace"), forbidden);
        for (const secret of forbidden) expect(JSON.stringify({ name: span.name, events: span.events, status: span.status })).not.toContain(secret);
      }
      expect(logLines.length).toBeGreaterThan(0);
      for (const secret of forbidden) expect(logLines.join("\n")).not.toContain(secret);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it("detects raw tracer bypasses and sensitive values even under an allowed key", () => {
    const span = trace.getTracer("privacy-regression").startSpan("unsafe");
    span.setAttribute("attendee.id", "synthetic-attendee-canary");
    span.end();
    expect(() => assertAttributes(exporter.getFinishedSpans()[0]!.attributes, allowed("Trace"), [])).toThrow(/attendee.id/);
    expect(() => assertAttributes({ "room.id": LOCATION }, allowed("Trace"), [LOCATION])).toThrow(/sensitive value/);
  });
});

for (const path of ["deploy/k8s/otel-collector/configmap.yaml", "deploy/compose/otel-config.yaml"]) {
  it(`${path} enforces documented signal and resource allowlists before export`, () => {
    const config = readRepo(path);
    for (const [signal, ctx] of [["Trace", "span"], ["Log", "log"], ["Metric point", "datapoint"]]) {
      const match = new RegExp(`context: ${ctx}\\s+statements:\\s+- keep_keys\\(attributes, (\\[[^\\]]*\\])\\)`).exec(config);
      expect(match, `${ctx} keep_keys missing`).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(allowed(signal!));
    }
    const resources = [...config.matchAll(/context: resource\s+statements:\s+- keep_keys\(attributes, (\[[^\]]*\])\)/g)];
    expect(resources).toHaveLength(3);
    for (const match of resources) expect(JSON.parse(match[1]!)).toEqual(allowed("Resource"));
    for (const signal of ["traces", "logs", "metrics"]) {
      expect(config).toMatch(new RegExp(`${signal}:\\s+receivers: \\[otlp\\]\\s+processors: \\[transform/allowlist, batch\\]`));
    }
    expect(config).toContain('replace_pattern(body,');
  });
}
