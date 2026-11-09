# Demo evidence

Capture links, screenshots, and observations here as the demo environment is
validated.

## Judge swimlanes and claim gates

Lane names are presentation labels, not proof of integration. Follow the Design
Doc: Elasticsearch, Radar and Dash0 are depth tracks; Sonar/Gitar is a light
entry only after a real review finding is acted on.

| Judge lane | Design Doc evidence required | Current evidence gap |
| --- | --- | --- |
| Sonar: Never Merge Broken | Gitar repo rules, PR review, acted-on finding and CI diagnosis | Rules committed; acted-on finding/review link not yet captured. No Sonar tooling claim. |
| Dash0: Stop Flying Blind | Browser → API → ES trace, search/embedding/access spans, p95 SLO, dashboard, scrubbing proof, real issue investigation | Collector config committed; live exported signals, privacy test and issue evidence not captured. |
| Radar: AI SRE | Ready Kubernetes workloads, UI and MCP used, real investigation with remediation | Live: kind cluster, Radar UI + read-only MCP (28 tools) connected, api/web/ES Ready. Real-investigation story still to be captured (see Radar section). |
| Elasticsearch: Find the Right Talk | Real catalog and ES inference per human decisions; BM25 vs hybrid results and query comparison | Live: TLS+auth ES, least privilege proven, E5 endpoint visible. Real-catalog seed + hybrid-vs-keyword comparison pending seed result. |

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
- Offline validation: yamllint passed; kubeconform strict reported 6 valid, 0 invalid.
  Server-side `apply --dry-run=server` also passed on the new cluster.

### Real incident: Elasticsearch ML capacity (natural, not injected)

- Symptom: the catalog seed Job failed with HTTP 429 `inference_exception`,
  "no ML nodes with sufficient capacity".
- Diagnosis (Elasticsearch API, not Radar): ML memory was the default 30% of the 4Gi limit,
  1228mb total / 1188mb effective. The built-in `.multilingual-e5-small` needs
  `per_deployment_memory_bytes` 470MB + `per_allocation_memory_bytes` 558MB plus native
  overhead, about 1.27GB, so it could never allocate.
- Fix: `xpack.ml.max_machine_memory_percent=50` (2048mb), set live and persisted as an env
  var in `deploy/k8s/elasticsearch/statefulset.yaml`.
- Honesty note: Radar surfaced the failed Job/pod state, but the root cause came from ES.

### Controlled fault (labelled controlled)

- API scaled to 0 for ~40s to verify the Gitar probe fix above. Radar MCP `diagnose`
  reported `workload_degraded` / `0/1 available`. This is a controlled test, not a natural incident.

### Still not proven

- No Radar screenshot saved to the repo yet, and no Radar AI investigation run.
- Browser to API to ES trace and Dash0 export: blocked on the `dash0-credentials` Secret
  (the collector is deployed and waiting for it).
- TLS is end-to-end only for ES; web to api and api to collector are plaintext HTTP (board #24).
