# Telemetry attribute allowlist

The collector drops every resource, trace, log, and metric attribute that is
not listed below. This protects attendee data by default: `attendee.id`,
`geo.location`, free-text answers, authorization tokens, and any future
unreviewed fields cannot leave the collector.

| Signal | Allowed attributes |
| --- | --- |
| Resource | `service.name`, `service.version`, `service.namespace`, `deployment.environment` |
| Trace | `http.request.method`, `http.response.status_code`, `http.route`, `server.address`, `server.port`, `rpc.system`, `rpc.service`, `rpc.method`, `db.system`, `db.operation.name`, `db.namespace`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `error.type`, `retention.deleted`, `clusters.attendees`, `clusters.k`, `clusters.shown`, `clusters.suppressed` |
| Log | `log.severity`, `http.request.method`, `http.response.status_code`, `http.route`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `error.type`, `retention.deleted` |
| Metric point | `http.request.method`, `http.response.status_code`, `http.route`, `room.id`, `access.decision`, `search.mode` |

Why the later additions are safe:

- `http.route`: the route *template* (for example `/api/search`), never the
  concrete URL or query string. Needed for request-duration-by-route metrics
  and readable span names. Low cardinality, contains no user input.
- `error.type`: the exception class name (for example `TypeError`) or HTTP
  status class. Exception messages are deliberately not recorded because they
  can echo user input.

`url.path` is deliberately forbidden for every signal: real Fastify request
spans put the full request target, including query text, under this key.
Dropping `url.query` or `url.full` alone is insufficient. Use `http.route`
from a known route template, never a request URL, for endpoint diagnostics.

The same lists live in code as `SPAN_ATTRIBUTE_ALLOWLIST`,
`LOG_ATTRIBUTE_ALLOWLIST` and `METRIC_ATTRIBUTE_ALLOWLIST` in
`api/src/telemetry/allowlist.ts`. `withSpan()` and the metric helpers drop
anything else in-process. Privacy tests exercise exported spans and logs;
validate collector enforcement against its actual output, not configuration text.

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

## Cluster map attributes

The `clusters.run` span (task #22, `npm run clusters`) carries four integer
counts, trace spans only: `clusters.attendees` (opted-in attendees read),
`clusters.k` (k requested from k-means), `clusters.shown` (clusters that met
the minimum size of 5) and `clusters.suppressed` (attendees left out because
their group was below it). They are aggregates, are needed to tell an empty
map from a failed job, and identify no attendee, location or interest.
Cluster labels, interests and run IDs are never put on spans.
