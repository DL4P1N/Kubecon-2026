# Demo evidence

Capture links, screenshots, and observations here as the demo environment is
validated.

## What's real vs pending

Audit snapshot: 2026-11-09. Merged implementation and test results are not a
substitute for a live deployment check. Operator-local URLs are not public
artifacts; the committed screenshots/JSON and PRs below are the portable evidence.

| Area | Observed or merged evidence | Still pending or not observed |
| --- | --- | --- |
| Elasticsearch | [417-talk live 12-query report](https://github.com/DL4P1N/Kubecon-2026/pull/27#issuecomment-6749696162): hybrid 5 wins / 7 ties / 0 losses, hit@3 5/12 vs 0/12, MRR@10 0.306 vs 0.017 | Majority-win criterion not met; [report/docs PR40](https://github.com/DL4P1N/Kubecon-2026/pull/40) is separate from merged evaluator PR27 |
| Radar | [Actual AI run + follow-up](#actual-radar-ai-investigation-task-30), [merged PR37](https://github.com/DL4P1N/Kubecon-2026/pull/37), committed verdict/screenshot | Original capacity diagnosis was via ES APIs; controlled outage is not a natural incident |
| Dash0 | [Collector export/scrub probe](#evidence-boundaries); [SDK PR15](https://github.com/DL4P1N/Kubecon-2026/pull/15), [privacy tests PR30](https://github.com/DL4P1N/Kubecon-2026/pull/30), [dashboard/SLO code PR33](https://github.com/DL4P1N/Kubecon-2026/pull/33) merged | Complete app trace and live dashboard/SLO screenshots await verified rollout after [PR #32](https://github.com/DL4P1N/Kubecon-2026/pull/32); Agent0 remediation and raw URL/path findings are being handled in board task #40 |
| Gitar | [Rules 1/1](#repository-rule-verification-task-34), [fix PR8](https://github.com/DL4P1N/Kubecon-2026/pull/8), [probe fix PR6](https://github.com/DL4P1N/Kubecon-2026/pull/6), [requested retrospective CI diagnosis](gitar-ci-diagnosis.md#verified-diagnosis-after-an-explicit-request-on-an-open-pr) | Automatic CI-failure triggering and auto-apply remain unproven; functional validation not enabled; no Sonar tooling claim |
| TLS | [TLS overlay PR31](https://github.com/DL4P1N/Kubecon-2026/pull/31) and trust/hostname tests merged | [Live overlay/browser trust validation](../deploy/k8s/tls/README.md) pending; current app/collector transport must not be called verified end-to-end TLS |
| Demo | [Labelled mock-API UI fallback](demo/recording.md), [runbook/seed PR34](https://github.com/DL4P1N/Kubecon-2026/pull/34) | Real deployed attendee-flow recording and presenter review remain separate gates |

## Judge swimlanes and claim gates

Lane names are presentation labels, not proof of integration. Follow the Design
Doc: Elasticsearch, Radar and Dash0 are depth tracks; Sonar/Gitar is a light
entry only after a real review finding is acted on.

| Judge lane | Design Doc evidence required | Current evidence gap |
| --- | --- | --- |
| Sonar: Never Merge Broken | Gitar repo rules, PR review, acted-on finding and CI diagnosis | [Rules 1/1](#repository-rule-verification-task-34), acted-on findings and [explicitly requested CI diagnosis](gitar-ci-diagnosis.md) verified. Automatic triggering/auto-apply remain unproven. No Sonar tooling claim. |
| Dash0: Stop Flying Blind | Browser → API → ES trace, search/embedding/access spans, p95 SLO, dashboard, scrubbing proof, real issue investigation | Collector probe verified live; [full privacy test PR30](https://github.com/DL4P1N/Kubecon-2026/pull/30) merged. Live app trace, SLO/dashboard data and issue-remediation artifact remain pending. |
| Radar: AI SRE | Ready Kubernetes workloads, UI and MCP used, real investigation with remediation | Live UI/MCP and an actual safeguarded Codex AI investigation captured below, with evidence, verified follow-up and linked fix. Human review of #30 pending. |
| Elasticsearch: Find the Right Talk | Real catalog and ES inference per human decisions; BM25 vs hybrid results and query comparison | [12-query live report](https://github.com/DL4P1N/Kubecon-2026/pull/27#issuecomment-6749696162): 417 talks, 5 hybrid wins / 7 ties / 0 losses. Majority-win criterion not met; earlier five-query raw results remain committed. |

Do not substitute scaffold/mock routes for end-to-end acceptance. A `/healthz`
response alone does not verify Elasticsearch inference or token entitlements.
Controlled faults must be explicitly labelled as controlled.

Operational priorities: verify the latest deployed registration → schedule → QR flow,
the full app telemetry path and live dashboard/SLO data. The real catalog is
seeded and collector credentials are provisioned. The offline fallback exists;
live recording and TLS rollout remain pending. See the status table above.
Conditional map/navigation work must preserve the consent, k≥5 and simulated-replay
boundaries in the Design Doc.

## Gitar findings acted on

Board task #62 added four focused privacy/protection checks alongside the
original project check. [PR55's Gitar dashboard](https://github.com/DL4P1N/Kubecon-2026/pull/55#issuecomment-6750358094)
reports "Rules 5/5 met", "5 passed", naming attendee aggregate privacy,
identifier/token exposure, public endpoint protections, telemetry allowlist
synchronization and the original project requirements. This proves static
configuration evaluation on that PR, not runtime compliance. The prior head
listed only four checks; the aggregate check ran after its trigger explicitly
named its own repository path.

Gitar requested changes on PR #1 and PR #3; both were merged before the findings
were addressed. The initial fixes merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8)
as [39fe521](https://github.com/DL4P1N/Kubecon-2026/commit/39fe521c).
Later signed-session/access implementations are linked explicitly below.

- Finding: `TOKEN_SIGNING_KEY` silently falls back to a public hardcoded key in production (`api/src/config.ts`).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: `loadConfig` throws in `NODE_ENV=production` when `TOKEN_SIGNING_KEY`, `ES_URL`, `ES_USERNAME` or `ES_PASSWORD` is missing or empty; the dev fallback stays outside production. Tests: `api/test/config.test.ts`.
  Initial fix merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8) (39fe521).
- Finding: repeated `q` param crashes `/api/search` with a 500 (PR #1).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: the search route rejects non-string `q` with 400 `invalid_request`. Test: `GET /api/search repeated params` in `api/test/search.routes.test.ts`.
  Initial fix merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8) (39fe521).
- Finding: any caller can read or overwrite any attendee's schedule via an unsigned `Bearer stub.<id>` header (`api/src/routes/search.ts`).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Initial change: removed caller-selected stub identity. The current signed-session
  implementation is [PR #22](https://github.com/DL4P1N/Kubecon-2026/pull/22): schedules
  require a verified attendee token and reject missing, stub, tampered and expired tokens.
  Initial fix merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8) (39fe521).
- Finding: the 24h schedule `expires_at` is written but never enforced on read (`api/src/search/service.ts`).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: the schedule store treats expired docs as missing. Cleanup is implemented
  in [PR #11](https://github.com/DL4P1N/Kubecon-2026/pull/11), with standalone telemetry
  in [PR #29](https://github.com/DL4P1N/Kubecon-2026/pull/29). Live CronJob execution
  is still separate from these code/test results.
  Initial fix merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8) (39fe521).
- Finding: `GET /api/schedule` and the talk-id lookup create no OpenTelemetry span (PR #3).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: `schedule.load` and `talks.fetch` spans via `withSpan`, with no attributes (no attendee ids). Test: span names and empty attributes on `GET /api/schedule`.
  Initial fix merged in [PR #8](https://github.com/DL4P1N/Kubecon-2026/pull/8) (39fe521).
- Finding: default hybrid mode queries `content_semantic`, which was missing from the talks mapping (PR #3).
  PR: [#3](https://github.com/DL4P1N/Kubecon-2026/pull/3).
  Change: fixed by [real-catalog/semantic_text PR #4](https://github.com/DL4P1N/Kubecon-2026/pull/4).
- Finding: the room-scan stub grants access without validating tokens (PR #1, high risk).
  PR: [#1](https://github.com/DL4P1N/Kubecon-2026/pull/1).
  Change: fixed by [PR #21](https://github.com/DL4P1N/Kubecon-2026/pull/21),
  which verifies access-audience signed tokens and checks live server-side
  entitlements on every scan. Tests cover allow, deny, expiry and revocation;
  cluster/camera acceptance must be verified independently.

- Finding (PR [#6](https://github.com/DL4P1N/Kubecon-2026/pull/6), Gitar "Changes requested"): web startup/liveness probes proxied to API `/healthz`, so an API outage would restart healthy nginx.
  Change: web startup/liveness now probe local `/index.html`; proxied `/healthz` kept for readiness only (`deploy/k8s/app/deployments.yaml`, commit `87ebf1b`).
  Verified live (CONTROLLED API outage, ~40s): `/index.html` stayed 200, `/healthz` returned 504, web `Ready=False`, nginx restarts 0 to 0; API restored and `/healthz` back to 200.

An explicitly requested retrospective CI diagnosis is now verified; see the
[specific audit](gitar-ci-diagnosis.md). Automatic triggering and auto-apply
remain unproven.

Task #44 initially audited two real failed Actions runs (PR14 Docker build and PR22
schedule browser tests). Their current Gitar dashboards contain Code Review,
without retained CI-analysis output. PR14's missing-fixture finding predates
the actual failure, so it proves useful review, not CI-log analysis. The fix
and subsequent green run are linked in the [CI evidence audit](gitar-ci-diagnosis.md).
The first retrospective request received a generic reply, which is not evidence.
A later [explicit request on open PR39](https://github.com/DL4P1N/Kubecon-2026/pull/39#issuecomment-6749839603)
received [substantive log-backed diagnosis](https://github.com/DL4P1N/Kubecon-2026/pull/39#issuecomment-6749861362)
of PR23's real keyboard-test failure. It identified the asynchronous topic-load
race and the already-authored readiness-wait fix; the fixed-head CI passed.
This proves requested CI-log access/analysis, not automatic triggering or a
Gitar-authored fix. The earlier lack-of-access hypothesis is resolved without
inventing a settings or plan restriction. See the audit for the distinct
historical requests and causal limits.
The owner reports automatic reviews work and the documented toggle is not
visible in their dashboard. No permission changes or auto-apply were needed.

### Repository-rule verification (task #34)

The existing `.gitar/review/` files are review guidance. Prior PR dashboards
reported Rules as "No rules evaluated"; those reviews do not prove execution
of a repository rule. `.gitar/rules/conference-companion-check.md` adds an
explicit project check with documented frontmatter. Verified on
[PR #25's Gitar dashboard](https://github.com/DL4P1N/Kubecon-2026/pull/25#issuecomment-6749180455):
"Rules 1/1 met", "1 passed". The check states that this docs/config-only PR
preserves all seven project requirements and explicitly limits the result
to static review. This proves repository-rule execution on this PR, not
runtime compliance or a separate Knowledge-library fact citation.
The human confirmed a Pro trial. Functional validation remains "Not enabled"
and requires Enterprise.
Requested retrospective CI diagnosis is verified separately in the
[CI evidence audit](gitar-ci-diagnosis.md); automatic triggering and auto-apply
are not claimed.

## Elasticsearch real issues

### Search 502 during E5 warm-up (natural incident)

- What happened: during the E5 inference seed on the kind cluster, the first deployed
  `GET /api/search?mode=hybrid` returned 502 `search_unavailable` while keyword search and
  a direct `companion_svc` RRF query returned 200. The API mapped every Elasticsearch
  failure to a generic 502, so the original ES error body was not preserved and the cause
  of that one request is unconfirmed. The related seed failure (429 `inference_exception`,
  "no ML nodes with sufficient capacity") and its fix (`xpack.ml.max_machine_memory_percent`
  30% to 50%, by ecan0-omp) are under Radar, "Real incident: Elasticsearch ML capacity".
- What changed (task #35): `EsError` keeps the ES `error.type` and HTTP status; the span
  gets the allowlisted `error.type` attribute; the search error handler writes one log line
  with the type and status only (no query text, ids, credentials or ES body). ES overload
  (429, `inference_exception`, `circuit_breaking_exception`,
  `es_rejected_execution_exception`) now returns 503 `search_overloaded` with
  `Retry-After`; other ES failures stay 502. Hybrid does not fall back to keyword on
  overload, so an incident stays visible. Tests: `Elasticsearch failures are diagnosable`
  in `api/test/search.routes.test.ts` and `EsError classification` in `api/test/es.test.ts`
  (realistic 429 and 400 ES bodies, production logger options). The implementation
  merged in [PR #26](https://github.com/DL4P1N/Kubecon-2026/pull/26). The later
  [attendee-facing fallback PR #38](https://github.com/DL4P1N/Kubecon-2026/pull/38)
  can retry keyword search with an explicit UI notice; the API error remains visible.
- Not captured: a Dash0 trace or log of this request, or a Radar investigation of it. None
  is claimed.

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
- Evidence boundary: the initial memory-budget diagnosis used the ES API. The later
  Radar AI investigation independently identified a retained model-scaling capacity
  failure in the application's logs; it did not claim that inference was still down.

### Actual Radar AI investigation (task #30)

Request: diagnose the real `StatefulSet.apps conference-companion/elasticsearch`.
This was a read-only investigation of a naturally occurring application problem,
not the controlled API outage described below.

```sh
kubectl radar diagnose statefulset/elasticsearch \
  --namespace conference-companion --agent codex --profile safeguarded \
  --server http://127.0.0.1:9280 --yes --json
```

- Durable local run: [`run-cc6b489d18`](http://127.0.0.1:9280/?ai-run=run-cc6b489d18).
  [Actual AI verdict and evidence references](demo/radar-ai-investigation.json),
  [UI screenshot](demo/radar-ai-investigation.png), and
  [operator follow-up measurements](demo/radar-ml-verification.json) are committed.
- Radar used `diagnose`, filtered `get_pod_logs`, and `get_cluster_audit`.
  It found a real ES log entry at 19:07:29 UTC: the multilingual model could not
  scale to two allocations because of insufficient resources, even though the
  Kubernetes replica was Ready. Its verdict was **likely**, not proof of a
  continuing outage.
- What we learned: the HTTPS root readiness probe proves the ES process responds,
  not that ML inference can allocate. A missing liveness probe and hardening
  findings were correctly kept separate from the capacity diagnosis.
- Radar explicitly requested current model-allocation and ML-memory checks rather
  than claiming the old log established present-day failure. We ran those checks
  through authenticated, CA-verified ES admin APIs: model `started`,
  `fully_allocated`, allocation **1 / target 1**, 842 completed inference calls
  and one historical timeout. Native inference memory was **1,497,914,672 bytes**
  plus **31,457,280 bytes** native overhead under a **2,147,483,648-byte** ML budget.
  These measurements are operator-collected, not falsely attributed to Radar.
- Linked remediation: [PR #6](https://github.com/DL4P1N/Kubecon-2026/pull/6),
  merged as `7d4a704`, persists the
  [50% ML budget](https://github.com/DL4P1N/Kubecon-2026/blob/7d4a704/deploy/k8s/elasticsearch/statefulset.yaml).
  The initial seed failed at the default 30%; after correction it indexed 417
  real talks in 7m57s, and real keyword/RRF API requests succeeded.
- Limits: the deleted first failed seed pod's original logs were not re-created.
  The later two-allocation log does not by itself prove why that allocation
  failed or that all future scaling will fit; the verified serving target is one
  allocation. The controlled outage remains explicitly labelled below.


### Controlled fault (labelled controlled)

- API scaled to 0 for ~40s to verify the Gitar probe fix above. Radar MCP `diagnose`
  reported `workload_degraded` / `0/1 available`. This is a controlled test, not a natural incident.

### Evidence boundaries

- Screenshots: [Radar overview](demo/radar-overview.png) and
  [actual topology](demo/radar-topology.png) show the live namespace.
  The actual AI run, screenshot, source fix and follow-up are recorded above (#30).
- Dash0 credentials provisioned privately in `dash0-credentials`; collector rollout succeeded.
  An actual OTLP probe returned HTTP 200. Collector metrics showed
  `otlphttp/dash0` sent spans = 1, failed spans = 0, queue = 0.
  Its debug exporter retained `search.mode=hybrid` and removed the synthetic private
  `attendee.id` / `geo.location` values. This proves collector-to-Dash0 export and the
  basic scrub, not the browser-to-API-to-ES trace or complete privacy-flow test.
- ES TLS was verified live. The app/collector TLS overlay merged in
  [PR #31](https://github.com/DL4P1N/Kubecon-2026/pull/31), with trusted-CA and
  wrong-host rejection tests. App/collector rollout and browser trust verification
  remain pending; merged YAML is not evidence of live end-to-end TLS.
- `TRUST_PROXY=1` is consumed by the upstream #27 implementation; verified inside
  the actual API pod (`trustProxyHops: 1`, Node v22.23.4). Configuration/proxy tests:
  10 passed after installing current upstream dependencies.

## Dash0

- End-to-end trace (browser -> api -> Elasticsearch) for one `/api/search`
  request: screenshot goes here (`docs/evidence/dash0-search-trace.png`),
  with the trace id. Collector credentials/export are verified; full app-trace proof
  awaits verified app rollout after the
  [production-image dependency fix PR #32](https://github.com/DL4P1N/Kubecon-2026/pull/32).
- Privacy test evidence: [merged PR #30](https://github.com/DL4P1N/Kubecon-2026/pull/30)
  exercises registration, search, allow and revoked scan with an in-memory span
  exporter and captured logs, and checks collector allowlist configuration. It
  does not execute a real collector. The corresponding live trace screenshot
  remains pending; additional raw URL/path findings are being handled in board task #40.
- Metrics: `http.server.request.duration` by `http.route`,
  `companion.search.duration`, `access.scans` dashboard. Screenshot: pending.
- SLO (p95 search latency) and Agent0 / Dash0 MCP investigation: pending.
- Dashboard, SLOs and check rules as code (#14, PR [#33](https://github.com/DL4P1N/Kubecon-2026/pull/33)):
  [Operator persistence record](evidence/dash0-live-definitions.json) from the
  saved `fe34415` checkpoint reports the official Dash0 CLI applied one
  dashboard, six check rules and two SLOs and confirmed them by list calls.
  This is persisted-definition evidence, not a measurement of live panel data
  or SLO correctness. The 6h slow-burn rule required a 5-minute evaluation
  interval; the record describes that API constraint and subsequent apply.
  The query was unchanged, but its interval changed: at this snapshot the
  checked-in `deploy/dash0/check-rules.yaml` still puts it in a 1m group.
  Re-applying that source will repeat the rejection until the slow-burn rule
  moves to its own 5m group. This source/live drift remains a follow-up fix.
  No new live calls or traffic were generated to publish this record.
  **Live panel/SLO data verification remains pending.** `deploy/dash0/dashboard.yaml` (PersesDashboard:
  SLO tiles, burn rate, rate/p95/5xx by route, search p95 by mode, access scans,
  browser page load), `deploy/dash0/check-rules.yaml` (PrometheusRule: p95 of
  `/api/search` + `/api/onboarding` < 500 ms over 1h, non-5xx >= 99% over 1h,
  multi-window burn rates) and `deploy/dash0/slos/` (native Dash0 OpenSLO SLOs,
  28d). Offline checks only: YAML parses and all 29 PromQL expressions parse.
  The same PR fixes `companion.search.duration` buckets, which had made every
  p95 read about 4.75 s. Apply steps and screenshot list: `docs/dash0.md`.
  Screenshots pending: `docs/evidence/dash0-health-dashboard.png`,
  `dash0-search-p95-by-mode.png`, `dash0-check-rules.png`, `dash0-slo.png`.
- How to reproduce locally: `docs/observability.md`.

## Accessibility

- Initial real-browser check: Edge on Windows, 2026-11-09; 11 Playwright tests passed
  for [PR #18](https://github.com/DL4P1N/Kubecon-2026/pull/18).
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
