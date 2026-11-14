<p align="center">
  <a href="https://conference-companion.ecan.pro">
    <img src="docs/assets/conference-companion-banner.svg" width="560" alt="Conference Companion">
  </a>
</p>

**From conference sign-up to the right talk, schedule, and room.**

A personal demo, originally a Cloud Native Hackathon entry for "make conferences easier" (Salt Lake City, 9 November 2026). Attendees register in a short chat, find talks in their own words, and check into rooms with a short-lived QR code. Organizers see aggregate interests and room-demand suggestions instead of individual profiles.

[![CI](https://img.shields.io/github/actions/workflow/status/ecan0/kubecon-conference-companion/ci.yml?branch=main&label=CI&labelColor=0b0e14&color=326ce5)](https://github.com/ecan0/kubecon-conference-companion/actions/workflows/ci.yml)

**Live demo:** [conference-companion.ecan.pro](https://conference-companion.ecan.pro) · [Design document](Conference%20Companion_%20Design%20Doc.md) · [Hackathon evidence](docs/track-evidence.md)

![Conference Companion landing page](docs/demo/submission-landing.png)

## What it does

| Step | Where |
| --- | --- |
| **Register** | `/site/register.html?c=cloud-native-hackathon-slc-2026` explains what is kept, collects interests, and creates a ticket and recommended schedule. Optional sign-in with GitHub links an account to the profile ([docs/sign-in.md](docs/sign-in.md)). |
| **Find a talk** | `/search` compares keyword and hybrid retrieval over 417 real KubeCon NA 2026 sessions. |
| **Plan the day** | `/schedule` saves selected talks without overlaps and shows a short-lived room-access QR. |
| **Check the door** | `/kiosk` accepts a camera scan or token text and checks current entitlements on every scan. |
| **Understand demand** | `/map`, `/clusters` and `/organizer` show aggregates; protected views need the organizer key. Groups smaller than five are suppressed. |
| **Inspect health** | `/status` reports application health and in-process search measurements. |

The [native iOS companion](ios/README.md) is a separate Xcode build. Indoor positioning and other-attendee scenes use explicitly simulated data. The landing page lists ten real US conferences from 2026 to 2027 (dates, cities and venues from each organiser's site; unannounced venues say so) and two fictional demo events, flagged as such. The "Next event" on the home page is the soonest real event that has not ended.

## Architecture

![Current deployment diagram](docs/architecture.png)

Source: [docs/architecture.drawio](docs/architecture.drawio).

- **Web:** React 18, TypeScript, Vite; vanilla ES modules and Three.js for the landing scene. Served by nginx from the same pod that proxies `/api` to the API.
- **API:** Node.js 22, Fastify 5, Zod, signed JWT sessions and QR tokens.
- **Data:** PostgreSQL with `pgvector` and `pg_trgm`; the API creates the schema. Hybrid search fuses full-text, trigram and vector results in SQL. See [docs/database.md](docs/database.md).
- **Jobs:** Optional retention and interest-cluster Kubernetes CronJobs use the API image.
- **Hosting:** Portable Kubernetes base manifests define the app workloads. The environment supplies the database, public ingress, TLS, secret delivery and image-pull access as needed. Deployment configuration lives in this repository; app releases do not require edits to a separate infrastructure repository.
- **Telemetry:** Optional OpenTelemetry instrumentation; explicit allowlists exclude attendee identifiers and free text.

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

- **Storage:** profiles, schedules, entitlements, HMAC-only identity links and aggregates are stored in the configured PostgreSQL database. Browser-local profiles and history are separate from server storage.
- **Retention:** registering keeps the profile by default and includes aggregate-interest use; it is not a separate opt-in. A positive `ATTENDEE_RETENTION_HOURS` enables timed retention. `DELETE /api/me` deletes a profile. See [docs/retention.md](docs/retention.md).
- **Access:** signed attendee sessions last eight hours; room QR tokens last about 60 seconds, use a separate audience, and are checked against current entitlements. Organizer access uses a separate key.
- **Transport security:** external database TLS certificates are verified. In-cluster TLS and public ingress are environment-level configuration.
- **Availability:** the example manifests use one API and one web replica. Availability also depends on the database and target cluster; the example is not an HA claim.
- **Known hardening work:** stored opt-out handling, deletion-error handling, and expired-record cleanup when timed retention is off. This is a demo, not a production-readiness claim.

## License

No project-wide license is declared in this repository. Vendored components retain their own notices and licenses.
