# API security and privacy controls

Snapshot of every API route on `main` as of task #49 (API security sweep).
Rate limits are per client IP per minute, keyed on `request.ip`. That honours
`TRUST_PROXY` (#27), so clients behind the ingress get their own bucket and a
spoofed `X-Forwarded-For` entry beyond the trusted hops cannot open a new one.
The shared policy is in `api/src/http/rateLimit.ts`. Counters are in memory
per replica. Every 429 has the same body in every scope (Fastify's default
error handler or a route's own), plus `Retry-After`:
`{ "statusCode": 429, "error": "rate_limited", "message": "too many requests, retry in ..." }`.

**Venue NAT tradeoff.** Conference Wi-Fi can put many attendees behind one
public IP, and a per-IP limit then becomes a shared budget. The limits are
generous for that reason. Registration (120/min, `REGISTER_RATE_LIMIT_PER_MINUTE`)
and QR token issuance (300/min) are the tightest, because they write to the database or
sign tokens. 120 registrations a minute from one IP is still well above the
pace of a registration desk. If the venue routes everyone through one NAT
address, raise `REGISTER_RATE_LIMIT_PER_MINUTE` in the ConfigMap. Every limit
is per replica, so scaling the API out also raises the effective ceiling.
Cached aggregate routes are cheap and get the most headroom.

## Route table

| Route | Auth | Rate limit (/IP/min) | Cache | Validation | Data exposed |
| --- | --- | --- | --- | --- | --- |
| `GET /healthz` | none | **none** (kubelet probes) | none | none | `status`, `version`, `time` |
| `GET /api/status` | none | 600 | 10 s in memory, single-flight, `Cache-Control: public, max-age=10` | none (no input) | Counts, latencies and states only. No paths, queries or IDs |
| `GET /api/search` | none | 240 | none (per-query) | `q` one string, 1 to 500 chars; `mode` enum; `size` int 1 to 50 | Public talk catalog hits |
| `POST /api/onboarding` | none | 60 | none | zod: `topics`/`goals` arrays of strings ≤ 100 chars (first 20 entries used), `experience` enum, `freeText` ≤ 1000 chars (first 500 searched), ISO dates; ≤ 1000 raw entries per list (400). Body ≤ 256 KiB (413), sized above the zod caps so the largest valid tag set gets a 400 or a 200, never a 413 | Public talk catalog hits. Answers are not stored |
| `POST /api/schedule` | Bearer session token (HS256) | 120 | none | `maxTalks` 1 to 50, `talkIds` ≤ 100 strings or onboarding answers as above; body ≤ 256 KiB | The caller's own schedule |
| `GET /api/schedule` | Bearer session token | 120 | none | none | The caller's own schedule |
| `GET /api/schedule.ics` | Bearer session token | 120 (shares the schedule limit value) | `Cache-Control: private, no-store` | `talkId` one string of 1 to 200 chars | The caller's own schedule as iCalendar |
| `POST /api/register` | none | 120 (`REGISTER_RATE_LIMIT_PER_MINUTE`) | none | zod: name ≤ 80, email ≤ 254 (never stored), 1 to 20 interests × ≤ 64, optional consent booleans (each defaults to true when absent; an explicit false is stored and honoured); unknown fields dropped | The new attendee ID and token, to that caller only |
| `GET /api/me` | Bearer session token, plus expiry checked in the database | 120 | none | none | The caller's own profile (vector excluded) |
| `DELETE /api/me` | Bearer session token | 120 (shares the `/api/me` limit value, own counter) | none | none | `204`, no body. Deletes the caller's `entitlements`, `schedules` and `attendees` documents (last, so a 503 can be retried). `404` if the profile is already gone; `401` for a missing or invalid token. Never returns or logs the attendee ID |
| `POST /api/access/token` | Bearer session token; `403` if the stored `consent.qr_checkin` is false | 300 | none | none | Short-lived QR token (`aud` = access) |
| `POST /api/access/scan` | Signed QR token, entitlement checked server-side | 600 | none | zod: token, room (known room catalog) | `allow`/`deny`, room, reason. Never the attendee ID |
| `GET /api/interests/aggregate` | none (public organizer view) | 300 | 15 s in memory, single-flight, `Cache-Control: public, max-age=15`; stored copy written at most once a minute | none (no input) | Topic counts with k ≥ 5 suppression (small buckets merged into `other`, dropped if still < 5) |
| `GET /api/interests/clusters` | `x-organizer-key` (constant-time compare; 503 in production if unset) | 120 | 15 s in memory, after authorization | none (no input) | Cluster labels and sizes ≥ `MIN_CLUSTER_SIZE`. Centroids stay server-side |
| `GET /api/talks/:id` | none | 60 per client IP (own scope, shared 429 body) | 60 s in memory per talk (≤ 500 entries, shared with the two routes below), `Cache-Control: public, max-age=60` | `:id` matches `[A-Za-z0-9._:-]{1,100}` (400 otherwise); unknown talk 404 | Public talk fields (title, speaker, abstract, track, room, time, tags) |
| `GET /api/talks/:id/related` | none | 60 per client IP (own scope, per route, shared 429 body) | as above, per talk and size | `:id` as above; `size` int 1 to 10 (default 5) | Public talks similar by meaning, at any time, with the tags they share. Never attendee data |
| `GET /api/talks/:id/alternatives` | none | 60 per client IP (own scope, per route, shared 429 body) | as above, per talk and size | `:id` as above; `size` int 1 to 10 (default 3) | Public talks overlapping this talk's time in other rooms, with shared tags. Never attendee data |
| `GET /api/suggest` | none | 120 (shared policy, own scope) | 30 s in-memory per-query cache (≤ 500 entries) | `q` one string, 2 to 100 chars | Public talk titles and speakers |
| `GET /api/catalog/topics` | none | 300 | 30 s in memory (successes only), single-flight, `Cache-Control: public, max-age=30` | none (no input) | Public catalog tags. Never attendee interests |
| `GET /api/rooms/*` (room occupancy) | covered by #42 review (PR #41) | covered by #42 review | covered by #42 review | covered by #42 review | covered by #42 review |
| `POST /api/chat` | none | 30 (own scope, shared 429 body); also 1 in-flight Claude turn per IP and 4 in total (beyond that the same shared 429 body, `retry-after: 2`) | `no-store` | hand-validated: body ≤ 32 KiB (413), ≤ 24 messages, user turns ≤ 1000 chars, assistant turns ≤ 2000, `via` enum, conference and known-profile fields capped. Errors name the field only | The next chat reply and, when done, the profile the visitor just typed, to that caller only. Nothing is stored. Message text and profiles are never logged or put on spans (only route and status code) |
| `GET /api/events` | none | 30 (own scope, shared 429 body); at most 3 concurrent streams per IP (shared 429 body) inside 20 in total (503 `too_many_listeners`) | `no-cache`, `no-transform` (SSE stream) | none (no input) | `registered` frames: label `Guest` (never a name by default; with the demo-only `EVENTS_SHOW_NAMES=on` the sanitised first name, letters and digits only, capped), conference slug, returning flag, interest count. Heartbeat comment every 20 s. Nothing else about the attendee |
| `GET /api/rooms/placement` | `x-organizer-key` (constant-time compare; 503 in production if unset) | 60 (own scope, shared 429 body) | 15 s in memory, after authorization; `Cache-Control: no-store` | none (no input) | Room suggestions from aggregate interest counts (k-suppressed) and `ROOM_CAPACITIES`. Database errors answer a fixed `502 placement_unavailable`; error text is neither logged nor on spans |
| `GET /api/auth/providers` | none | 30 (own scope, shared 429 body) | `no-store` | none (no input) | Which providers are enabled (`id`, `enabled`). Never ids, secrets or redirect URIs |
| `GET /api/auth/:provider/start` | none | 30 (own scope, shared 429 body) | `no-store` | zod: `:provider` ≤ 32 chars then checked against github (unknown or unconfigured is 404); `return` ≤ 512 chars and must be a same-origin relative path (starts with one `/`, no `//`, no backslash, no scheme or control characters; 400 otherwise); `app` ≤ 8 chars | A 302 to the provider carrying a random one-time `state` (kept in memory 10 minutes, at most 2000 entries) The client id is visible in that URL; the secret never leaves the server |
| `POST /api/auth/:provider/callback` | none (the one-time `state` is the proof) | 30 (own scope, shared 429 body) | `no-store` | zod: body ≤ 4 KiB, `code` 1 to 2048 chars, `state` 1 to 128 chars; unknown fields dropped. Bad, expired, reused or other-provider state is 400 `invalid_state`; provider failure is a fixed 502 `provider_error` | The linked account as the provider reported it: `provider`, `displayName` (≤ 80), optional `handle` and https `avatarUrl`, the validated `return` path and the `app` flag. No tokens, no email. Codes, tokens and profile fields are never logged or put on spans (only route and status code); nothing is stored |
| any unknown route | — | — | — | — | Fixed `404 { "error": "not_found" }`. The raw path/query is not echoed (Fastify's default message did echo it) |

### Error shapes

All 4xx responses are JSON `{ "error": "<code>", "message"?: "<text>" }`.
Validation messages name the field and the rule, never the submitted value.
Database errors are never forwarded. Search routes answer
`502 { error: "search_unavailable" }` or `503 { error: "search_overloaded" }`
with `Retry-After`. Aggregate/clusters answer `502 aggregate_unavailable`/
`clusters_unavailable`, and register/me/access answer `503 storage_unavailable`.
Database error text can contain query text or row values (and so attendee IDs),
so it is neither logged nor put on spans. Only `error.type` and the HTTP
status are logged.

## Privacy controls

- **Signed tokens.** Session tokens and QR access tokens are HS256 JWTs signed
  with `TOKEN_SIGNING_KEY` from a Kubernetes Secret. QR tokens carry a separate
  audience and a short TTL. Production refuses to start without the key
  (`api/src/config.ts`, `api/src/auth/token.ts`).
- **Server-side entitlement checks.** `/api/access/scan` looks up the
  entitlement and attendee expiry in the database on every scan and fails closed (503,
  never `allow`) if the lookup errors (`api/src/routes/access.ts`).
- **k ≥ 5 suppression.** Interest aggregates and clusters never return a
  group under 5 attendees (`api/src/interests/aggregate.ts`,
  `api/src/routes/clusters.ts`), and every registered attendee is counted unless their stored `consent.cluster_map` is false
  (the interest map is not an opt-in; k-anonymity is the protection).
- **Retention (profiles kept by default).** Attendee profiles, entitlements
  and schedules are kept so the next conference can recommend talks from the
  first minute. `ATTENDEE_RETENTION_HOURS` (unset or 0 keeps; e.g. 24 deletes
  after that long) controls it; when set, docs carry `expires_at` = registration
  + that period and the CronJob deletes expired docs
  (`deploy/k8s/app/retention-cronjob.yaml`, `docs/retention.md`). `/api/me`
  and access checks reject expired attendees. Session tokens, QR tokens, scan
  logs and room-activity windows stay short-lived. Attendees can delete
  their own data: `DELETE /api/me` (bearer token) removes the entitlements,
  schedule and profile, and the site's profile page has "Delete my data"
  (it also clears what this browser stores). No export exists yet (see Open
  items in `docs/retention.md`).
- **Telemetry attribute allowlist.** Spans go through `withSpan`, which drops
  any attribute that is not on the allowlist, and the OTel collector scrubs
  again (`docs/telemetry-allowlist.md`). Attendee IDs are never logged or put
  on spans. **Raw URL in telemetry/logs: fixed by #40** (drop `url.path` from
  exported attributes, keep `http.route`, and request-serializer
  hardening).
- **Database access.** The API connects with `DATABASE_URL` and verifies the database certificate against system
  roots or a configured private CA (`docs/database.md`).
- **TLS.** In-cluster API TLS and ingress TLS are optional environment-level configuration. The application base does
  not require a specific ingress controller or certificate issuer.

## Tests

`api/test/security.test.ts` covers:

- One 429 body shape (`statusCode`, `error`, `message`) across scopes with
  default and custom error handlers (search, status, register, suggest).
- The largest valid onboarding tag set (1000 × 100 chars) gets a 200, not a
  413, and 1001 entries get a clean 400.
- 429 with the shared body on search, catalog topics, status, interests
  aggregate, interests clusters and onboarding.
- A catalog topics cache hit makes no second database call.
- Per-IP buckets.
- `/healthz` is never limited.
- An aggregate cache hit makes no second database call.
- Oversized onboarding answers get 400 without echoing input. Non-string
  entries get a 400 that names the field. A selection of more than 20 topics
  is cut to the first 20 instead of being rejected.
- An oversized body gets 413.
- An oversized `q` gets 400.
- A 404 does not echo the path or query.

Register and access-scan limits are covered by `proxy.test.ts` and
`access.test.ts`.
The talk routes' 429 body and `Retry-After` are checked in
`api/test/talks.test.ts`.

## Hosting and repository settings

Apply these settings after taking ownership of the repository. They need
admin access to GitHub or access to Cloudflare.

1. Add a ruleset on `main`:
   - Require a pull request and code-owner review.
   - Require the status checks `build-test`, `docker`, `secrets` and `axe`.
   - Block force pushes and deletion.
   - Allow bypass only for repository admins, and only when merging a pull
     request.
2. Collaborators may keep write access. The `main` ruleset requires a pull
   request, green checks and code-owner (`@ecan0`) approval; only repository
   admins can bypass, and only when merging a pull request.
3. Set the Actions options:
   - Allow only the actions in use.
   - Turn on "Require actions to be pinned to a full-length commit SHA".
   - Set the default workflow token to read-only.
   - Do not let Actions create or approve pull requests.
   - Require approval for fork pull request workflows from all outside
     contributors.
4. Turn on Dependabot alerts and security updates, secret scanning with push
   protection, private vulnerability reporting, and CodeQL default setup.
5. Uninstall the Gitar app, or confirm that it cannot push.
6. For the GHCR packages `conference-companion-api` and `-web`, limit Actions
   access to this repository. After the transfer, CI pushes to
   `ghcr.io/ecan0/conference-companion-{api,web}`. Then change:
   - the overlay `images:` names;
   - the Argo CD Application `repoURL`;
   - the AppProject `sourceRepos`.
7. In Cloudflare (applied on 2026-11-13 for `ecan.pro`):
   - A rate-limiting rule for `/api/*`: 100 requests per 10 s per IP, then
     block for 10 s. Cloudflare counts per data centre, so the limit is
     approximate across the network.
   - Bot Fight Mode on, Always Use HTTPS on, minimum TLS version 1.2.
   - Cloudflare Bot Fight Mode adds "JavaScript detections": an inline script
     that Cloudflare injects into each HTML page at the edge. The page's
     Content-Security-Policy (`script-src 'self'`) blocks it, so the browser
     console shows one CSP message per page. The site works. To remove the
     message, turn off JavaScript detections (Security > Bots). Do not add
     `'unsafe-inline'` to `script-src`: the script differs on each request.
8. On the Supabase free tier, registrations are kept forever. Check the
   database size each month. The project pauses after a week of inactivity.
   On 2026-11-13 the database was 32 MB of the 500 MB limit.
9. The lab guardrails (namespace, Pod Security, NetworkPolicies, AppProject)
   live in toghouse-monorepo. Read the diff before each manual Argo CD sync.
