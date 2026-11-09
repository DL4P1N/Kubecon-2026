# Conference Companion: 3-minute demo storyboard (rubric version)

Cloud Native Hackathon, Salt Lake City, 9 Nov 2026, 5:00 PM. Theme: "make conferences easier". Presenter: Erick.
Facts below come from `origin/main:docs/track-evidence.md`, `search-comparison.md`, `status-page.md`, `evidence/dash0-agent0-investigation.md`.

## Story in one breath

Big conferences are hard to get around, and organisers guess room sizes. You sign up in a short chat, get a schedule from your interests and a QR ticket, search for the right talk, then walk to the room with spoken directions. Organisers see interest groups (never under five people) and a suggested room per talk. Elasticsearch answers every attendee question. Dash0, Radar and Gitar kept it healthy and honest while we built it.

## Pre-flight: which build is which

**Laptop, NEW site (branch build, `http://127.0.0.1:4320/`):**
- [ ] Tab A: `conference.html?c=cloud-native-hackathon-slc-2026&demo=1` (recording tab, at top). Tab B: `register.html?c=cloud-native-hackathon-slc-2026` (fresh visitor). Tab C: `profile.html`. Tab D: React app Organizer page with "Room placement". Tab E: React `/navigate` (backup).

**Laptop, DEPLOYED build (old front end, "our deployed build", `https://conference-companion-ecan4.vercel.app`):**
- [ ] Tab F: `/search`. Run the rollout query ONCE before, so the model is warm. Tab G: `/schedule` (already onboarded). The header badge ("All systems normal") must show. Tab H: `/status`.

**Laptop, EVIDENCE tabs (open in this order; clear any private details):**
- [ ] H `/status` already open. I: `docs/demo/dash0-live-slo-list.jpg`. J: `docs/demo/dash0-agent0-output.png`. K: Gitar dashboard on PR 55 (`github.com/DL4P1N/Kubecon-2026/pull/55`, the "Rules 5/5 met" comment). L: `docs/demo/radar-ai-investigation.png`.

**iPhone (iPhone 18 Pro):** Do Not Disturb on, volume up, Silent off. Tickets tab, already registered. Find my room: location toggle OFF. Do NOT show Apple Wallet. Schedule tab: only if present.

## Shot list (3:00; about 300 spoken words, leaving pauses for taps)

| Time | Device / screen | Audience sees | Erick does | Say (exact) | If it fails |
|---|---|---|---|---|---|
| 0:00-0:12 | Laptop NEW, Tab A | 3D pixel venue, camera moving | Scroll slowly. | "Big conferences are hard to navigate, and organisers guess how big each room should be. We built one app for both sides." | Press number keys to jump sections. |
| 0:12-0:38 | Laptop NEW, Tab B, then Tab A | Chat: what registering does, name, role, topics, goal, QR ticket. Then a pixel person walks into the venue. | Read the first chat line. Type "Erick". Tap two topics. Type a goal. At the QR, switch to Tab A. | "Signing up is a chat. It tells you what registering does before it asks anything. Name, role, topics, a goal. You get a QR ticket for the doors. And a pixel person walks into the venue." | Model slow: use the scripted chat. No walker: press `W` in Tab A. |
| 0:38-1:05 | Laptop DEPLOYED, Tab G then Tab F (ELASTICSEARCH) | Schedule built from interests. Then `/search`: keyword vs hybrid columns for the rollout query. Header badge visible. | Show Tab G for 4 s. Tab F: point at both columns; keyword empty, hybrid first result "Hope Is Not a Rollout Strategy". | "On our deployed build, your schedule comes from your interests. Search: I ask, release to a small slice of users first. Hybrid puts 'Hope Is Not a Rollout Strategy' first. Keyword has nothing relevant in its top ten. Elasticsearch holds all 417 talks, and every attendee answer comes from it." | Results differ or slow: show `docs/demo/fallback-search.png` and say "dated measurement". Never claim a win from stale results. |
| 1:05-1:15 | iPhone, Tickets | Ticket pass with door QR | Hold up the phone. | "On the phone, the same ticket is a pass. The QR opens your room's door." | Show the QR on the laptop Tab B. |
| 1:15-1:50 | iPhone, Find my room | Floor plan, your dot appears, dashed route, steps, arrival | Open "Find my room". Turn ON "Let venue receivers locate this phone". Pick the next talk's room. Start. Let the voice speak to arrival (haptic). | "Find my room. You appear on the map only after you switch this on. It is off by default. Pick your next talk. Dashed route, steps, spoken directions, a tap on arrival. Signals are simulated today; the maths is real. A real venue needs Bluetooth receivers." | Laptop NEW Tab A, press `N`; say the same lines. Or Tab E. |
| 1:50-2:15 | Laptop NEW Tab A overlay, then Tab D | Organiser overlay: counts, room occupancy, interest clusters. Then Room placement table with suggested rooms. | Press `D` in Tab A, point at one cluster. Switch to Tab D, point at a talk and its suggested room. | "Organisers: this is synthetic demo data, and it says so. Interests are counted together, and groups under five are never shown. From that demand, we suggest a room for each talk." | Tab D empty: stay on the overlay. "Capacities not set" message: say "it tells you when room sizes are missing". |
| 2:15-2:40 | Laptop EVIDENCE tabs, 5 s each: H, I, J, K, L | `/status` page; Dash0 SLO list; Agent0 output; Gitar PR 55; Radar investigation | Click tabs in order. Do not scroll. | "How we built it. The app shows its own health: this status page. Dash0's SLOs read healthy. Using Dash0's MCP we found search URLs leaking into traces, dropped that field, and checked the export. Gitar reviewed our pull requests; on this one all five repo rules passed. Radar's AI investigation flagged a model-capacity problem in our Elasticsearch logs; we raised the memory budget." | Any tab fails: skip it and say only the sentence for it. Do not search for it live. |
| 2:40-2:52 | Laptop NEW, Tab C | Profile: character editor, Delete my data | Point at the character, then "Delete my data". | "Your profile is kept until you delete it. This button deletes it. The sign-up chat tells you what registering does before it asks anything." | Say it over any page. |
| 2:52-3:00 | Laptop NEW, Tab A, venue | Full venue | Nothing. | "Next: real Bluetooth receivers in a real venue. Thank you." | Just say it. |

