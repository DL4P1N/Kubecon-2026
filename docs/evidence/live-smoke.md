# Live release smoke — board #47

Observed 2026-11-09 on the dedicated `kind-conference-companion` cluster,
namespace `conference-companion`. API and web run immutable images
`cc-api:b9f7ffe` and `cc-web:b9f7ffe` from reviewed main.

## Acceptance boundary

The human explicitly requested shipping this PR once the deployed app was stable,
without waiting for the original full end-to-end checklist. This report records
only observed checks. It does **not** claim completion of QR revocation/restore,
`/api/me` session-isolation testing, every original #47 criterion, or a live
Dash0 SLO/dashboard screenshot.

## Observed results

| Check | Observation |
| --- | --- |
| Production image | API Docker build and real production-CMD `/healthz` smoke passed; web production build passed. Both images loaded into the existing kind cluster. |
| Workloads | API, web, collector and Elasticsearch each Ready 1/1 after rollout. No cluster or Elasticsearch replacement. |
| Catalog | Deployed `/api/catalog/topics` returned 200 with 153 topics from the existing 417-talk catalog. No catalog reinitialization/reseed. |
| Status | `/api/status` returned 200, `status=ok`, Elasticsearch reachable. Browser header and status page rendered. |
| Attendee UI | Managed-browser registration, onboarding and schedule pages exercised for two synthetic attendees. Distinct schedule surfaces observed; this is not a `/api/me` isolation proof. |
| Search | Real browser keyword/hybrid comparison completed. Dash0 captured HTTP 200 keyword and hybrid requests; the captured hybrid API span took 263 ms. One sample is not an SLO result. |
| Synthetic map fixture | Existing seed script wrote 12 opted-in synthetic attendees with 384-dimensional ES-inference interest vectors and synthetic entitlements. |
| Cluster batch | Actual release-image Job completed: 12 opted-in attendees, k=2, two clusters, zero suppressed and zero skipped. |
| Retention batch | Actual release-image Job completed and reported `deleted: 0`. Subsequent scheduled runs of both CronJobs also completed. |
| Organizer | Organizer key added privately to the existing app Secret before rollout. Browser map, clusters and organizer views rendered; independent wrong/right-key HTTP tests were not run. |
| Privacy | Corrected live collector retained; actual captured trace has normalized route labels and no `url.path` attribute. No credentials or attendee IDs are included in these artifacts. |

These counts describe different phases, not a single frozen population. The
one-off post-seed batch processed 12 attendees before the browser registrations.
Later browser observations show 15 opted-in attendees and a scheduled cluster
run with sizes 8 and 6 and one suppressed attendee. Both snapshots are retained
in the JSON artifacts with their phase identified.

## Browser → API → Elasticsearch proof

Actual Dash0 trace: `2f1b274e968409bdc3738454008f2cd9`.

- Browser `companion-web` CLIENT span `c8746b9f00470307`.
- Its child API SERVER span `ca789400dbe7eb7e`, `GET /api/search`, HTTP 200.
- Same trace contains the `search` span with `search.mode=hybrid`, its `embed`
  child, and CLIENT span `8d7adf944f483fa6` to `server.address=elasticsearch`, HTTP 200.
- [Actual Dash0 MCP response](live-smoke-dash0-trace.json) includes the trace
  explorer link and span-parent relationships. Elasticsearch is the downstream
  client target, not a separately instrumented ES server process.

## Artifacts

- [Batch execution and fixture counts](live-smoke-batch.json).
- [Browser observations and explicit limits](live-smoke-flows.json).
- [Registration](../demo/live-smoke-register-a.png),
  [schedule A](../demo/live-smoke-schedule-a.png),
  [schedule B](../demo/live-smoke-schedule-b.png),
  [search](../demo/live-smoke-search.png),
  [map](../demo/live-smoke-map.png),
  [clusters](../demo/live-smoke-clusters.png),
  [status](../demo/live-smoke-status.png),
  [organizer](../demo/live-smoke-organizer.png).

The earlier `live-smoke-schedule.png` is a registration capture and is not cited
as schedule proof. All attendees used here are synthetic; QR and bearer-token
captures are not published.

