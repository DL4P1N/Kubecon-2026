# Attendee retention

## Policy (changed 9 Nov 2026 by the product owner)

Attendee profiles are **kept**, not deleted after 24 hours. The product keeps
the profile (display name and interests today; role, goal and format
preferences as the product adds them) so the next conference can recommend
talks from the first minute, and so organisers can use aggregate interests to
choose future talks. The aggregate interest map and QR check-in are not
opt-ins: they apply to every registered attendee except one whose stored consent flag is an explicit false (older opt-outs are still honoured). What protects people is that
aggregates never show a group under 5 (small groups are pooled into "other",
and "other" is hidden if it is still under 5). Email is never stored.

This is one setting, `ATTENDEE_RETENTION_HOURS`:

| Value | Behaviour |
| --- | --- |
| unset or `0` (default) | Profiles, entitlements and saved schedules are kept indefinitely. New documents get the far-future `expires_at` sentinel `9999-12-31T23:59:59.999Z` (so expiry checks that fail closed on a missing date keep working). The retention job still deletes documents whose `expires_at` has already passed (left over from an earlier timed policy; kept profiles carry the sentinel, so they are unaffected) and logs `Retention is off ...`; it never deletes by `created_at` while off. |
| positive integer, e.g. `24` | Timed deletion as before: `expires_at` = creation + that many hours, the CronJob purges, and `/api/me` and access checks reject expired attendees. |
| anything else | The API (and `loadConfig`) refuses to start. |

Still short-lived whatever the setting: session tokens (8 hours), QR door
tokens (about 60 seconds), scan logs (decision and room only, never the
attendee ID) and room-activity windows, and superseded cluster runs (pruned
after 24 hours). Synthetic demo records (`npm run clusters:seed`,
`scripts/seed-demo.mts`) always expire after 24 hours.

Switching a deployment from "keep" to a positive value takes effect on the next
job run and also removes older kept profiles (the job matches on `created_at`,
not only on `expires_at`), so announce it before doing it.

## Deleting your own profile

`DELETE /api/me` with the attendee's session token (`Authorization: Bearer
<token>`) deletes everything stored under that attendee ID: the profile in
`attendees`, the saved schedule in `schedules`, the room entitlement in
`entitlements`, and any provider identity links in `identities`. It answers
`204` with no body. The profile is deleted last, so a `503` (storage error)
leaves the account intact and the same call can be retried. Once the profile is
gone the token grants nothing: `GET /api/me`, `POST /api/access/token` and a
second `DELETE /api/me` answer `401` (the second call also removes any stray
schedule document). A QR door token already issued stops working at once
because the scan checks the entitlement, which is gone.

Aggregates are not edited by the request. The interest counts and clusters are
recomputed by the existing jobs, so the attendee drops out of the counts on the
next run (a cached aggregate can show them for up to the cache period). The
request span carries only the allowlisted method, route and status; the
attendee ID is never logged, put on a span or returned.

## The retention job

After building, run `npm run retention` (it reads `ATTENDEE_RETENTION_HOURS`
from the environment, like the API; set it on the CronJob's ConfigMap
`companion-app-config`, otherwise the job stays off). The API image also
`schedules`, `entitlements`, and `identities`; talk catalogs and aggregate interest clusters
are kept. Identity link `expires_at` matches its attendee profile; without a
timed retention setting, identities are kept alongside their profiles. With a
positive setting the job deletes rows whose `created_at` is older than
that many hours or whose `expires_at` has passed. The latter supports the
existing strict schedule and entitlement mappings, which have no `created_at`
field. Missing timestamps do not match; writers must always supply an expiry
or creation timestamp.

The CronJob runs hourly (and, while retention is off, only removes already-expired rows), so cleanup can lag expiry by up to one hour. It uses
the app's database connection (`DATABASE_URL`) and fails on any error
so failed Jobs remain visible. Rerunning is safe.

Apply `deploy/k8s/app/retention-cronjob.yaml` in the application namespace after replacing
the image tag to match the API Deployment. It expects
`companion-app-config` and `companion-app-secrets`; provide `companion-database-ca` only when the database uses a
private CA. Never commit credentials.

Output contains only the deleted count. The CLI starts telemetry as
`companion-retention` before loading application modules and always awaits SDK
shutdown in a finally block to flush buffered spans and logs, even on failure.
`retention.run` and its correlated OTLP log carry only the allowlisted numeric
`retention.deleted` count. Error bodies are not printed. Without an OTLP endpoint,
SDK startup is a no-op. [Live release smoke](evidence/live-smoke.md) records a
completed release-image retention Job and subsequent scheduled execution,
reporting `deleted: 0`. This verifies job execution, not live deletion of an
expired attendee fixture or receipt of its telemetry in Dash0.

## Open items

- No export endpoint exists: an attendee cannot download what is stored about
  them.
- Operators handling EU residents (or other jurisdictions with access and
  portability rights) would need an export endpoint, a retention period they
  can justify, and a lawful basis for keeping profiles, before using the
  default. Until then, set `ATTENDEE_RETENTION_HOURS`.
- `DELETE /api/me` does not revoke the stateless session token itself (at most
  8 hours). `GET /api/me`, `POST /api/access/token` and a second delete reject
  it because the profile is gone, but `POST /api/schedule` only checks the token
  signature, so within that window it could save a new schedule document
  for the deleted attendee (a second `DELETE /api/me` call removes it; the timed
  job removes it too when retention is on).
- The CronJob with a positive setting has not been run against a live cluster
  here; only the unit tests cover the purge path.
