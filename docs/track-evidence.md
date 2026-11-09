# Demo evidence

Capture links, screenshots, and observations here as the demo environment is
validated.

## Judge swimlanes and claim gates

Lane names are presentation labels, not proof of integration. Follow the Design
Doc: Elasticsearch, Radar and Dash0 are depth tracks; Sonar/Gitar is a light
entry only after a real review finding is acted on.

| Judge lane | Design Doc evidence required | Current evidence gap |
| --- | --- | --- |
| Sonar: Never Merge Broken | Gitar repo rules, PR review, acted-on finding and CI diagnosis | Gitar review findings acted on, including verified PR #6 probe fix below. CI diagnosis and project-rule evaluation still need evidence. No Sonar tooling claim. |
| Dash0: Stop Flying Blind | Browser → API → ES trace, search/embedding/access spans, p95 SLO, dashboard, scrubbing proof, real issue investigation | Collector-to-Dash0 export and synthetic attribute scrubbing verified live. Browser/API/ES trace, full privacy test, SLO and issue evidence remain pending. |
| Radar: AI SRE | Ready Kubernetes workloads, UI and MCP used, real investigation with remediation | Live: kind cluster, Radar UI + read-only MCP (28 tools) connected, api/web/ES Ready. Real-investigation story still to be captured (see Radar section). |
| Elasticsearch: Find the Right Talk | Real catalog and ES inference per human decisions; BM25 vs hybrid results and query comparison | Live: 417 real talks indexed with ES E5, keyword and hybrid APIs return 200. All five planned comparisons measured; they do not establish a consistent relevance win. Results in `docs/demo/search-comparison-measured.json`; quality work is #36. |

Do not substitute scaffold/mock routes for end-to-end acceptance. A `/healthz`
response alone does not verify Elasticsearch inference or token entitlements.
Controlled faults must be explicitly labelled as controlled.

Operational priorities: the cluster exists (see Radar section), so next are the real-catalog
seed with ES inference, the registration → schedule → QR flow, live Dash0 export (needs the
`dash0-credentials` Secret) and a recorded fallback. TLS gaps are tracked in #24.
Conditional map/navigation work must preserve the consent, k≥5 and simulated-replay
boundaries in the Design Doc.

## Gitar findings acted on

Gitar requested changes on PR #1 and PR #3; both were merged before the findings
were addressed. They are fixed in PR #25's branch (`task/25-fix-open-gitar-findings-on-mer`).
The fix commit is the PR link until the merge hash is known.

- Finding: `TOKEN_SIGNING_KEY` silently falls back to a public hardcoded key in production (`api/src/config.ts`).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: `loadConfig` throws in `NODE_ENV=production` when `TOKEN_SIGNING_KEY`, `ES_URL`, `ES_USERNAME` or `ES_PASSWORD` is missing or empty; the dev fallback stays outside production. Tests: `api/test/config.test.ts`.
  Fix commit: this fix's PR (hash pending merge).