## CronJob deployment correction

Both existing CronJob manifests now match the local kind base: `cc-api:local`,
explicit `IfNotPresent`, and public CA Secret `elasticsearch-http-ca`. They remain
outside the app's base Kustomization. For this live run, their container image
was replaced **in memory before applying** with `cc-api:b9f7ffe`, matching the
API release; no old local-tag Job was deliberately started. The CLI entrypoints,
schedules, resources and security contexts are unchanged.

Local access remains `http://127.0.0.1:18086`; this is an operator port-forward,
not a publicly reachable app or evidence of end-to-end transport TLS. The existing
cluster and Elasticsearch remain running for subsequent #61/#52 work.

## Session isolation and live QR revocation — #70, deployed `9c047d7`

Observed **2026-11-09, 23:33–23:37 UTC** against
`http://127.0.0.1:18086` on the same dedicated cluster and namespace. Both
Deployments were verified to run `cc-api:9c047d7` / `cc-web:9c047d7`.
This supplements, rather than changes, the historical #47 boundary above.

[Timestamped, redacted HTTP checks, screenshots and log/span observations](live-smoke-70.json).
Only two newly registered synthetic attendees, A and B, were used. No real
attendee document, application code, signing key or deployment was changed.

### `/api/me` identity and authentication

| Request | Observed result |
| --- | --- |
| A's session token | HTTP 200; A's id, display name and interests matched registration; B's id/name absent |
| B's session token | HTTP 200; B's id, display name and interests matched registration; A's id/name absent |
| No token | HTTP 401 `unauthorized` |
| A's token with a changed signature character | HTTP 401 `unauthorized` |

Identifiers and session tokens remained in process memory and are redacted from
the evidence. The JSON records response keys and field comparisons, not the
raw identifiers.

### Same fresh QR token: allow → revoke → deny → restore → allow

The room was selected from the live talk catalog:
`Hyatt Regency | Level 2 | Salt Lake Ballroom DE`.
The access token's claims were `aud`, `exp`, `iat`, `iss`, `sub`; `sub` was its
only attendee-identity claim. It carried no name, email, interests or room.

| Synthetic A entitlement | Same-token scan result |
| --- | --- |
| Original general pass | HTTP 200, `allow` |
| `rooms` changed to `[]` server-side | HTTP 200, `deny`, reason `not_entitled` |
| Original complete document restored | HTTP 200, `allow` |

All three API scans used **one identical token**, completed in **2.242 seconds**
of its 60-second lifetime, and returned no attendee id or token. Each
Elasticsearch write used `refresh=wait_for`; restoration ran in `finally`, and
a subsequent GET matched the original document exactly.

The real kiosk's token-text path independently repeated the same transition
with a second fresh token, unchanged across its three scans, in 2.615 seconds.
These are actual browser captures cropped to the decision region; the token
input and all QR images are excluded:

- [Access granted](../demo/live-smoke-70-qr-allow.png), 23:35:52Z.
- [Revoked: access denied](../demo/live-smoke-70-qr-revoked.png), 23:35:53Z.
- [Restored: access granted](../demo/live-smoke-70-qr-restored.png), 23:35:54Z.

### Privacy observation and a logging gap

- Sampled API stdout: **240 lines**, including six access-scan request
  records; neither synthetic attendee id nor either session/access token was
  present. Raw logs are not published.
- Six actual exported `access.scan` spans carried the expected
  `access.decision` / validated `room.id` values: allow, deny, allow for each
  sequence. No tested identifier/token appeared in those spans. The JSON
  retains only selected non-sensitive fields, not resource auth markers.
- **The requested decision-and-room audit log was absent from stdout.**
  Those fields existed in spans/metrics, not the generic request/completion
  log records. Filed **P1 board #76** for this observability requirement;
  the passing authorization checks must not be described as proof that this
  logging requirement is implemented.

This is a narrow live check, not a full privacy audit. Camera scanning and
every Dash0-stored log were not tested. The two synthetic attendee records
remain subject to normal 24-hour retention; their entitlements were restored.
