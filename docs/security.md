# API security and privacy controls

Snapshot of every API route on `main` as of task #49 (API security sweep).
Rate limits are per client IP per minute, keyed on `request.ip`. That honours
`TRUST_PROXY` (#27), so clients behind the ingress get their own bucket and a
spoofed `X-Forwarded-For` entry beyond the trusted hops cannot open a new one.
The shared policy is in `api/src/http/rateLimit.ts`. Counters are in memory
per replica. Every 429 has the same body, `{ "error": "rate_limited", "message": "..." }`,
plus `Retry-After`.

Conference Wi-Fi can put many attendees behind one public IP, so the
attendee-facing limits are generous. Cached aggregate routes are cheap and
get the most headroom.

## Route table

| Route | Auth | Rate limit (/IP/min) | Cache | Validation | Data exposed |
| --- | --- | --- | --- | --- | --- |
| `GET /healthz` | none | **none** (kubelet probes) | none | none | `status`, `version`, `time` |
| `GET /api/status` | none | 600 | 10 s in memory, single-flight, `Cache-Control: public, max-age=10` | none (no input) | Counts, latencies and states only. No paths, queries or IDs |
| `GET /api/search` | none | 240 | none (per-query) | `q` one string, 1 to 500 chars; `mode` enum; `size` int 1 to 50 | Public talk catalog hits |
| `POST /api/onboarding` | none | 60 | none | zod: `topics`/`goals` arrays of strings ≤ 100 chars (first 20 entries used), `experience` enum, `freeText` ≤ 1000 chars (first 500 searched), ISO dates; body ≤ 16 KiB (413) | Public talk catalog hits. Answers are not stored |
| `POST /api/schedule` | Bearer session token (HS256) | 120 | none | `maxTalks` 1 to 50, `talkIds` ≤ 100 strings or onboarding answers as above; body ≤ 16 KiB | The caller's own schedule |
| `GET /api/schedule` | Bearer session token | 120 | none | none | The caller's own schedule |
| `POST /api/register` | none | 60 (`REGISTER_RATE_LIMIT_PER_MINUTE`) | none | zod: name ≤ 80, email ≤ 254 (never stored), 1 to 20 interests × ≤ 64, consent booleans; unknown fields dropped | The new attendee ID and token, to that caller only |
| `GET /api/me` | Bearer session token, plus expiry checked against ES | 120 | none | none | The caller's own profile (vector excluded) |
| `POST /api/access/token` | Bearer session token + `qr_checkin` consent | 120 | none | none | Short-lived QR token (`aud` = access) |
| `POST /api/access/scan` | Signed QR token, entitlement checked server-side | 600 | none | zod: token, room (known room catalog) | `allow`/`deny`, room, reason. Never the attendee ID |
| `GET /api/interests/aggregate` | none (public organizer view) | 300 | 15 s in memory, single-flight, `Cache-Control: public, max-age=15`; ES copy written at most once a minute | none (no input) | Topic counts with k ≥ 5 suppression (small buckets merged into `other`, dropped if still < 5) |
| `GET /api/interests/clusters` | `x-organizer-key` (constant-time compare; 503 in production if unset) | 120 | 15 s in memory, after authorization | none (no input) | Cluster labels and sizes ≥ `MIN_CLUSTER_SIZE`. Centroids stay server-side |
| `GET /api/catalog/topics` | not on `main` yet (PR #28, task #37) | to be applied with the shared policy when it lands (suggest 300 + 30 s cache) | — | — | Public catalog tags |
| `GET /api/rooms/*` (room occupancy) | covered by #42 review (PR #41) | covered by #42 review | covered by #42 review | covered by #42 review | covered by #42 review |
| any unknown route | — | — | — | — | Fixed `404 { "error": "not_found" }`. The raw path/query is not echoed (Fastify's default message did echo it) |

### Error shapes

All 4xx responses are JSON `{ "error": "<code>", "message"?: "<text>" }`.
Validation messages name the field and the rule, never the submitted value.
Elasticsearch errors are never forwarded. Search routes answer
`502 { error: "search_unavailable" }` or `503 { error: "search_overloaded" }`
with `Retry-After`. Aggregate/clusters answer `502 aggregate_unavailable`/
`clusters_unavailable`, and register/me/access answer `503 storage_unavailable`.
ES error text can contain query text or document paths (and so attendee IDs),
so it is neither logged nor put on spans. Only `error.type` and the HTTP
status are logged.

## Privacy controls

- **Signed tokens.** Session tokens and QR access tokens are HS256 JWTs signed
  with `TOKEN_SIGNING_KEY` from a Kubernetes Secret. QR tokens carry a separate
  audience and a short TTL. Production refuses to start without the key
  (`api/src/config.ts`, `api/src/auth/token.ts`).
- **Server-side entitlement checks.** `/api/access/scan` looks up the
  entitlement and attendee expiry in ES on every scan and fails closed (503,
  never `allow`) if the lookup errors (`api/src/routes/access.ts`).
- **k ≥ 5 suppression.** Interest aggregates and clusters never return a
  group under 5 attendees (`api/src/interests/aggregate.ts`,
  `api/src/routes/clusters.ts`), and only attendees who consented to the
  cluster map are counted.
- **24h retention.** Attendee, entitlement and schedule docs carry
  `expires_at` = registration + 24h. A CronJob deletes expired docs
  (`deploy/k8s/app/retention-cronjob.yaml`, `docs/retention.md`). `/api/me`
  and access checks also reject expired attendees.
- **Telemetry attribute allowlist.** Spans go through `withSpan`, which drops
  any attribute that is not on the allowlist, and the OTel collector scrubs
  again (`docs/telemetry-allowlist.md`). Attendee IDs are never logged or put
  on spans. **Raw URL in telemetry/logs: fixed by #40** (drop `url.path` from
  exported attributes, keep `http.route`, and request-serializer
  hardening).
- **Least-privilege ES.** The API uses the `companion_svc` role/user, never
  `elastic` (`docs/elasticsearch.md`, `docs/es-deployment.md`).
- **TLS.** In-cluster API TLS is an opt-in overlay (#24,
  `deploy/k8s/tls`, `API_TLS_CERT_FILE`/`API_TLS_KEY_FILE`, TLS ≥ 1.2).
  Ingress TLS is in `deploy/k8s/tls-ingress`.

## Tests

`api/test/security.test.ts` covers:

- 429 with the shared body on search, status, interests aggregate, interests
  clusters and onboarding.
- Per-IP buckets.
- `/healthz` is never limited.
- An aggregate cache hit makes no second ES call.
- Oversized onboarding answers get 400 without echoing input. Non-string
  entries get a 400 that names the field. A selection of more than 20 topics
  is cut to the first 20 instead of being rejected.
- An oversized body gets 413.
- An oversized `q` gets 400.
- A 404 does not echo the path or query.

Register and access-scan limits are covered by `proxy.test.ts` and
`access.test.ts`.
