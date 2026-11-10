# Landing: server and headless logic

Backend and front-end logic for the Conference Companion landing-page mockup. No markup and no styling live here.
Zero runtime dependencies: Node 22+ built-ins only. `landing/` is not an npm workspace of the repo root.

```
node landing/server.mjs        # http://127.0.0.1:4310
npm test                       # in landing/: node --test "test/*.test.mjs"
```

| Env | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` makes QR codes use this machine's LAN IPv4. |
| `PORT` | `4310` | Listen port. |
| `APP_BASE` | `http://localhost:5173` | Where the existing React app runs (Vite dev server). |
| `API_BASE` | `http://localhost:3000` | The existing Fastify API (`PORT=3000` in `.env.example`; routes live under `/api/...`). |
| `PUBLIC_URL` | see below | Origin phones should use in QR codes. Default: first non-internal IPv4 plus port when `HOST` is `0.0.0.0`, else the request origin. |
| `CLAUDE_BIN` | search `PATH` | Path to the `claude` binary. If set but not executable, chat runs in scripted mode. |

## Files

| File | Role |
|---|---|
| `server.mjs` | Static server and JSON API. |
| `js/chat.js` | Registration chat widget (auto-binds `[data-chat]`). |
| `js/chat-script.js` | Shared by server and browser: scripted flow, profile validation, tag/text cleaning. Not a page-facing module. |
| `js/qr.js` | `drawQr()` and auto-render of `canvas[data-qr]`. |
| `js/conferences.js` | Conference catalogue, filter, lookup. |
| `js/companion-api.js` | Config, status badge, app links, register/chat calls. |
| `data/conferences.json` | Catalogue (8 entries, 7 invented). |
| `vendor/qrcode.js` | `qrcode-generator` 2.0.4 (Kazuhiko Arase, MIT, licence header kept), ESM build, unmodified. |
| `test/` | `node:test` suites. |

All modules are plain ES modules. Load them with `<script type="module" src="js/chat.js">` (relative to the page).
URLs inside the modules are resolved relative to the module file (`../api/...`, `../data/...`), so the pages can live at
the site root or in a subfolder. The modules do nothing harmful when `/api/*` is missing (static file server): they fall
back and never throw into the page.

## Page markup contracts

### Chat: `js/chat.js`

```html
<section data-chat data-conference="slug">
  <ol data-chat-log aria-live="polite"></ol>
  <div data-chat-choices hidden></div>   <!-- optional: quick-reply chips; created before the form if missing -->
  <form data-chat-form><input data-chat-input autocomplete="off"><button type="submit">...</button></form>
  <div data-chat-ticket hidden> <canvas data-qr></canvas> <dl data-ticket-fields></dl> </div>
</section>
```

- Reads `c` (conference slug) and `via` (`github|google|linkedin|qr`, anything else = none) from the URL query.
  `?c=` wins over `data-conference`; with neither it uses `cloud-native-hackathon-slc-2026`.
- Appends `<li class="chat-msg" data-role="assistant|user"><p>text</p></li>` to `[data-chat-log]`. While a reply is
  pending there is `<li class="chat-msg" data-role="assistant" data-pending><p>…</p></li>`, which is reused (attribute
  removed, text replaced) when the reply arrives. All text is set with `textContent`.
- Starts by requesting the first assistant message with an empty transcript. Disables the input and button while a
  reply is pending (`aria-busy` on the log), restores focus to the input after a reply to something the visitor typed
  (it does not steal focus on page load), scrolls the log to the newest message. Enter submits (native form submit).
  Sets `maxlength="1000"` on the input if it has none.
- `section[data-state]`: `loading` (setting up) | `ready` (waiting for the visitor) | `waiting` (reply pending, or
  registering) | `done` | `error` (reserved; the widget currently falls back instead of erroring, so it is not set today).
- `section[data-mode]`: `claude` | `scripted`, set after the first reply and updated on every reply.
- Transcript is kept in `sessionStorage` under `cc.chat.v1.<slug>` (try/catch; works without it). A reload resumes the
  conversation, or re-shows the finished ticket without registering again.
