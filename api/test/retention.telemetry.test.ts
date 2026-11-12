import { expect, it } from "vitest";
import { context, logs, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { runRetention } from "../src/retention.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { testDb } from "./pg.js";
import { LOG_ATTRIBUTE_ALLOWLIST, SPAN_ATTRIBUTE_ALLOWLIST } from "../src/telemetry/allowlist.js";

it("exports the count on a retention span and correlated log without document data", async () => {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const tracer = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
  const logger = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracer);
  logs.setGlobalLoggerProvider(logger);
  setSpanRunner();
  const db = await testDb();
  try {
    for (const id of ["a", "b"]) {
      await db.query("insert into attendees (id, display_name, created_at, expires_at) values ($1, 'x', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')", [id]);
      await db.query("insert into schedules (attendee_id, updated_at, expires_at) values ($1, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')", [id]);
      await db.query("insert into entitlements (attendee_id, pass_type, updated_at, expires_at) values ($1, 'g', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')", [id]);
      await db.query("insert into identities (id, attendee_id, created_at, expires_at) values ($1, $1, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')", [id]);
    }
    await runRetention(db, new Date("2026-11-09T12:00:00Z"), 24 * 3600 * 1000);
    await tracer.forceFlush();
    await logger.forceFlush();
    const span = spanExporter.getFinishedSpans().find((span) => span.name === "retention.run")!;
    expect(span.attributes).toEqual({ "retention.deleted": 8 });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record!.attributes).toEqual({ "retention.deleted": 8 });
    expect(record!.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(record!.body).toBe("Retention cleanup");
    for (const key of Object.keys(span.attributes)) expect(SPAN_ATTRIBUTE_ALLOWLIST).toContain(key);
    for (const key of Object.keys(record!.attributes)) expect(LOG_ATTRIBUTE_ALLOWLIST).toContain(key);
  } finally {
    await db.close();
    await tracer.shutdown(); await logger.shutdown();
    trace.disable(); logs.disable(); context.disable(); setSpanRunner();
  }
});
