# Registration chat and live demo stream

`POST /api/chat` (no auth) runs one turn of the registration chat; `GET /api/events` (no auth) is a Server-Sent Events stream for the venue demo. Both are used by the `landing/` pages served under `/site/`.

## Chat modes

| `CHAT_MODE` | Behaviour |
| --- | --- |
| `auto` (default) | Claude Code CLI (`claude -p --model claude-haiku-5-5 --effort low`, locked down: no tools, no settings, one turn, no session) when `claude` is on `PATH` or at `CLAUDE_BIN`; otherwise the scripted flow. Any CLI failure or timeout also falls back to the scripted flow for that turn. |
| `scripted` | Never spawns the CLI. |

**Set `CHAT_MODE=scripted` on any shared or demo host: `auto` spends the logged-in Claude account's usage.** The cluster's API image has no CLI, so scripted mode is what runs there; that is expected. Locally with the CLI installed, every chat turn spends Claude usage, so the per-IP limit on `/api/chat` (30 per minute) and the concurrency cap (1 per client, 4 overall, otherwise the shared `429` body) are the only guard.

The chat is stateless: the page sends the whole transcript each turn. Nothing is stored. Message text and profiles are never logged or put on spans; the model's output is data, and only a strictly validated `<<PROFILE {...}>>` marker (name, role, interests, goal, formats) and a fixed list of `<<ASK topics|goal|confirm>>` markers have any effect. The scripted flow and validators in `api/src/chat/script.js` are a byte-identical copy of `landing/js/chat-script.js` (the browser fallback); `api/test/chat.test.ts` fails if they differ.

## Live stream

`GET /api/events` sends `event: registered` after each successful `POST /api/register`, with `data: {"label","conference","returning","interests"}`: label is `Guest` by default because the stream is unauthenticated; only when the API is started with `EVENTS_SHOW_NAMES=on` (a demo-only switch) is it the first name (A-Z a-z 0-9, at most 12 characters, `Guest` when empty), the conference slug sent with the registration (`unknown` when absent), whether the visitor was returning, and the NUMBER of interests. Never the full name, role, tags, attendee ID or token. At most 20 listeners, 3 per client IP (the shared `429` body beyond that; `503` when all 20 are taken), a heartbeat comment every 20 s.