- On `done`: calls `/api/register`, fills `[data-ticket-fields]` with `<dt>/<dd>` pairs, draws the token into
  `[data-chat-ticket] [data-qr]` through `qr.js`, unhides `[data-chat-ticket]`, sets `data-state="done"`, disables the
  input and button, and dispatches a bubbling `chat:done` on the section with `detail: { profile, ticket }`.
  - `profile`: `{ name, role, interests: string[], goal, formats }` (no consent fields: registering implies the interest
    map and QR check-in, and the profile is always kept)
  - `ticket`: `{ source: "api"|"local", attendeeId, token, expiresAt }`
  - `<dt>` labels, in order: `Name`, `Role`, `Interests`, `Goal` (only if present), `Ticket` (`Registered` when `source`
    is `api`, else `Demo ticket`), `Expires` (local date/time, omitted if unparsable).
- With no server at all (`/api/chat` 404s or errors), it switches silently to the in-browser copy of the scripted flow
  (`data-mode="scripted"`) and a locally generated ticket (`Demo ticket`). The same fallback applies if the server fails
  later in the conversation. The browser's own console still logs the failed network request; the UI shows no error.

#### Conversation, quick replies and the kept profile

First-time flow: the host's first message says once, in one sentence, what registering does ("Registering keeps your answers
for this and future conferences, gives you a QR ticket for room doors, and counts your interests anonymously in the
organisers' interest map."), then asks: name, role, topics, goal, talk formats, then reads a summary back and asks
"Register you with these?". There are no consent questions. Host messages are one sentence, two at most.

Every host reply may carry `ask` (`"topics" | "goal" | "confirm" | null`) with `options` (and, for topics, optionally
`selected`). In Claude mode the model ends such a message with a marker the server strips and validates against that
fixed list (`<<ASK topics>>`, `<<ASK goal>>`, `<<ASK confirm>>`; anything else is dropped). The scripted flow returns the
same fields. Free-text answers are always accepted.

| `ask` | `options` | Behaviour |
|---|---|---|
| `topics` | the conference's own topics (from `data/conferences.json`) first, then a fixed list of common tags: lowercase, deduplicated, at most 14 | multi-select, 1 to 6, plus an add-your-own control |
| `goal` | `learn`, `hire`, `meet`, `build` | multi-select |
| `confirm` | first-time summary: `Yes, register me`, `Change something`. Returning visitor: `Yes, register me`, `Change my topics`, `Start over` | single-select, sends on click |

Markup `js/chat.js` creates inside `[data-chat-choices]` (it is `hidden` while no question is open; the page may place the
`<div data-chat-choices hidden>` between the log and the form, otherwise one is created right before the form):

```html
<div data-chat-choices>
  <div role="group" aria-label="Choose 1 to 6 topics">
    <button type="button" class="chat-chip" aria-pressed="false">kubernetes</button>
    <button type="button" class="chat-chip" aria-pressed="true" data-custom>my own topic</button>
    <button type="button" class="chat-chip" aria-pressed="false" aria-disabled="true">...</button> <!-- at the cap -->
  </div>
  <p class="chat-choices-note" data-chat-choices-note aria-live="polite"></p>      <!-- cap / error messages -->
  <div class="chat-custom">                                                          <!-- topics only -->
    <input data-chat-custom aria-label="Add your own topic">
    <button type="button" data-chat-custom-add>Add</button>
  </div>
</div>
```

- `section[data-ask="topics|goal|confirm"]` is set while chips are showing and removed when they are answered or cleared.
- Chips are real buttons (Space and Enter toggle them). Topics are capped at 6: further chips get `aria-disabled="true"` and
  the note says so. Custom topics (Add button, or Enter in the custom input, which never submits the main form) pass through
  the same tag normaliser as everything else, appear as pressed chips with `data-custom`, and duplicates only press the
  existing chip. Sensitive or unusable input is refused with a note.
- The main send button submits the selection as the visitor's message: the pressed chips, then any text typed in the main
  input appended, comma separated, shown in the log like any answer. With nothing picked and nothing typed, nothing is sent.
