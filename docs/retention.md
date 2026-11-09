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
`companion-app-config`, `companion-app-secrets`, and the `elasticsearch-ca`
Secret with a `ca.crt` entry. Never commit credentials.

Output contains only the deleted count. The tracing seam records
`retention.run` with `retention.deleted`; SDK initialization and shutdown must
also be wired for this standalone CLI when task #12 lands. Live Kubernetes
execution is pending the deployment owner's validation.
