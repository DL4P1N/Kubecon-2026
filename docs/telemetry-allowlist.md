# Telemetry attribute allowlist

The API drops every resource, trace, log, and metric attribute that is
not listed below, in process, before anything is exported. This protects attendee
data by default: `attendee.id`, `geo.location`, free-text answers, authorization
tokens, and any future unreviewed fields cannot leave the API. The deployed demo
has no collector and exports nothing; if you run one, mirror these lists in its
attribute filter.

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

The lists live in code as `SPAN_ATTRIBUTE_ALLOWLIST`,
`LOG_ATTRIBUTE_ALLOWLIST` and `METRIC_ATTRIBUTE_ALLOWLIST` in
`api/src/telemetry/allowlist.ts`. `withSpan()` and the metric helpers drop
anything else in-process. `api/test/telemetry.test.ts` and
`api/test/telemetry-privacy.test.ts` exercise that enforcement on real spans,
metrics and logs.

Log message bodies are not attributes. The API's logger strips URL query strings
from message text before they are written or exported
(`api/src/telemetry/logger.ts`).

## Local validation

Browser Web Vitals reuse the existing metric-point `http.route` allowlist in
both collectors; no new attribute keys are needed. Only fixed page templates
or `/unknown` are emitted, with `/talks/:id` replacing talk identifiers.
`companion.web.vitals.{lcp,inp,ttfb}` histograms use seconds; `cls` is unitless.
The standard `web-vitals` callbacks report document measurements, attributed
to the initial route (not SPA navigation timings). Reports can recur after a
tab is hidden and restored; p75 represents reported observations, not unique
attendees. Metric IDs, performance entries, DOM selectors, URLs and queries
are never recorded. No interaction means INP may be absent. Live Dash0
receipt remains a deployment check.

To check a change, send a request that would carry `attendee.id`, `geo.location`
and `search.mode` through the instrumented code with an in-memory exporter (see
`api/test/telemetry-privacy.test.ts`): `search.mode` must appear and the two
sensitive attributes must not.

Before adding an attribute, document why it is necessary here and update
`api/src/telemetry/allowlist.ts`. Sensitive or identifier-like fields are never
allowlisted.

## Cluster map attributes

The `clusters.run` span (task #22, `npm run clusters`) carries four integer
counts, trace spans only: `clusters.attendees` (opted-in attendees read),
`clusters.k` (k requested from k-means), `clusters.shown` (clusters that met
the minimum size of 5) and `clusters.suppressed` (attendees left out because
their group was below it). They are aggregates, are needed to tell an empty
map from a failed job, and identify no attendee, location or interest.
Cluster labels, interests and run IDs are never put on spans.
