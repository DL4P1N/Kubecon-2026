# Telemetry attribute allowlist

The collector drops every resource, trace, log, and metric attribute that is
not listed below. This protects attendee data by default: `attendee.id`,
`geo.location`, free-text answers, authorization tokens, and any future
unreviewed fields cannot leave the collector.

| Signal | Allowed attributes |
| --- | --- |
| Resource | `service.name`, `service.version`, `service.namespace`, `deployment.environment` |
| Trace | `http.request.method`, `http.response.status_code`, `http.route`, `url.path`, `server.address`, `server.port`, `rpc.system`, `rpc.service`, `rpc.method`, `db.system`, `db.operation.name`, `db.namespace`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `error.type` |
| Log | `log.severity`, `http.request.method`, `http.response.status_code`, `http.route`, `url.path`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `error.type` |
| Metric point | `http.request.method`, `http.response.status_code`, `http.route`, `url.path`, `room.id`, `access.decision`, `search.mode` |

Why the later additions are safe:

- `http.route`: the route *template* (for example `/api/search`), never the
  concrete URL or query string. Needed for request-duration-by-route metrics
  and readable span names. Low cardinality, contains no user input.
- `error.type`: the exception class name (for example `TypeError`) or HTTP
  status class. Exception messages are deliberately not recorded because they
  can echo user input.

The same lists live in code as `SPAN_ATTRIBUTE_ALLOWLIST`,
`LOG_ATTRIBUTE_ALLOWLIST` and `METRIC_ATTRIBUTE_ALLOWLIST` in
`api/src/telemetry/allowlist.ts`. `withSpan()` and the metric helpers drop
anything else in-process, and `api/test/telemetry.test.ts` fails if those
constants drift from either collector config.

Log message bodies are not attributes, so `keep_keys` does not cover them.
The collector therefore also runs `replace_pattern(body, "\\?\\S*", "?[redacted]")`
on logs, so a URL query string inside a message never reaches Dash0 (the API
already strips them in `api/src/telemetry/logger.ts`).

## Local validation

Start the debug-enabled collector with `docker compose -f deploy/compose/docker-compose.yml up`.
Send an OTLP trace that includes `attendee.id`, `geo.location`, and
`search.mode`. The collector's `debug` exporter must display `search.mode` but
not the two sensitive attributes. For Kubernetes, apply the manifests and
inspect `kubectl logs deploy/otel-collector` the same way.

Before adding an attribute, document why it is necessary here and update both
collector configurations and `api/src/telemetry/allowlist.ts`. Sensitive or identifier-like fields are never
allowlisted.