The RoomPlan room scan is not in the timeline (never run on stage). Mention only if asked.

## Do not say

- On the new site or phone: "consent starts off", "deleted after 24 hours", "no attendee data is kept". (Those belong only to the deployed build; skip them entirely.)
- "It tracks real people", "Wi-Fi triangulation". Other people on the map are simulated.
- "Add to Apple Wallet", "hosted sign-in", "profile syncs across devices". Do not run a sign-in.
- "Hybrid beats keyword" in general. Do not say "5 of 12 versus 0 of 12" as today's result: that was before query understanding. Say only the rollout-query line.
- "Gitar reviewed every PR" or "Gitar fixed our CI automatically". Gitar could not finish PR 46, 47, 51, 52; auto-apply is unproven.
- "Sonar" tooling, "28-day SLO compliance", "live real-user monitoring in Dash0", "end-to-end TLS".
- Organiser overlay numbers are synthetic; 7 of the 8 conferences are invented.

## If you are running long, cut these

- **Save 20 s:** drop shot 1:05-1:15 (ticket pass, 10 s) and shorten the evidence montage to Dash0 + Gitar only (10 s saved).
- **Save 40 s:** also drop the Tab G schedule glimpse and the privacy shot's second sentence, and cut Radar from the montage.
- Never cut: the sign-up chat, "off by default", the rollout-query line, groups under five.

## Rubric coverage (each line: shot, evidence shown)

| Rubric line | Shot | Evidence shown | Honest note |
|---|---|---|---|
| Gitar: used during build, many PRs, not one at the end | 2:15-2:40 | Gitar dashboard on PR 55 ("Rules 5/5 met"); Gitar "requested changes" on PR 1 and PR 3, fixed in PR 8 | Do not give a PR count; no per-PR tally in the evidence file. Gitar failed to finish PR 46, 47, 51, 52. |
| Gitar: project-aware setup, review instructions, repo rules | 2:15-2:40 | "5/5" rules; files in `.gitar/rules/` and `.gitar/review/conference-companion.md` | Static check only, not runtime compliance. |
| Gitar: CI failure diagnosis and auto-apply | 2:15-2:40 (not spoken) | CI diagnosis on PR 39 (PR 23's keyboard-test race): `docs/gitar-ci-diagnosis.md` | Diagnosis was requested by hand. Auto-apply: No evidence found, do not claim. Say "we asked Gitar to diagnose a failed CI run" only if asked. |
| Gitar: makes conferences easier | whole demo | Attendee and organiser shots | |
| Dash0: traces, logs, metrics, RUM | 0:38-1:05 badge; 2:15-2:40 | Trace `GET /api/search` 7 spans (`handler`, `search`, `embed`, POST) in `docs/demo/dash0-live-trace.jpg`; Web Vitals code in PR 53 | Live Dash0 receipt of web vitals is unverified: do not claim RUM. Open the trace image only if asked. |
| Dash0: Agent0 / MCP find and fix | 2:15-2:40 | `docs/demo/dash0-agent0-output.png`, before/after export | Agent0 reported a 400 and said the query was not exported; the span showed `url.path` with the query. Say "we found", not "Agent0 found". |
| Dash0: in-product observability | 0:38-1:05, 2:15-2:40 | Header badge and `/status` on the deployed build | `/status` p95 is from in-process samples, not Dash0. Tested with a faked ES, not run live. |
| Dash0: dashboard / SLO bonus | 2:15-2:40 | `docs/demo/dash0-live-slo-list.jpg`: both SLOs HEALTHY (availability 99% target, 99.97% budget left) | Only about 3h41m of the 28-day window measured. Say "healthy now". |
| Dash0: makes conferences easier | whole demo | | |
| Radar: Kubernetes with Radar connected | 2:15-2:40 | Radar overview / topology images in `docs/demo/` (api, web, elasticsearch in `conference-companion`) | Own local kind cluster, not a provided cluster. |
| Radar: UI and MCP throughout | not shown live | `docs/evidence/radar-resources.md` (MCP topology/limits: no change needed) | Radar UI screenshot for resource sizing failed; MCP payloads only. Radar `metrics` was null. |
| Radar: AI investigation of a real issue, learned, acted | 2:15-2:40 | `docs/demo/radar-ai-investigation.png` | Verdict was "likely", from a retained log entry; the original diagnosis came from ES APIs. Fix: ML memory budget 50% (PR 6), 417 talks indexed. |
| Radar: makes conferences easier | whole demo | | |
| Elasticsearch: core data layer | 0:38-1:05 | 417-talk catalogue; schedule, search, interest map, clusters all read from ES | Say "our deployed build". Clusters job runs in Node; ES stores inputs and outputs. |
| Elasticsearch: keyword, semantic, hybrid | 0:38-1:05 | Rollout query: hybrid first is "Hope Is Not a Rollout Strategy"; keyword has no relevant talk in its top 10 | If asked for numbers: held-out 8 questions, hybrid 6/8 vs keyword 4/8 (query understanding also helps keyword). Pre-query-understanding config was 5/12 vs 0/12. Small author-written sets. |
| Elasticsearch: makes conferences easier | 0:38-1:05 | Finding the right talk by describing a problem | |
