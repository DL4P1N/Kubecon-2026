import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { withSpan } from "../src/telemetry/span.js";
import { recordAccessScan, recordSearchLatency, resetMetricsForTest } from "../src/telemetry/metrics.js";
import Fastify from "fastify";
import { SPAN_ATTRIBUTE_ALLOWLIST } from "../src/telemetry/allowlist.js";
import { loggerOptions } from "../src/telemetry/logger.js";
import { startTelemetry } from "../src/telemetry/sdk.js";

describe("withSpan allowlist", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  beforeEach(() => exporter.reset());

  it("drops attribute keys that are not allowlisted", async () => {
    const result = await withSpan(
      "search.hybrid",
      { "search.mode": "hybrid", "attendee.id": "a-123", "geo.location": "52.1,4.3", q: "free text", "url.path": "/api/search?q=private-start#private-fragment" },
      async (span) => {
        span.setAttribute("search.hits", 7);
        span.setAttribute("attendee.id", "a-123");
        span.setAttribute("user.email", "x@y.z");
        span.setAttribute("url.path", "/api/search?q=private-late");
        return 42;
      },
    );
    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("search.hybrid");
    expect(span?.attributes).toEqual({ "search.mode": "hybrid", "search.hits": 7 });
    for (const key of Object.keys(span!.attributes)) {
      expect(SPAN_ATTRIBUTE_ALLOWLIST as readonly string[]).toContain(key);
    }
  });

  it("nests child spans and marks errors without the message", async () => {
    await expect(
      withSpan("outer", {}, () => withSpan("inner", { "room.id": "hall-a" }, () => {
        throw new TypeError("attendee a-123 not found");
      })),
    ).rejects.toThrow(TypeError);
    const spans = exporter.getFinishedSpans();
    const inner = spans.find((s) => s.name === "inner")!;
    const outer = spans.find((s) => s.name === "outer")!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.status.code).toBe(2);
    expect(inner.attributes).toEqual({ "room.id": "hall-a", "error.type": "TypeError" });
    expect(JSON.stringify({ attrs: inner.attributes, events: inner.events, status: inner.status })).not.toContain("a-123");
  });
});

describe("metrics", () => {
  it("records search latency and access scans with allowlisted attributes only", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    resetMetricsForTest();

    recordSearchLatency(0.12, "hybrid");
    recordAccessScan("allow", "hall-a");
    recordAccessScan("allow", "hall-a");
    recordAccessScan("deny", "hall-b");
    await reader.forceFlush();

    const all = exporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const scans = all.find((m) => m.descriptor.name === "access.scans")!;
    const allowPoint = scans.dataPoints.find((p) => p.attributes["access.decision"] === "allow")!;
    expect(allowPoint.value).toBe(2);
    expect(allowPoint.attributes).toEqual({ "access.decision": "allow", "room.id": "hall-a" });
    const search = all.find((m) => m.descriptor.name === "companion.search.duration")!;
    expect(search.dataPoints[0]?.attributes).toEqual({ "search.mode": "hybrid" });
    // Sub-second buckets: the SDK default (0, 5, 10, ...) would put every
    // search in one bucket and make the Dash0 p95 panel/SLO meaningless.
    const hist = search.dataPoints[0]!.value as { buckets: { boundaries: number[] } };
    expect(hist.buckets.boundaries).toContain(0.5);
    expect(hist.buckets.boundaries).toContain(0.1);

    await provider.shutdown();
    metrics.disable();
    resetMetricsForTest();
  });
});


describe("fastify logging does not leak user input", () => {
  it("strips query strings from 404 messages and drops error messages", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { ...loggerOptions, level: "info", stream: { write: (s: string) => void lines.push(s) } },
    });
    app.get("/boom", async () => {
      throw new Error("attendee a-123 not found");
    });
    await app.inject({ method: "GET", url: "/api/search/?q=my%20secret%20text" });
    await app.inject({ method: "GET", url: "/boom?token=abc" });
    await app.close();
    const out = lines.join("");
    expect(out).toContain("not found"); // the 404 line is still logged
    expect(out).not.toMatch(/secret|token=abc|a-123/);
  });
});

describe("sdk + logger", () => {
  it("does not start the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    expect(startTelemetry("companion-test", {})).toBe(false);
  });

  it("serializes requests without query strings, headers or bodies", () => {
    const out = loggerOptions.serializers.req({
      method: "GET",
      url: "/api/search?q=secret",
      routeOptions: { url: "/api/search" },
    });
    expect(out).toEqual({ method: "GET", path: "/api/search", route: "/api/search" });
    expect(loggerOptions.redact.paths).toEqual(
      expect.arrayContaining(["req.headers.authorization", "attendeeId", "req.body"]),
    );
  });
});
