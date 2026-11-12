# Conference Companion

**From conference sign-up to the right talk, schedule, and room.**

A personal demo, originally a Cloud Native Hackathon entry for "make conferences easier" (Salt Lake City, 9 November 2026). Attendees register in a short chat, find talks in their own words, and check into rooms with a short-lived QR code. Organizers see aggregate interests and room-demand suggestions instead of individual profiles.

[![CI](https://github.com/DL4P1N/Kubecon-2026/actions/workflows/ci.yml/badge.svg)](https://github.com/DL4P1N/Kubecon-2026/actions/workflows/ci.yml)

**[Open the app](https://conference-companion.ecan.pro)** (the site and the API are the same origin) · [Design document](Conference%20Companion_%20Design%20Doc.md) · [Hackathon evidence](docs/track-evidence.md)

![Conference Companion landing page](docs/demo/submission-landing.png)

## What it does

| Step | Where |
| --- | --- |
| **Register** | [Chat sign-up](https://conference-companion.ecan.pro/site/register.html?c=cloud-native-hackathon-slc-2026) explains what is kept, collects interests, and creates a ticket and recommended schedule. Optional sign-in with GitHub, Google or LinkedIn links an account to the profile ([docs/sign-in.md](docs/sign-in.md)). |
| **Find a talk** | [Search](https://conference-companion.ecan.pro/search) compares keyword and hybrid retrieval over 417 real KubeCon NA 2026 sessions. |
| **Plan the day** | [Schedule](https://conference-companion.ecan.pro/schedule) saves selected talks without overlaps and shows a short-lived room-access QR. |
| **Check the door** | [Kiosk](https://conference-companion.ecan.pro/kiosk) accepts a camera scan or token text and checks current entitlements on every scan. |
| **Understand demand** | [Interest map](https://conference-companion.ecan.pro/map), [clusters](https://conference-companion.ecan.pro/clusters) and [organizer view](https://conference-companion.ecan.pro/organizer) show aggregates; protected views need the organizer key. Groups smaller than five are suppressed. |
| **Inspect health** | [Status](https://conference-companion.ecan.pro/status) reports application health and in-process search measurements. |

The [native iOS companion](ios/README.md) is a separate Xcode build. Indoor positioning and other-attendee scenes use explicitly simulated data. Seven of the landing page's eight conference listings are fictional demo events.

## Architecture

```
browser -> Cloudflare -> cloudflared (toghouse) -> nginx (web) -> Fastify API -> Postgres (Supabase)
                                                          \-> OpenTelemetry collector
```

- **Web:** React 18, TypeScript, Vite; vanilla ES modules and Three.js for the landing scene. Served by nginx from the same pod that proxies `/api` to the API.
- **API:** Node.js 22, Fastify 5, Zod, signed JWT sessions and QR tokens.
- **Data:** one Postgres database with `pgvector`: Supabase's free tier in the toghouse deployment. Hybrid search fuses full-text and trigram matching with vector similarity (reciprocal rank fusion) in SQL. Query and profile embeddings come from multilingual-e5-small, run inside the API process. See [docs/database.md](docs/database.md).
- **Jobs:** retention and interest-cluster CronJobs use the API image.
- **Hosting:** a single kubeadm worker on the toghouse homelab; the only public path is a Cloudflare named tunnel. Manifests are in [deploy/k8s](deploy/k8s), reconciled by Argo CD from `deploy/k8s/overlays/toghouse`.
- **Telemetry:** OpenTelemetry SDKs and a collector that keeps data in the cluster (no exporter is configured in the toghouse overlay). Explicit allowlists exclude attendee identifiers and free text.

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

In another terminal: `npm run dev:web` (http://localhost:5173, `/site/` is the landing entry). Vite proxies `/api` and `/otlp`. Configuration comes from environment variables only; [.env.example](.env.example) lists them. For offline work set `EMBEDDINGS_PROVIDER=local` (hashed vectors, lexical quality only).

### Checks

```sh
npm run typecheck
npm test                     # API tests run real SQL on an in-process Postgres (PGlite)
npm --prefix landing test
npm run test:a11y -w web     # needs the Playwright browser
```

## Deploy

Container images for the API and web are built from `api/Dockerfile` and `web/Dockerfile` (the API image bakes in the embedding model). The toghouse overlay in [deploy/k8s/overlays/toghouse](deploy/k8s/overlays/toghouse) adds cert-manager TLS between pods, secrets from Vault through external-secrets, and the Cloudflare tunnel. Secrets and the database URL are never committed: [deploy/k8s/app/README.md](deploy/k8s/app/README.md) lists the Secret keys.

| Guide | Contents |
| --- | --- |
| [Database](docs/database.md) | Schema, Supabase connection, seeding, search, embeddings |
| [Kubernetes deployment](deploy/k8s/app/README.md) | Secrets, images, rollout, seed |
| [Sign-in](docs/sign-in.md) | OAuth providers and the account-link design |
| [Chat](docs/chat.md) | Scripted flow; optional Claude CLI mode |
| [Retention](docs/retention.md) / [clusters](docs/cluster-map.md) | Scheduled jobs, profile deletion, aggregation limits |
| [Telemetry](docs/observability.md) / [allowlist](docs/telemetry-allowlist.md) | SDKs, collector, scrubbing |
| [iOS](ios/README.md) | Xcode build, server URL, signing, Wallet |

## Data, privacy, and demo boundaries

- **Storage:** profiles, schedules, entitlements, HMAC-only identity links, and aggregate results are rows in the Supabase database, a third-party host outside the homelab. Browser-local kept profiles and history are separate from server storage.
- **Retention:** registering keeps the profile by default and includes aggregate-interest use; it is not a separate opt-in. A positive `ATTENDEE_RETENTION_HOURS` enables timed retention. `DELETE /api/me` deletes a profile. See [docs/retention.md](docs/retention.md).
- **Access:** signed attendee sessions last eight hours; room QR tokens last about 60 seconds, use a separate audience, and are checked against current entitlements. Organizer access uses a separate key.
- **Telemetry:** allowlists exclude attendee identifiers, tokens, precise locations, and free-text answers. Pod-to-pod traffic is TLS verified against an internal CA; the database connection verifies Supabase's CA.
- **Availability:** one worker and one API replica. A free Supabase project pauses after about a week of inactivity and the API answers 503 until it is restored.
- **Known hardening work:** stored opt-out handling, deletion-error handling, and expired-record cleanup when timed retention is off. This is a demo, not a production-readiness claim.

## License

No project-wide license is declared in this repository. Vendored components retain their own notices and licenses.
