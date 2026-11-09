# Attendee retention

After building, run `npm run retention`. The API image also supports
`node dist/retention-cli.js`. The job targets only `attendees`, `schedules`,
and `entitlements`; talk catalogs and aggregate interest clusters are kept.
It deletes documents whose `created_at` is more than 24 hours old or whose
`expires_at` has passed. The latter supports the existing strict schedule and
entitlement mappings, which have no `created_at` field. Missing timestamps
do not match; writers must always supply an expiry or creation timestamp.

The CronJob runs hourly, so cleanup can lag expiry by up to one hour. It uses
the app's Elasticsearch credentials and fails on conflicts, partial failures
or timeout so failed Jobs remain visible. Rerunning is safe.

Apply `deploy/k8s/app/retention-cronjob.yaml` in the app namespace after replacing
the image tag and CA Secret name to match the API Deployment. It expects
`companion-app-config`, `companion-app-secrets`, and the `elasticsearch-http-ca`
Secret with a `ca.crt` entry. Never commit credentials.

Output contains only the deleted count. The CLI starts telemetry as
`companion-retention` before loading application modules and always awaits SDK
shutdown in a finally block to flush buffered spans and logs, even on failure.
`retention.run` and its correlated OTLP log carry only the allowlisted numeric
`retention.deleted` count. Error bodies are not printed. Without an OTLP endpoint,
SDK startup is a no-op. [Live release smoke](evidence/live-smoke.md) records a
completed release-image retention Job and subsequent scheduled execution,
reporting `deleted: 0`. This verifies job execution, not live deletion of an
expired attendee fixture or receipt of its telemetry in Dash0.
