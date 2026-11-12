# Observability (OpenTelemetry, optional)

Telemetry is optional and disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` (API) or `VITE_OTLP_ENDPOINT` (browser build)
is configured. When enabled, attributes pass an in-process allowlist (`docs/telemetry-allowlist.md`) before export.

When you do want traces, point both apps at any OTLP/HTTP collector you run yourself (the old setup was
a collector that scrubbed with the same allowlist and forwarded to a backend such as Dash0):

```
browser (companion-web) --traceparent--> api (companion-api) --SQL--> Postgres
      |  OTLP/HTTP (VITE_OTLP_ENDPOINT)        |  OTLP/HTTP (OTEL_EXPORTER_OTLP_ENDPOINT)
      +---------------> your collector <-------+ ---> backend
```

## Run locally

```sh
# 1. A throwaway collector that prints everything it receives
cat > /tmp/otel-debug.yaml <<'EOF'
receivers: { otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } } }
exporters: { debug: { verbosity: detailed } }
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [debug] }
    logs: { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
EOF
docker run --rm -p 4318:4318 -v /tmp/otel-debug.yaml:/c.yaml otel/opentelemetry-collector-contrib:0.116.1 --config=/c.yaml

# 2. API with telemetry on
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev:api

# 3. Web with browser RUM on (Vite proxies /api -> :3000 and /otlp -> :4318)
VITE_OTLP_ENDPOINT=/otlp npm run dev:web
```

Open http://localhost:5173, run a search, and look for one trace id in the
collector's debug output with spans from `companion-web` (fetch GET),
`companion-api` (GET /api/search, fastify handler) and the `search.hybrid` span around the query (the `pg` driver is not auto-instrumented).

Telemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so `npm test`
and a plain `npm run dev:api` never try to export.

## API (`api/src/telemetry/`)

| File | What |
| --- | --- |
| `instrument.ts` | Preloaded with `node --import` (start/dev scripts, Dockerfile CMD) so instrumentation patches modules before the app loads. |
| `sdk.ts` | `NodeSDK` with resource `service.name=companion-api`, OTLP/HTTP exporters for traces, metrics, logs. Instrumentations: `http` (server spans + `http.server.request.duration`), `@fastify/otel` (route/handler spans, sets `http.route`), `undici` (outgoing `fetch`), `pino` (log correlation + OTLP log sending). The `pg` driver is not instrumented; database time shows up inside the custom spans. `shutdownTelemetry()` flushes on SIGTERM. `startTelemetry(serviceName?)` is also callable directly from CLIs. |
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
    const r = await runQuery(db, sql, params);
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

Each access-scan handler decision emits one structured INFO audit record with
`access.decision` (`allow` or `deny`) and `room.id`. The room is a validated
catalog value, or the fixed `unknown` sentinel when validation has not succeeded.
The record contains no attendee id, token, submitted body, denial detail or raw
room input. Existing request/trace correlation fields still come from the logger.
The access privacy test exercises allowed and denied valid-room scans, invalid
tokens, unknown/malformed rooms and entitlement-backend failure using the
production logger configuration.

## Web (`web/src/telemetry/rum.ts`)

OpenTelemetry web SDK (`@opentelemetry/sdk-trace` `TracerProvider`,
`instrumentation-document-load`, `instrumentation-fetch`), resource
`service.name=companion-web`. Imported once from `main.tsx`.

- document load + resource timing spans
- a span per `fetch`, with W3C `traceparent` on `/api` calls so the API span is
  a child of the browser span
- `browser.error` spans for uncaught errors / unhandled rejections (`error.type` only)

Export target: `VITE_OTLP_ENDPOINT` (build-time; **off by default**). Set it to `/otlp` to send spans
through a proxy to a collector: Vite proxies `/otlp/*` to `OTLP_URL` (default `http://localhost:4318`)
in dev; the production nginx config no longer has an `/otlp` route, so add one (and rebuild with the
variable set) if you run a collector next to the container.

We used the upstream OTel web SDK rather than a vendor-specific browser SDK so
everything can go through your own collector and its allowlist, with no vendor
token in the browser bundle.

## Runtime requirements

The OTel JS 3.x / 0.301 packages and `@fastify/otel` need Node >= 22.15, so
the API and web build images use Node 22 (the API on Debian slim, the web image on alpine).
