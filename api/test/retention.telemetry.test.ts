import { expect, it } from "vitest";
import { context, logs, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { runRetention } from "../src/retention.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { fakeEs } from "./helpers.js";
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
  try {
    await runRetention(fakeEs(() => ({ body: { deleted: 2, failures: [] } })), new Date("2026-11-09T12:00:00Z"), 24 * 3600 * 1000);
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
    await tracer.shutdown(); await logger.shutdown();
    trace.disable(); logs.disable(); context.disable(); setSpanRunner();
  }
});
