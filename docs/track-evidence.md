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

- First PR reviewed: pending Gitar GitHub App installation and first review.
- Findings addressed: pending.
- CI-failure diagnosis: pending.
- Review link: pending.

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
