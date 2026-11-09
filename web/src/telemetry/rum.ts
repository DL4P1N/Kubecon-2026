/**
 * Browser RUM with the OpenTelemetry web SDK (service.name=companion-web).
 * Imported once, first, from main.tsx. Emits:
 *  - documentLoad / resource spans (page load timing)
 *  - a span per fetch(); same-origin /api calls carry a W3C `traceparent`
 *    header, so the API's server span joins the browser trace
 *  - a `browser.error` span for uncaught errors and unhandled rejections
 *    (error type only; messages can contain user input)
 * Spans go over OTLP/HTTP to VITE_OTLP_ENDPOINT (default `/otlp`, proxied to
 * the collector's :4318 by Vite in dev and nginx in the container).
 * Set VITE_OTLP_ENDPOINT=off to disable.
 */
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, StackContextManager, TracerProvider } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { registerVitals } from "./vitals.js";

const SERVICE_NAME = "companion-web";

function otlpBase(): string | null {
  const raw = (import.meta.env.VITE_OTLP_ENDPOINT as string | undefined) ?? "/otlp";
  if (raw === "off" || raw === "") return null;
  return raw.replace(/\/+$/, "");
}

function start(): void {
  const base = otlpBase();
  if (!base || typeof window === "undefined" || import.meta.env.MODE === "test") return;
  const tracesUrl = `${base}/v1/traces`;

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": SERVICE_NAME,
      "service.namespace": "conference-companion",
      "deployment.environment": import.meta.env.MODE,
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: tracesUrl }) })],
  });
  context.setGlobalContextManager(new StackContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({
      "service.name": SERVICE_NAME,
      "service.namespace": "conference-companion",
      "deployment.environment": import.meta.env.MODE,
    }),
    readers: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    })],
  });
  registerVitals(meterProvider.getMeter(SERVICE_NAME), window.location.pathname, () => meterProvider.forceFlush());

  registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        // Never trace the exporter's own requests.
        ignoreUrls: [new RegExp(`${escapeRegExp(base)}/`)],
        // Same-origin requests get traceparent by default; this also covers a
        // cross-origin API (e.g. VITE_API_BASE pointing elsewhere).
        propagateTraceHeaderCorsUrls: [/\/api\//],
      }),
    ],
  });

  const tracer = trace.getTracer(SERVICE_NAME);
  const recordError = (kind: string, err: unknown) => {
    const span = tracer.startSpan("browser.error");
    span.setAttribute("error.type", err instanceof Error ? err.name : kind);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  window.addEventListener("error", (e) => recordError("error", e.error));
  window.addEventListener("unhandledrejection", (e) => recordError("unhandledrejection", e.reason));

  // Flush buffered spans when the tab is hidden or closed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void provider.forceFlush().catch(() => {});
      void meterProvider.forceFlush().catch(() => {});
    }
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

try {
  start();
} catch (err) {
  // Telemetry must never break the app.
  console.warn("RUM disabled:", err);
}
