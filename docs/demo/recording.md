# Recording artifacts

`offline-ui-fallback.webm` and `fallback-register.png`, `fallback-schedule.png`,
`fallback-search.png`, `fallback-kiosk.png` are a labelled **offline UI
rehearsal**. Every frame carries a visible disclosure: mock API responses and
synthetic data, not live Elasticsearch, access-control or telemetry evidence.
The staged allow/deny sequence does not prove real revocation. The two search
columns use identical fixtures and establish no hybrid relevance advantage.

The recorder exercised registration, onboarding, saved-schedule rendering,
QR rendering, the comparison screen and kiosk results in installed Edge.
It created no real attendee, read no device signals and used no production
credentials. Tokens visible in this capture are deliberately invalid strings.

Regenerate from the repository root after `npm ci`:

```
npx playwright install ffmpeg
```

Set `RECORD_DEMO=1`, `PLAYWRIGHT_CHANNEL=msedge` if using installed Edge, then:

```
npm run test:a11y -w web -- --grep "record labelled offline"
```

If a teammate's browser download holds the shared Playwright install lock,
set `PLAYWRIGHT_BROWSERS_PATH` to a private temporary directory for both
installation and recording. Do not remove another process's install lock.

The live script/seed is owned by board task #38. A live capture against the
deployed app, including independently verified Dash0/Radar/Gitar evidence,
remains pending deployment recovery (#39) and access from the recorder's
machine. Follow #38's script; do not substitute this UI rehearsal for live
track acceptance. Human presenter review remains required by the board task.
