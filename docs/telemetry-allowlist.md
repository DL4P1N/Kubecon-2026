# Telemetry attribute allowlist

The collector drops every resource, trace, log, and metric attribute that is
not listed below. This protects attendee data by default: `attendee.id`,
`geo.location`, free-text answers, authorization tokens, and any future
unreviewed fields cannot leave the collector.

| Signal | Allowed attributes |
| --- | --- |
| Resource | `service.name`, `service.version`, `service.namespace`, `deployment.environment` |
| Trace | `http.request.method`, `http.response.status_code`, `url.path`, `server.address`, `server.port`, `rpc.system`, `rpc.service`, `rpc.method`, `db.system`, `db.operation.name`, `db.namespace`, `room.id`, `access.decision`, `search.mode`, `search.hits`, `retention.deleted` |
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
