```
# Conference Companion: Design Doc

Cloud Native Hackathon, Mon Nov 9, 2026, The Shop Workspace, Salt Lake City
Status: agreed plan after advocate/critic review. Working document for a one-day build.

## 1. Goal

A conference companion covering registration, personalized talk recommendation and scheduling, access control tied to registration, aggregate interest maps for room and speaker placement, and security across all of it. Every part must serve the "make conferences easier" judging theme.

## 2. Scope decisions (agreed)

- **Depth tracks:** Elasticsearch (Find the Right Talk), Radar (AI SRE), Dash0 (Stop Flying Blind). Each has one named owner and one demo artifact.
- **Light entry:** Sonar/Gitar (Never Merge Broken). Committed review-instructions file, project-specific repo rules, and at least one acted-on finding. If that is not achieved, enter it as a side note, not a track claim.
- **Incidental:** Merge Forward (accessibility). Handled by a scheduled accessibility pass.
- **Dropped as a product feature:** Wi-Fi triangulation. Browsers cannot read RSSI or BSSID, and there is no venue AP access, floor plan or calibration data. Replaced by consented QR check-in per room.
- **Demoted:** the Wi-Fi fingerprint estimator survives only as a feature-flagged, offline simulated-replay demo, capped at 1.5 hours and cut first if time runs short. It is labeled "simulated signal replay, not measured at the venue," and no accuracy figures are claimed.

## 3. Modules

| # | Module | Priority | Summary |
|---|---|---|---|
| 1 | Registration | Core | Sign-up with profile and interests stored in Elasticsearch. Issues a signed attendee token. Consent screen. |
| 2 | Scheduling | Core | Onboarding questions feed a hybrid (BM25 plus dense vector) query over the talk catalog. Output is a personal schedule. |
| 3 | Access (QR per room) | Core | Short-lived signed token carries attendee ID only. Entitlements are checked server-side on each scan. Demo kiosk or scanner page. |
| 4 | Cluster map | Conditional | Batch job over ES aggregations of interest vectors. Results written back to ES. Clusters under 5 are suppressed or merged into "other." Falls back to a static aggregate chart if the team is 1-2 people. |
| 5 | Navigation | Stretch | Simulated-replay estimator behind a feature flag, outside the main attendee flow. |
| Sec | Security | Cross-cutting | See section 6. |

Note: k-means is not claimed to run inside Elasticsearch. It runs as a batch job over ES aggregation output, and the results are stored back in ES.

## 4. Architecture

- Containerized web frontend and API service, deployed to Kubernetes in the provided cluster and namespace. Radar is connected to it.
- Elasticsearch is the core data layer for talks, attendee profiles and interest vectors. It runs with security enabled from the start. The app uses a non-superuser service account.
- OpenTelemetry traces, logs, metrics and RUM (if a frontend is used) are exported through an OTel collector to Dash0. The collector enforces the scrubbing allowlist.
- Gitar reviews PRs. CI failure diagnosis is enabled.
- Entitlements are a separate server-side lookup. They are not derived from interest vectors.

## 5. Data flow

1. Attendee registers (Module 1). Profile and interests are indexed in ES. A signed token is issued. Consent is recorded.
2. Onboarding questions produce a query. Hybrid search returns ranked talks. The personal schedule is saved (Module 2).
3. At a room, the attendee's token is scanned. The API checks the entitlement server-side and logs only the decision and the room, not the attendee ID (Module 3).
4. A batch job aggregates interest vectors into clusters, suppresses any cluster under 5, and writes results back to ES for the map view (Module 4).
5. Retention: attendee-level data is deleted after 24 hours.

## 6. Security and privacy

- **Tokens:** short-lived, signed (JWT or HMAC; algorithm to be stated in code), carrying attendee ID only. Revocation works because entitlements are checked server-side on every scan.
- **Key storage:** signing keys live in a Kubernetes Secret, never in the repo.
- **Transport:** TLS everywhere. Rate limiting on registration and scan endpoints.
- **Elasticsearch:** authentication on, service account with least privilege.
- **Telemetry scrubbing:** an allowlist of span and log attributes, not a blocklist, enforced in the OTel collector. A test asserts that no attendee ID or location appears in exported spans. This test doubles as a Dash0 demo point.
- **No sensitive data:** no questions about health, politics or identity. No raw location or RSSI collection from attendees. No per-device tracking.
- **Aggregation:** k-anonymity minimum of 5 for any displayed cluster. With 170-200 attendees the map may look sparse. The real thresholds are untested on live data and this will be stated.
- **Consent:** a screen at registration explaining what is stored and why, with an opt-in for the cluster map and QR check-in.

## 7. Track evidence plan

- **Elasticsearch:** hybrid search visibly beats keyword search on the demo queries. Show the query and the comparison.
- **Radar:** deploy in the first hour. Use Radar UI and MCP during the build. Run an AI investigation on a real problem that occurs (for example, a memory limit or crashloop) and document what was learned and done.
- **Dash0:** spans across search, embedding and token check. One SLO (for example, p95 recommendation latency) and a health dashboard. Use Agent0 or the Dash0 MCP to find and fix a real issue during the day and show it.
- **Gitar:** instructions file committed in hour one. Project rules such as "never log attendee IDs" and "every endpoint needs a span." Keep PRs small. Show one real finding that was acted on.

Real-issue rule: stories must come from problems that actually occur. If none occur naturally by about 2pm, a controlled fault may be used, and it must be labeled as controlled in the demo.

## 8. Schedule (approximate, from ~11:15am)

| Time | Work |
|---|---|
| Now to ~1:15pm | Hours 0-2 platform: repo, Gitar config, image pre-pull, K8s deploy, Radar connected, OTel to Dash0 pipeline, ES running with security. Go/no-go at ~1:15pm. |
| If no-go at 2 hours | Switch to Docker Compose fallback and drop Radar as a depth track. |
| Afternoon | Core slice: registration, onboarding, hybrid search, schedule, QR check-in. Telemetry scrubbing test. Accessibility pass (keyboard, contrast, screen-reader labels). |
| Midday slot | Dash0 and Radar real-issue investigations, captured as they happen. |
| ~3pm | Recorded run of the core demo made as a fallback. |
| ~4pm | Feature freeze. Demo script, seed data, fallback screenshots. Cluster map included only if it is ready. |

Timings are estimates. The critic's estimate of 20-30 person-hours against about 20 usable means the core slice and platform are committed, and everything else is cut from the bottom.

## 9. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Cluster or namespace late or misconfigured | Docker Compose locally. Drop Radar as a track. |
| Elasticsearch setup fails | Seeded JSON with keyword search. Drop Elasticsearch track claim. |
| Venue Wi-Fi poor | Mobile hotspot and local image registry. |
| Image pulls slow | Pre-pull in hour one. |
| Team of 1-2 | Static aggregate chart replaces cluster map. |
| Estimator running late | Cut it first. |
| Live demo fails | Recorded run. |

## 10. Ownership

One owner per track: Elasticsearch and features, Kubernetes and Radar, Dash0 instrumentation, Gitar and CI. Named at kickoff.

## 11. Open items

- Confirm team size, which determines whether the cluster map is built.
- Confirm the provided cluster and namespace details for Radar.
- Read the Rules tab on the event page, which was not in the fetched content. Data handling rules are unknown.
- Set up Gitar, Dash0 and Radar Cloud accounts. Elasticsearch needs Docker and a Kubernetes cluster. Radar needs a GitHub account and a coding agent.
```