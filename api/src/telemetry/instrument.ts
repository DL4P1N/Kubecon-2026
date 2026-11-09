/**
 * Preloaded before the app via `node --import ./dist/telemetry/instrument.js`
 * (see api/package.json scripts and api/Dockerfile) so instrumentations patch
 * http, fastify and pino before they are first required.
 * No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
 */
import { startTelemetry } from "./sdk.js";

if (startTelemetry()) {
  console.log(`otel: exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}
