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
| Radar: AI SRE | Ready Kubernetes workloads, UI and MCP used, real investigation with remediation | Manifests and runbook available; assigned cluster access and workload/investigation proof pending. |
| Elasticsearch: Find the Right Talk | Real catalog and ES inference per human decisions; BM25 vs hybrid results and query comparison | #19 corrects initial synthetic/local-embedding implementation; live ES and comparison evidence pending. |

Do not substitute scaffold/mock routes for end-to-end acceptance. A `/healthz`
response alone does not verify Elasticsearch inference or token entitlements.
Controlled faults must be explicitly labelled as controlled.

Operational priorities: assigned cluster/namespace first (question #3), then
authenticated ES inference and core registration → schedule → QR flow, followed
by live Dash0/Radar evidence and a recorded fallback. TLS gaps are tracked in
#24. Conditional map/navigation work must preserve the consent, k≥5 and
simulated-replay boundaries in the Design Doc.

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

Still pending: CI-failure diagnosis and the review link for the demo.

## Radar

- Deployment/runbook: `deploy/k8s/app/`, `docs/radar.md` (task #6).
- Workload evidence: pending; no Ready pod or Radar screenshot claimed.
- Local access check: existing `toghouse` context points to
  `https://127.0.0.1:16443`; the connection was refused. It is not confirmed as
  the assigned hackathon cluster. Board question #3 requests the actual target.
- Docker Desktop was started; first container build could not fetch
  `node:20-alpine` metadata (`context deadline exceeded`).
- Manifest rendering is not live deployment evidence; add actual validation,
  image publication, health response and investigation artifacts as they occur.
- Human follow-up: create a new cluster rather than using `toghouse`. Target:
  kind cluster `conference-companion`, separate kubeconfig
  `~/.kube/conference-companion`, namespace `conference-companion`.
- Offline validation: yamllint passed; kubeconform strict schema validation
  reported **6 valid, 0 invalid, 0 errors, 0 skipped**.
- Baseline app verification at `64b3bc6`: `npm ci`, `npm run build`, and
  `npm test` passed (20 tests passed; live ES integration test skipped).
  This validates the branch baseline, not a live cluster or ES inference.
- Before new-cluster creation, server and client dry-runs could not reach
  the old local API server; admission validation remains pending.