- Finding: repeated `q` param crashes `/api/search` with a 500 (PR #1).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: the search route rejects non-string `q` with 400 `invalid_request`. Test: `GET /api/search repeated params` in `api/test/search.routes.test.ts`.
  Fix commit: this fix's PR (hash pending merge).
- Finding: any caller can read or overwrite any attendee's schedule via an unsigned `Bearer stub.<id>` header (`api/src/routes/search.ts`).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: `defaultResolveAttendee` always returns the stub attendee; `resolveAttendee` stays injectable for tests and for the signed-token work. Test: header spoofing cannot reach another attendee's schedule.
  Fix commit: this fix's PR (hash pending merge).
- Finding: the 24h schedule `expires_at` is written but never enforced on read (`api/src/search/service.ts`).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: the schedule store treats a doc whose `expires_at` has passed as missing. The scheduled purge is left to task #15. Test: expired and unexpired docs on `GET /api/schedule`.
  Fix commit: this fix's PR (hash pending merge).
- Finding: `GET /api/schedule` and the talk-id lookup create no OpenTelemetry span (PR #3).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: `schedule.load` and `talks.fetch` spans via `withSpan`, with no attributes (no attendee ids). Test: span names and empty attributes on `GET /api/schedule`.
  Fix commit: this fix's PR (hash pending merge).
- Finding: default hybrid mode queries `content_semantic`, which was missing from the talks mapping (PR #3).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: already fixed by task #19 (PR #4), nothing further here.
- Finding: the room-scan stub grants access without validating tokens (PR #1, high risk).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: not fixed here. It belongs to task #11 (real token validation), noted there.

- Finding (PR [#6](https://github.com/DL4P1N/Kubecon-2026/pull/6), Gitar "Changes requested"): web startup/liveness probes proxied to API `/healthz`, so an API outage would restart healthy nginx.
  Change: web startup/liveness now probe local `/index.html`; proxied `/healthz` kept for readiness only (`deploy/k8s/app/deployments.yaml`, commit `87ebf1b`).
  Verified live (CONTROLLED API outage, ~40s): `/index.html` stayed 200, `/healthz` returned 504, web `Ready=False`, nginx restarts 0 to 0; API restored and `/healthz` back to 200.

Still pending: CI-failure diagnosis and the review link for the demo.

## Elasticsearch real issues

### Search 502 during E5 warm-up (natural incident)

- What happened: on the kind cluster (ES 8.19.6, 417 talks seeded with
  `.multilingual-e5-small-elasticsearch`), `GET /api/search?mode=hybrid` returned
  502 `search_unavailable` while keyword search returned 200 and a direct
  `companion_svc` RRF query returned hits. It happened during the E5 inference
  seed and warm-up, when the ML node did not have capacity to start the model.
  The API mapped every Elasticsearch failure to a generic 502, so the original
  ES error body was not preserved.
- What was found (by ecan0-omp, from the cluster): ML memory was the limit.
  `xpack.ml.max_machine_memory_percent` was raised from 30% to 50%. After that
  hybrid search returned 200 with real hits, matching the direct RRF query.
- What changed (task #35): `EsError` keeps the ES `error.type` and HTTP status;
  `withSpan` records the type as the `error.type` span attribute; the search error
  handler writes one log line with the type and status only (no query text, ids,
  credentials or ES body). ES overload (429, `inference_exception`,
  `circuit_breaking_exception`, `es_rejected_execution_exception`) now returns 503
  `search_overloaded` with `Retry-After`; other ES failures stay 502. Hybrid does not
  fall back to keyword on overload, so the incident stays visible. Tests:
  `Elasticsearch failures are diagnosable` in `api/test/search.routes.test.ts`
  and `EsError classification` in `api/test/es.test.ts`.
- Not yet captured: a Dash0 trace or log of the incident, and a Radar
  investigation. Add links here if they exist; none are claimed. `error.type` and
  `http.route` are added to the collector allowlist and both collector configs
  (same lines as the OTel task #12, so the two merge cleanly).

## Radar

- Cluster: new local kind cluster `conference-companion` (Kubernetes v1.37.0, arm64),
  kubeconfig `~/.kube/conference-companion`, namespace `conference-companion`.
  The human chose a new cluster over `toghouse`, which was never modified.
- Radar OSS 1.20.2 runs locally against that kubeconfig (`--namespace-scope --mcp-read-only
  --disable-exec --disable-local-terminal`), UI on `127.0.0.1:9280`. The MCP endpoint
  `/mcp-readonly` initialised and listed 28 read-only tools. Radar's dashboard showed
  api/web/elasticsearch pods and services in the namespace.
- Deployed and verified: api + web Deployments Ready, proxied `/healthz` returns
  `{"status":"ok"}` HTTP 200, on `node:22-alpine` images (the Node 20 `EBADENGINE` warning for
  `cookie@2.0.2` is gone).
- Final offline validation: yamllint passed; strict kubeconform reported **9 valid,
  0 invalid, 0 errors, 0 skipped** across app/seed and ES resources.
  Server-side `apply --dry-run=server` passed on the new cluster.

### Real incident: Elasticsearch ML capacity (natural, not injected)

- Symptom: the catalog seed Job failed with HTTP 429 `inference_exception`,
  "no ML nodes with sufficient capacity".
- Diagnosis (Elasticsearch API, not Radar): ML memory was the default 30% of the 4Gi limit,
  1228mb total / 1188mb effective. The built-in `.multilingual-e5-small` needs
  `per_deployment_memory_bytes` 470MB + `per_allocation_memory_bytes` 558MB plus native
  overhead, about 1.27GB, so it could never allocate.
- Fix: `xpack.ml.max_machine_memory_percent=50` (2048mb), set live and persisted as an env
  var in `deploy/k8s/elasticsearch/statefulset.yaml`.
- Recovery: the seed Job completed 1/1 in 7m57s; index count **417**. E5 reported
  `started` / `fully_allocated`. ES cgroup memory was 2,675,273,728 bytes under its
  4Gi limit. Direct RRF and deployed keyword/hybrid search returned HTTP 200.
- The first deployed hybrid request returned 502 during indexing; it succeeded
  after seed completion. Its original backend error was not retained, so the
  cause of that transient request is unconfirmed (diagnostics work tracked in #35).
- Honesty note: Radar surfaced the failed Job/pod state, but the root cause came from ES.

### Controlled fault (labelled controlled)

- API scaled to 0 for ~40s to verify the Gitar probe fix above. Radar MCP `diagnose`
  reported `workload_degraded` / `0/1 available`. This is a controlled test, not a natural incident.

### Evidence boundaries

- Screenshots: [Radar overview](demo/radar-overview.png) and
  [actual topology](demo/radar-topology.png) show the live namespace.
  Radar AI investigation is tracked separately in #30.
- Dash0 credentials provisioned privately in `dash0-credentials`; collector rollout succeeded.
  An actual OTLP probe returned HTTP 200. Collector metrics showed
  `otlphttp/dash0` sent spans = 1, failed spans = 0, queue = 0.
  Its debug exporter retained `search.mode=hybrid` and removed the synthetic private
  `attendee.id` / `geo.location` values. This proves collector-to-Dash0 export and the
  basic scrub, not the browser-to-API-to-ES trace or complete privacy-flow test.
- TLS is end-to-end only for ES; web to api and api to collector are plaintext HTTP (board #24).
- `TRUST_PROXY=1` is consumed by the upstream #27 implementation; verified inside
  the actual API pod (`trustProxyHops: 1`, Node v22.23.4). Configuration/proxy tests:
  10 passed after installing current upstream dependencies.

## Dash0

- End-to-end trace (browser -> api -> Elasticsearch) for one `/api/search`
  request: screenshot goes here (`docs/evidence/dash0-search-trace.png`),
  with the trace id. Pending: needs the deployed collector with Dash0 credentials.
- Allowlist proof: the same trace's span attributes show `search.mode` and no
  `attendee.id` (unit test: `api/test/telemetry.test.ts`). Screenshot: pending.
- Metrics: `http.server.request.duration` by `http.route`,
  `companion.search.duration`, `access.scans` dashboard. Screenshot: pending.
- SLO (p95 search latency) and Agent0 / Dash0 MCP investigation: pending.
- How to reproduce locally: `docs/observability.md`.

## Accessibility

- Real-browser check: Edge on Windows, 2026-11-09; 11 Playwright tests passed.
- Axe WCAG 2 A/AA and WCAG 2.1 AA checks on register, onboarding, schedule
  (with generated QR), populated keyword/hybrid search and kiosk at 375px and
  1280px widths: zero serious or critical violations. No horizontal overflow.
- Keyboard-only registration: skip link to main, visible focus outline,
  labelled fields, topic selection, both consent choices off, submit and
  arrival at onboarding verified. Added skip link and wrapping navigation.
- Run `npm run test:a11y -w web`; on a machine using installed Edge set
  `PLAYWRIGHT_CHANNEL=msedge`. CI installs Chromium and runs the same checks.
- Tests use synthetic, mocked API responses. This verifies rendered UI and
  keyboard behavior, not backend correctness or a manual screen-reader audit.
