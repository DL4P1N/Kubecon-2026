# Telemetry privacy regression

Run `npm run test -w api -- test/telemetry-privacy.test.ts`. The normal root
`npm test` runs this file, including in the existing CI `build-test` job.

The test uses the production Fastify server and route handlers, token signing,
span implementation, and Pino serializers/redaction/hooks. Elasticsearch is an
in-memory document fake and embeddings use the deterministic local provider.
No attendee data or credentials leave the test process.

The flow registers a synthetic attendee, searches with private location text,
issues a signed QR token, scans an allowed room, revokes the entitlement, and
scans again. It also checks an untrusted room, a storage failure whose message
contains the attendee ID/location, and a missing route with sensitive URL query
parameters. An in-memory OpenTelemetry exporter captures application spans;
the production logger writes to an in-memory destination.

Assertions require spans for registration, search, token issuance, and scans;
allow/deny/deny scan decisions; ended spans; only documented trace attribute
keys; and no attendee ID, session/QR token, private location, name, or search
text in span attributes, events, status or captured logs. Catalog room IDs are
intentionally allowed by `room.id`; precise user location is not.

A negative control uses a raw tracer call to attach `attendee.id`, bypassing
`withSpan`'s filtering, and proves the privacy assertion rejects it. Another
control puts private location under the otherwise allowed `room.id` key and
proves that key allowlisting alone cannot hide sensitive values.

Mutation validation on 2026-11-09: temporarily adding
`"attendee.id": "synthetic-leak-canary"` to the registration handler's raw
`span.setAttributes` call made the actual flow test fail with
`unreviewed telemetry attribute: attendee.id`. The source mutation was then
removed; it is not part of the change. This checks the full flow assertion,
in addition to the permanent negative-control unit test.

Both Compose and Kubernetes collector configurations must match the allowlists
in `docs/telemetry-allowlist.md` for trace/log/metric/resource attributes. Each
signal must run `transform/allowlist` before batching/export. Log body query
scrubbing must also be present.

Scope: this is an in-process application regression and static collector
configuration check. It does not start the auto-instrumentation SDK or a real
collector and does not prove runtime OTLP scrubbing or Dash0 delivery. Raw Pino
JSON envelopes have logging metadata outside the OTLP attribute model; their
contents are checked for sensitive values, while allowed OTLP log keys are
checked against the collector configuration. Runtime collector/debug-exporter
validation remains a separate deployment check.
