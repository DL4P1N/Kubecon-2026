# Talk detail page and related talks

`/talks/:id` shows one talk: title, speaker, track, room, local time, level, tags, the full abstract and a **Related talks** list. Search results and the personal schedule link to it.

## API (public, no session token)

| Route | Returns |
| --- | --- |
| `GET /api/talks/:id` | `{ talk }`, or 404 |
| `GET /api/talks/:id/related?size=` | `{ talkId, related: [{ talk, score, sharedTags }] }`, default 5, max 10 |
| `GET /api/talks/:id/alternatives?size=` | Similar talks at the same time in other rooms (see `room-alternatives.md`) |

- `:id` must match `[A-Za-z0-9._:-]{1,100}`; anything else is 400. `size` outside 1–10 is 400.
- **Related** uses the same semantic query as alternatives (`content_semantic`, built from title + start of abstract), with no time restriction. It excludes the talk itself and non-session tracks (Contribfest). `sharedTags` explains the match; empty means "similar topic".
- All three routes share one plugin (`api/src/routes/talks.ts`): 60 s in-memory cache per route/id/size, `Cache-Control: public, max-age=60`, and a per-route per-client rate limit (60/min).
- Elasticsearch overload or inference warm-up maps to `503` + `Retry-After: 5`; other ES failures map to `502`.
- Spans: `talks.detail`, `talks.related`, `talks.alternatives`. They carry only allowlisted attributes (`http.request.method`, the route template in `http.route`, `http.response.status_code`, `search.hits`). The talk id is never put on a span.

## Web

- The talk loads first. Related talks load separately, so a slow or warming-up semantic search never blocks the page: it shows a status note (503) or an alert (other errors) and the talk stays visible.
- Unknown talk → "Talk not found" with a link to Search.
- Search uses a plain `<a>`; Schedule uses the router `Link`.

## Add to my schedule

Uses the existing authenticated schedule API: `GET /api/schedule`, then `POST /api/schedule` with the current talk ids plus this one (existing talks first, so they keep priority). If the server drops the new talk because it overlaps a scheduled one (`droppedTalkIds`), the page says so instead of reporting success. Without a session token the button is replaced by a link to Register; a 401 does the same.
