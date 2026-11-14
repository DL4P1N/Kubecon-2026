Kind: software (page type software, site-kind software). Radius: sharp. Main action: "Register for a conference".
Deal: palette forest-pale-lime (dark green ground, lime accent: a dark, exact devtool look; the venue scene takes the same ground); type host (Host Grotesk + JetBrains Mono); nav-mega; footer-statement (lit ground: data-ground="sand"); close-type; rhythm space (one ground, parted by space); buttons solid; mark stack.
Heroes (dealt, history kept): index = split (ambient venue as its visual); conference = collage (the register window on the lit ground; re-dealt twice: triptych did not fit); register = app screen, one screen, built on the hero frame (no footer, no dealt hero).
Moments (dealt): index = liquid-type (statement section (copy owned by the #retention engineer, rewritten for the three-things fact)); conference = word-highlight (statement section); register = none (app screen, waived).
Scene: custom pixel venue (scene/venue.js), asked for by the brief, stands in the scene slot: index #journey (journey host, 4 chapters) and the index hero (ambient host); conference.html one ambient host. CSS grounds: none. Effects: none besides the scene.
Voice: technical-dry (copy-registers 2) with the product as the subject (11): exact, not cold; "you" for what the attendee gets; humour only in microcopy (empty states, denied scan, chat); no figures that are not in the design doc or README.

Fact sheet (design doc, README, web/src): what it is: conference app: chat registration, personal schedule from interests (hybrid BM25 + dense vector search), room QR check-in with short-lived signed token (attendee ID only, entitlement checked server-side on every scan), registering does three things and the sign-up chat says so before it asks anything: a QR ticket for room doors; the profile (name, role, interests, goal, format preferences) is kept so the next conference recommends talks from the first minute and attendees answer once; and interests count in the organizers' interest map, aggregate only (never individuals, groups under 5 folded into "other"), which organizers also use to choose future talks; no opt-ins or consent choices, no 24-hour deletion; telemetry scrubbed by an attribute allowlist (OpenTelemetry collector to Dash0), email not stored. Limits stated: cluster thresholds untested on live attendee data; sign-in buttons on the conference page are a mock; the live venue map is not Wi-Fi tracking (no RSSI/BSSID).
The app's own event: Cloud Native Hackathon, Mon 9 Nov 2026, The Shop Workspace, Salt Lake City. data/conferences.json also lists eleven other real US events (official site in `url`); PyCon US 2027 is flagged tentative.

INDEX (index.html)
1  hero            split · what: conference app for attendees and organizers · picture: the ambient pixel venue (scene, ambient host) · kind: world (scene) · 1 screen · hero entrance: the name arrives first, then what to do
2  journey #journey the attendee day in four chapters (arrive, schedule, scan, clusters) · picture: the journey venue host, full-bleed, pinned (sticky) · kind: world (the big scene) · 4 screens live (waived: brief asks for 4 chapters), 2 at rest · why it moves: the camera follows the day, scroll-linked inside this section only
3  schedule #schedule app-frame · the personal schedule as live HTML: talk list beside the open talk with its reason · kind: object (the app-frame) · 1 screen
4  conferences #conferences finder · search + topic filter beside linked cards · kind: parts (UI) · 1 screen (2 at 390)
5  retention #retention statement moment: retention statement (copy owned by the #retention engineer) · liquid-type · type · 1 screen · why it moves: the one fact a stranger should remember ripples under the pointer (pointer only)
6  privacy #privacy split-text-left · diagram card: web app and API through the OpenTelemetry collector (allowlist) to Dash0 · kind: diagram · 1 screen
7  faq #faq · five questions from the design doc · 1 screen
8  footer.closing footer-statement + close-type: "Register for a conference"
Motion: hero entrance; hover layer; liquid-type in #retention; scene scrub in #journey; one diagram pulse (the diagram's own loop, pause disc). Nothing else moves.

CONFERENCE (conference.html)
1  hero collage · conference name, date, venue · register window on the lit ground: pixel QR in the stepped frame, or three sign-in links · 1 screen
2  venue · ambient venue host + what the day holds (from the doc) · 1 screen
3  moment: word-highlight statement · 1 screen
4  in this conference: six app destinations as linked tiles with ui glyphs · 1 screen
5  footer.closing
REGISTER (register.html) one screen: the hero frame holds the conversation (host and facts left, chat right), the ticket on completion. Waived: no footer, no moment (app screen).
