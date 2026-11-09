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

## Radar

- Workload evidence: pending.
- Notes: pending.
