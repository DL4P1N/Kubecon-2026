import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { FastifyOtelInstrumentation } from "@fastify/otel";

export const SERVICE_NAME = "companion-api";

let sdk: NodeSDK | undefined;

/**
 * Starts the OpenTelemetry Node SDK if OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (e.g. http://otel-collector:4318). Otherwise does nothing: the API's
 * tracer/meter calls are no-ops, so tests and plain `npm run dev` are unaffected.
 *
 * Exporters are OTLP/HTTP (JSON) and read the standard OTEL_EXPORTER_OTLP_*
 * env vars; they append /v1/traces, /v1/metrics, /v1/logs to the endpoint.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_SDK_DISABLED === "true") return false;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
      "service.version": env.npm_package_version ?? "0.1.0",
      "service.namespace": "conference-companion",
      "deployment.environment": env.DEPLOYMENT_ENVIRONMENT ?? "dev",
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000),
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      new HttpInstrumentation({
        // Health probes would otherwise dominate the trace list.
        ignoreIncomingRequestHook: (req) => req.url === "/healthz",
      }),
      new UndiciInstrumentation(),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  return true;
}

/** Flushes and stops the SDK. Safe to call when it was never started. */
export async function shutdownTelemetry(): Promise<void> {
  const s = sdk;
  sdk = undefined;
  if (s) await s.shutdown().catch(() => undefined);
}
