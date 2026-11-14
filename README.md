<p align="center">
  <a href="https://conference-companion.ecan.pro">
    <img src="docs/assets/conference-companion-banner.svg" width="560" alt="Conference Companion">
  </a>
</p>

**From conference sign-up to the right talk, schedule, and room.**

[Cloud Native Hackathon](https://www.wemakedevs.org/hackathons/cnh) entry submitted with the intent to simplify the registration, scheduling, and attendance of tech conferences in one unified platform. Sign up, find talks, build conflict-free schedules, and check into events with QR + Bluetooth, all while tailoring to your selected tech interests.

[![CI](https://img.shields.io/github/actions/workflow/status/ecan0/kubecon-conference-companion/ci.yml?branch=main&label=CI&labelColor=0b0e14&color=326ce5)](https://github.com/ecan0/kubecon-conference-companion/actions/workflows/ci.yml)

**Live demo:** [conference-companion.ecan.pro](https://conference-companion.ecan.pro) · [Design document](Conference%20Companion_%20Design%20Doc.md) · [Hackathon evidence](docs/track-evidence.md)

![Conference Companion landing page](docs/demo/submission-landing.png)

## What it does

- **Register in a short chat** and get a QR ticket and a recommended schedule. Optional GitHub sign-in links your account without storing your GitHub ID ([sign-in](docs/sign-in.md)).
- **Find talks in your own words** with hybrid keyword and semantic search over 417 real KubeCon NA 2026 sessions (`/search`).
- **Plan your day.** Save talks to a personal schedule without overlaps, then add them to your calendar (`/schedule`).
- **Check into rooms** with a short-lived QR code, verified on every scan (`/kiosk`).
- **Organizers see aggregates only:** interests and room-demand suggestions, never individual profiles. Groups under five are suppressed (`/map`, `/clusters`, `/organizer`; organizer key required).
- **Delete your profile** at any time and everything stored under your ID goes.
- **Check service health** at `/status`.

The [native iOS companion](ios/README.md) is a separate Xcode build. Its indoor positioning uses live Bluetooth; the other-attendee scenes are simulated. The landing page lists real US conferences from 2026 to 2027, and its "Next event" is the soonest one that has not ended.

## Architecture

![Current deployment diagram](docs/architecture.png)

Source: [docs/architecture.drawio](docs/architecture.drawio).

- **Web:** React 18, TypeScript and Vite, served by nginx, which proxies `/api`. The landing scene uses vanilla ES modules and Three.js.
- **API:** Node.js 22 and Fastify 5, with Zod validation, signed JWT sessions and QR tokens.
- **Data:** PostgreSQL with `pgvector` and `pg_trgm`. Hybrid search runs in SQL ([docs/database.md](docs/database.md)).
- **Jobs:** Optional retention and interest-cluster CronJobs, using the API image.
- **Hosting:** Portable Kubernetes manifests. The environment supplies the database, ingress, TLS and secrets.
- **Telemetry:** Optional OpenTelemetry. Allowlists keep out attendee IDs and free text.

## Run it locally

**Prerequisites:** Node 22.15+, npm, Docker.

```sh
npm ci
docker compose -f deploy/compose/docker-compose.yml up -d postgres
export DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
export MODEL_ALLOW_DOWNLOAD=true   # first run downloads the ~120 MB embedding model into api/models
npm run build
npm run db:init
npm run seed
npm run dev:api   # http://localhost:3000
```

In another terminal: `npm run dev:web` (http://localhost:5173, `/site/` is the landing entry). Vite proxies `/api` (and `/otlp`, used only when you enable browser telemetry). Configuration comes from environment variables only; [.env.example](.env.example) lists them. For offline work set `EMBEDDINGS_PROVIDER=local` (hashed vectors, lexical quality only).

### Checks

```sh
npm run typecheck
npm test                     # API tests run real SQL on an in-process Postgres (PGlite)
npm --prefix landing test
npm run test:a11y -w web     # needs the Playwright browser
```

## Deploy

Container images for the API and web are built from `api/Dockerfile` and `web/Dockerfile` (the API image includes its embedding model). The [Kubernetes base manifests](deploy/k8s/app/README.md) declare the app workloads and their configuration contract. Environment operators provide infrastructure integrations such as ingress, TLS, database trust roots, and secret delivery; deployment-specific values belong in Kustomize overlays, not in the application base.

| Guide | Contents |
| --- | --- |
| [Database](docs/database.md) | PostgreSQL requirements, schema, seeding, search and embeddings |
| [Kubernetes deployment](deploy/k8s/app/README.md) | Secrets, images, rollout, seed |
| [Sign-in](docs/sign-in.md) | OAuth providers and the account-link design |
| [Chat](docs/chat.md) | Scripted flow; optional Claude CLI mode |
| [Retention](docs/retention.md) / [clusters](docs/cluster-map.md) | Scheduled jobs, profile deletion, aggregation limits |
| [Telemetry](docs/observability.md) / [allowlist](docs/telemetry-allowlist.md) | Optional OpenTelemetry, in-process scrubbing |
| [iOS](ios/README.md) | Xcode build, server URL, signing, Wallet |

## Data, privacy, and demo boundaries

- **Stored:** profiles, schedules, room access and hashed GitHub links live in PostgreSQL. Browser-local data stays separate.
- **Retention:** profiles are kept until deleted (`DELETE /api/me`). Set `ATTENDEE_RETENTION_HOURS` for timed deletion ([docs/retention.md](docs/retention.md)).
- **Access:** attendee sessions last eight hours. Room QR tokens last about 60 seconds and are re-checked on every scan. Organizers use a separate key.
- **Security:** database TLS certificates are verified. In-cluster TLS and ingress are set by the environment.
- **Availability:** the example runs one API and one web replica. It is not a high-availability setup.
- **Demo status:** hardening work remains (stored opt-out handling, deletion errors, cleanup of expired records when timed retention is off). This is a demo, not production-ready.

## License

[MIT](LICENSE). Vendored components keep their own notices and licenses, such as the Clarity City font under the SIL Open Font License 1.1.