- Selections survive a reload (`sessionStorage`), and the chips of the last open question are restored.
- `topics` can arrive with `selected` (a returning visitor's remembered topics): those chips start pressed.

Returning visitors (simulated): when registration finishes, the browser saves the profile to `localStorage` under
`cc.kept-profile.v1` (name, role, interests, goal, formats; nothing else). Next time `chat.js` sends it to `/api/chat` as
`known`. The host greets them by name, shows the remembered role, interests and goal in one message and asks "Register you
for <conference> with these?" (`ask: "confirm"`). "Yes, register me" finishes at once with the kept profile; "Change my
topics" asks only for topics (chips pre-pressed) and then finishes; "Start over" clears the kept profile from
`localStorage` and runs the first-time flow from a fresh transcript. Both the Claude-led and the scripted flow behave this
way. `js/chat.js` also exports `forgetKeptProfile()` and `KEPT_PROFILE_KEY`.

**The "kept profile" is simulated in the browser.** This mockup has no cross-event server store; nothing is persisted
server-side, and the existing API still expires attendee data after 24 hours on its own.

### QR: `js/qr.js`

```html
<canvas data-qr="self" data-qr-conference="slug"></canvas>   <!-- registration URL -->
<canvas data-qr="https://example.com/x"></canvas>             <!-- literal text -->
<canvas data-qr></canvas>                                     <!-- empty: left alone, chat.js fills it -->
```

- `data-qr="self"` encodes `${publicUrl}${path of register.html}?c=<slug>&via=qr`. `publicUrl` comes from
  `/api/config`, else `location.origin`. The path is where `register.html` sits next to `js/`
  (`new URL("../register.html", import.meta.url)`), so the page must be named `register.html`. Slug: the page's `?c=`,
  else `data-qr-conference`, else `cloud-native-hackathon-slc-2026`.
- `export function drawQr(canvas, text, opts)`, `opts`: `scale` (CSS px per module, integer, default 6; also
  `data-qr-scale`), `level` (`"M"` default, or `"Q"`), `ink`, `paper`, `label`. Returns `{ size, pixels, quiet, adjusted }`.
- Real QR code: byte mode (UTF-8), error correction M, quiet zone 4 modules, version chosen automatically.
- Pixel art: backing store is exactly `(modules + 8) * scale * round(devicePixelRatio)` square, every module a whole
  number of device pixels, no smoothing. `drawQr` sets inline `width`/`height` (CSS px, `modules*scale`) and
  `image-rendering: pixelated` on the element. Do not override the width in CSS with a non-integer ratio (no `width: 100%`
  on a canvas inside a fluid box): that resamples the modules. Pick `data-qr-scale` instead.
- Colours: CSS custom properties `--qr-ink` (default `#111`) and `--qr-paper` (default `#fff`) read from the canvas's
  computed style. Ink must be darker than paper with WCAG contrast of at least 4. Otherwise both fall back to the
  defaults and the canvas gets `data-qr-adjusted="true"`. Translucent colours count as unusable. (Result: a dark-mode
  palette with light ink on dark paper is replaced by black on white; set the paper to a light colour on the canvas.)
- Sets `role="img"` and an `aria-label` only if the canvas has none (`data-qr-label` overrides the default text).

### Conferences: `js/conferences.js`

- `loadConferences()` fetches `../data/conferences.json` relative to the module, else uses the inlined copy
  (`FALLBACK_CONFERENCES`, kept identical to the JSON by a test). Cached.
- `filterConferences(list, { q, topic, month })`:
  - `q`: every whitespace-separated word must appear (case-insensitive) in name, city, topics or summary.
  - `topic`: exact topic tag, case-insensitive (`""` or `"all"` = any).
  - `month`: `"YYYY-MM"` (the event runs in that month) or `"1"`..`"12"` / `"01"`..`"12"` (that month in any year).
- `getConference(slug)`: sync lookup in the loaded list (inlined copy before loading finishes).
- Entry fields: `slug, name, startDate, endDate, city, district, venue, topics[], summary (<= 18 words), capacity, assumed`.
  `assumed: true` means invented demo data and must be marked as such on the page. Only the first entry is real.

### App links and status badge: `js/companion-api.js`

- `<a data-app-link="/schedule" href="...">`: `href` becomes `appBase + "/schedule"` once `/api/config` answers. The authored
  `href` stays until then. If the config call fails, the static fallback `http://localhost:5173` is used, so the link always
  ends up on `appBase`.
- `<span data-status-badge>`: text and `data-status="ok|degraded|down|unknown"`, polled every 30 s (the interval of
  `web/src/components/status.ts`). Wording is the same as the React `StatusBadge`: "All systems normal", "Search is
  warming up, try keyword", "Some requests are failing, we are looking into it", "Search is unavailable, retrying";
  "Status unavailable" (`unknown`) when the API is unreachable. Starts as "Checking status…" (`unknown`). Adds
  `aria-live="polite"` if missing. It is a plain element, not a link.
- Exports: `getConfig()` (cached, static fallback `{appBase:"http://localhost:5173", apiBase:"http://localhost:3000",
  publicUrl: location.origin, chat:"scripted"}`), `getStatus()`, `register(conference, profile)`, `sendChat(...)`,
  `describeStatus(status)`, `localTicket()`.

## Server API

| Route | Notes |
|---|---|
| `GET /api/config` | `{ appBase, apiBase, publicUrl, chat: "claude"\|"scripted", events: true }` |
| `GET /api/events` | Server-Sent Events: `event: registered` frames, see "Demo on the venue network". Register bodies may carry `returning: true`. |
| `POST /api/chat` | Body `{ conference:{slug,name}, via, messages:[{role,content}], known? }`, answers `{ reply, done, profile?, ask, options?, selected?, mode }`. `known` is a kept profile, validated like a profile and never echoed. |
| `POST /api/register` | Body `{ conference, profile }`, answers `{ source:"api"\|"local", attendeeId, token, expiresAt, reason? }`. |
| `GET /api/status` | The real API's status with `ok:true` added, or `{ ok:false, reason }` (HTTP 200 either way). |

Other `/api/*` paths are JSON 404, wrong methods are 405. Static files: everything under `landing/` except dotfiles and
dot-directories, `server.mjs`, `test/`, `.taste-skill/` and any `node_modules/` (checked case-insensitively and after
resolving symlinks). `GET`/`HEAD` only, single-range requests supported.

### Chat limits

Body at most 32 KB, at most 24 messages, user messages at most 1,000 characters (assistant 2,000), roles must be `user` or
`assistant`, the last message must be a user message, `via` must be one of the four values or null. Per-IP token bucket
(burst 30, 1 request per 2 s); `register` has its own (burst 10, 1 per 6 s). At most 1 concurrent CLI child per client IP
and 4 overall (`429 busy` beyond that). The client key is the socket address, never `X-Forwarded-For`.

### How the Claude CLI is called

Stateless: each request sends the whole transcript, built into one prompt on **stdin**. Messages are JSON-encoded, one per
line, with `<` and `>` escaped, so visitor text cannot fake the prompt's structure or the `<<PROFILE` marker. The system
prompt is static (argv). Conference name and sign-in method go in stdin as data (name from `data/conferences.json` for known
slugs, otherwise reduced to letters, digits and a few punctuation marks).

```
claude -p --model claude-haiku-5-5 --effort low --tools "" --strict-mcp-config --setting-sources ""
       --disable-slash-commands --safe-mode --permission-prompts none --no-session-persistence
       --output-format json --system-prompt <static prompt>
```

spawned with `spawn(bin, args)` (no shell), `cwd` a fresh empty directory under the OS temp dir (removed afterwards), a
minimal environment (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, plus `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` and proxy
variables if set), a 45 s timeout that kills the process group, and at most 256 KB of output. `--bare` is not used:
it disables the login the CLI normally uses. The server accepts the output only if the JSON says `is_error:false`,
`num_turns` at most 1 and no permission denials. Anything else (missing CLI, error, timeout, empty reply) falls back to the
scripted flow and the response says `"mode":"scripted"`.

The `<<PROFILE {json}>>` and `<<ASK kind>>` markers are stripped from every reply. It yields `done:true` and `profile` only if the JSON passes
strict validation (plain object, only the known keys copied out, `name`/`role` 1-80 chars, 1-6 tags of 2-32 chars,
`goal` at most 60, `formats` at most 120, no other keys) and the visitor has sent at least 4 messages (1 for a returning visitor). For a returning visitor the server keeps the remembered name, role, goal and formats and takes only the interests from the model. Tags and
text that mention health, politics, religion, ethnicity, sexuality, age, address and similar are dropped, not stored.
That list is a blunt backstop; the system prompt is the primary rule.

### Register

Maps the profile onto `RegisterRequest` from `shared/src/contract.ts`:
`{ name, email: "", interests, consent: { clusterMap: true, qrCheckin: true } }` and POSTs it to `${API_BASE}/api/register` with a 4 s
timeout. Email is never collected (the real form also treats it as optional and the API never stores it). `role`, `goal` and
`formats` have no field in the contract and are not sent. The contract requires both `Consent` booleans; registering now implies the
interest map and QR check-in, so both go out as `true` (the visitor is not asked). On a 200/201 with `attendeeId`, `token` and `expiresAt` the response is
`{ source:"api", ... }`. If the API is unreachable, times out or answers anything else, the server returns a clearly local
ticket: `{ source:"local", attendeeId: <uuid>, token: "demo.<random>", expiresAt: now + 24 h, reason }`.

## Served by the web app: the real backend (product path)

In the product the web app serves `landing/` under `/site/` on the same origin as the real API (`/api/...`, Fastify on :3000). This
`server.mjs` is then only a standalone preview. The product path does not need it.

- **URLs.** The browser modules call absolute same-origin `/api/...` everywhere (`apiUrl()` in `js/companion-api.js`), never module-relative
  paths. There is no `/api/config` on the real API: under `/site/` the config is derived in the browser (`appBase` is `""`, so app links
  become `/schedule`; `publicUrl` is `location.origin`). `data-qr="self"` encodes `${origin}/site/register.html?c=...&via=qr`.
- **Chat.** `POST /api/chat` is `api/src/routes/chat.ts` (Claude CLI when `claude` is on PATH and `CHAT_MODE` is not `scripted`, else the
  scripted flow). The cluster's API image has no CLI, so scripted is what runs there. `api/src/chat/script.js` is a byte-identical copy of
  `js/chat-script.js` (an API test fails if they differ: edit the browser file and copy it).
- **Sign-up on `done`** (`signUp()`): `POST /api/register` with `{ name, email: "", interests, consent: { clusterMap: true, qrCheckin: true },
  conference, returning }` (registering implies both), store the returned token in `sessionStorage["cc.token"]` exactly like the React app
  (`web/src/api.ts`), build the schedule like the Onboarding page (`POST /api/onboarding` with the answers mapped to `OnboardingAnswers`,
  `GET /api/search`, `POST /api/schedule` with the ranked talk ids), then `POST /api/access/token` and draw THAT short-lived token as the
  ticket QR (the Kiosk scans it; `qrcode` in `Schedule.tsx` encodes `token.token` as-is). The QR is refreshed shortly before the token
  expires while the ticket is on screen. If registration fails (API unreachable) the ticket is a local ticket labelled "Demo ticket".
  If only the schedule or QR step fails the attendee is still registered and the ticket says so.
- **Live numbers.** `getLiveAggregates()` returns the shape of `data/demo-aggregates.json` from `GET /api/interests/aggregate` (and
  `roomLevels` from `/api/rooms/occupancy`), or `null`. `roomOccupancy` is always `[]` because the real route only has coarse levels.
  The k-means clusters need the organiser key and are not read from the browser.
- **Live stream.** `GET /api/events` is `api/src/routes/events.ts`; the real register route broadcasts after a successful registration.

## Demo on the venue network

```
HOST=0.0.0.0 PUBLIC_URL=http://<lan-ip>:4310 node landing/server.mjs
```

This exposes the chat endpoint, which spends Claude usage on every turn, to everyone on that network. The per-IP rate limits and the
concurrency cap are the only guard: there is no login. To avoid that, start it where `claude` is not on PATH (and `CLAUDE_BIN` is unset): the chat is then scripted. `GET /api/events` streams `event: registered` frames (`{"label":"<first name only, A-Z a-z 0-9, max 12>",
"conference":"<slug>","returning":<bool>,"interests":<count>}`), at most 20 listeners, heartbeat comment every 20 s. Nothing else about the
attendee (full name, role, tags, token) is on the stream. `GET /api/config` advertises `events: true`.

## What is mocked

- Social sign-in is only the `?via=` flag. There is no OAuth, no name or email comes from it.
- Local demo tickets (`source:"local"`) are random strings that nothing verifies. A scanner or the real API will not accept them.
  A `source:"api"` ticket is the real signed attendee token from the existing API, but the QR on the page encodes that token,
  not a per-room access token.
- The "kept profile" for returning visitors lives in `localStorage` only (see above).
- Seven of the eight conferences are invented demo data (`assumed: true`).

## Privacy

Nothing here logs attendee data: the request log is `METHOD /path status ms` (no query string, no body, no IP). The CLI's
stderr is discarded. Chat transcripts live only in the visitor's `sessionStorage` and in the model request; the server
keeps nothing. The existing API still deletes attendee documents 24 hours after registration (`ATTENDEE_RETENTION_MS`), which
this mockup does not change; the "kept profile" shown to returning visitors is browser-side only. Local demo tickets expire after 24 hours.
