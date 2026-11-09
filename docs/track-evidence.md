# Demo evidence

Capture links, screenshots, and observations here as the demo environment is
validated.

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

- Workload evidence: pending.
- Notes: pending.

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
