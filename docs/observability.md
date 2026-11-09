# Observability (OpenTelemetry -> collector -> Dash0)

Both apps speak plain OTLP/HTTP to the OTel collector
(`deploy/compose`, `deploy/k8s/otel-collector`). The collector enforces the
attribute allowlist (`docs/telemetry-allowlist.md`) and forwards to Dash0.
Dash0 credentials live only in the collector's env / K8s Secret.

```
browser (companion-web) --traceparent--> api (companion-api) --fetch--> Elasticsearch
      |  OTLP/HTTP via /otlp proxy             |  OTLP/HTTP :4318
      +---------------> otel-collector <-------+ ---> Dash0
```

## Run locally

```sh
# 1. Collector (debug exporter prints everything it forwards)
docker compose -f deploy/compose/docker-compose.yml up otel-collector
#    To also ship to Dash0 locally: export DASH0_OTLP_ENDPOINT / DASH0_AUTH_TOKEN first.

# 2. API with telemetry on
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev:api

# 3. Web (Vite proxies /api -> :3000 and /otlp -> :4318)
npm run dev:web
```

Open http://localhost:5173, run a search, and look for one trace id in the
collector's debug output with spans from `companion-web` (fetch GET),
`companion-api` (GET /api/search, fastify handler) and the outgoing ES call.

Telemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so `npm test`
and a plain `npm run dev:api` never try to export.

## API (`api/src/telemetry/`)

| File | What |
| --- | --- |
| `instrument.ts` | Preloaded with `node --import` (start/dev scripts, Dockerfile CMD) so instrumentation patches modules before the app loads. |
| `sdk.ts` | `NodeSDK` with resource `service.name=companion-api`, OTLP/HTTP exporters for traces, metrics, logs. Instrumentations: `http` (server spans + `http.server.request.duration`), `@fastify/otel` (route/handler spans, sets `http.route`), `undici` (outgoing `fetch`, i.e. the ES client), `pino` (log correlation + OTLP log sending). `shutdownTelemetry()` flushes on SIGTERM. `startTelemetry(serviceName?)` is also callable directly from CLIs. |
| `span.ts` | `withSpan(name, attrs, fn)`: custom spans whose attributes (at start and via `span.setAttribute`) are filtered through the allowlist, so `attendee.id` is dropped before export. Errors record `error.type` only, never the message. `setSpanRunner(fake)` swaps the implementation in tests. |
| `metrics.ts` | `recordSearchLatency(seconds, mode)` / `timeSearch(mode, fn)` (already wrapped around `runSearch` in `api/src/search/service.ts`) -> histogram `companion.search.duration` (s, by `search.mode`); `recordAccessScan(decision, room)` -> counter `access.scans` (by `access.decision`, `room.id`; PromQL name `access_scans_total`). |
| `logger.ts` | `loggerOptions` for `Fastify({ logger })`: pino JSON to stdout, request serializer emits only method, path without query, route and status; redacts `authorization`, cookies, bodies, tokens and `attendeeId`. A `logMethod` hook strips query strings from message text (e.g. Fastify's 404 "Route GET:/x?q=... not found") and replaces error messages with the error type; the `err` serializer keeps only type and codes. |
| `allowlist.ts` | The allowlist as constants. A unit test checks they match both collector configs. |

Usage from feature code:

```ts
import { withSpan } from "./telemetry/span.js";
import { timeSearch, recordAccessScan } from "./telemetry/metrics.js";

const res = await timeSearch(mode, () =>
  withSpan("search.hybrid", { "search.mode": mode }, async (span) => {
    const r = await es.request("POST", "/talks/_search", body);
    span.setAttribute("search.hits", hits.length);
    return r;
  }),
);
recordAccessScan(decision, room);
```

### Short-lived processes (CLI, CronJob)

Scripts that run outside the server (for example the retention CLI) are not
preloaded with `instrument.ts`. They start and flush the SDK themselves:

```ts
import { startTelemetry, shutdownTelemetry } from "./telemetry/sdk.js";
import { withSpan } from "./telemetry/span.js";

startTelemetry("companion-retention"); // no-op without OTEL_EXPORTER_OTLP_ENDPOINT
try {
  await withSpan("retention.run", {}, async () => { /* ... */ });
} finally {
  await shutdownTelemetry(); // flushes spans/metrics/logs before exit
}
```

Call `startTelemetry` before importing modules you want auto-instrumented
(outgoing `fetch` via undici is traced regardless, since it uses diagnostics
channels). Alternatively run the script with
`node --import ./dist/telemetry/instrument.js` and `OTEL_SERVICE_NAME=...`,
then call only `shutdownTelemetry()` at the end.

### Logs: OTLP, not stdout scraping

`@opentelemetry/instrumentation-pino` adds `trace_id`/`span_id`/`trace_flags`
to every stdout JSON line and also emits each record through the OTel Logs SDK
to the collector over OTLP. We chose OTLP because it needs no filelog receiver
or node-level DaemonSet, and Dash0 links the records to traces directly.
stdout JSON is still there for `kubectl logs`.

Fastify logging is enabled by passing `loggerOptions` to `Fastify()` in
`api/src/server.ts`. Level comes from `LOG_LEVEL` (default `info`, `silent`
under vitest).

## Web (`web/src/telemetry/rum.ts`)

OpenTelemetry web SDK (`@opentelemetry/sdk-trace` `TracerProvider`,
`instrumentation-document-load`, `instrumentation-fetch`), resource
`service.name=companion-web`. Imported once from `main.tsx`.

- document load + resource timing spans
- a span per `fetch`, with W3C `traceparent` on `/api` calls so the API span is
  a child of the browser span
- `browser.error` spans for uncaught errors / unhandled rejections (`error.type` only)

Export target: `VITE_OTLP_ENDPOINT` (build-time, default `/otlp`; `off`
disables). `/otlp/*` is proxied to the collector by Vite in dev
(`OTLP_URL`, default `http://localhost:4318`) and by nginx in the container
(`OTLP_UPSTREAM`, default `http://otel-collector:4318`). nginx resolves that
host at startup, so the collector Service must exist in the same namespace as
the web pod (or set `OTLP_UPSTREAM` to an FQDN).

We used the upstream OTel web SDK rather than a Dash0-specific browser SDK so
everything goes through our own collector and its allowlist, with no vendor
token in the browser bundle.

## Runtime requirements

The OTel JS 3.x / 0.301 packages and `@fastify/otel` need Node >= 22.15, so
the API and web build images use `node:22-alpine`.
