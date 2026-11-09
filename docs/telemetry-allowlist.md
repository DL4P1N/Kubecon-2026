# Telemetry attribute allowlist

The collector drops every resource, trace, log, and metric attribute that is
not listed below. This protects attendee data by default: `attendee.id`,
`geo.location`, free-text answers, authorization tokens, and any future
unreviewed fields cannot leave the collector.

| Signal | Allowed attributes |
| --- | --- |
| Resource | `service.name`, `service.version`, `service.namespace`, `deployment.environment` |
| Trace | `http.request.method`, `http.response.status_code`, `url.path`, `server.address`, `server.port`, `rpc.system`, `rpc.service`, `rpc.method`, `db.system`, `db.operation.name`, `db.namespace`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `retention.deleted`, `clusters.attendees`, `clusters.k`, `clusters.shown`, `clusters.suppressed` |
| Log | `log.severity`, `http.request.method`, `http.response.status_code`, `url.path`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `retention.deleted` |
| Metric point | `http.request.method`, `http.response.status_code`, `url.path`, `room.id`, `access.decision`, `search.mode` |

## Local validation

Start the debug-enabled collector with `docker compose -f deploy/compose/docker-compose.yml up`.
Send an OTLP trace that includes `attendee.id`, `geo.location`, and
`search.mode`. The collector's `debug` exporter must display `search.mode` but
not the two sensitive attributes. For Kubernetes, apply the manifests and
inspect `kubectl logs deploy/otel-collector` the same way.

Before adding an attribute, document why it is necessary here and update both
collector configurations. Sensitive or identifier-like fields are never
allowlisted.

## Cluster map attributes

The `clusters.run` span (task #22, `npm run clusters`) carries four integer
counts, trace spans only: `clusters.attendees` (opted-in attendees read),
`clusters.k` (k requested from k-means), `clusters.shown` (clusters that met
the minimum size of 5) and `clusters.suppressed` (attendees left out because
their group was below it). They are aggregates, are needed to tell an empty
map from a failed job, and identify no attendee, location or interest.
Cluster labels, interests and run IDs are never put on spans.
