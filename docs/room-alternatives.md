# "Room full? Go here instead" (task #53)

`GET /api/talks/:id/alternatives?size=3` (public, no session token) returns talks running at the same time as the given talk, in other rooms, ranked by meaning.

- **Database:** one nearest-neighbour query on the stored talk embedding (`embedding <=> focus.embedding`, cosine; the embedding was made from the talk's title plus abstract at seed time). Filters: `start_at < talk.end` and `end_at > talk.start` (time overlap), and excluding the talk itself, its own room, and non-session tracks (`Contribfest`).
- **Response:** `{ talkId, window: { start, end }, alternatives: [{ talk, score, sharedTags }] }`. `sharedTags` is the readable "why". `score` is a relative similarity, not a percentage. No attendee data is read or returned.
- **Operations:** responses are cached in memory for 60 s per talk and size (`Cache-Control: public, max-age=60`); the route is rate limited to 60 requests per minute per client IP; an unreachable database answers `503 search_overloaded` with `Retry-After`, other database failures `502`. The span `talks.alternatives` carries only `http.request.method`, `http.route` (the route template), `http.response.status_code` and `search.hits`.
- **Web:** on `/schedule`, each talk has a "Room full? Similar talks now" button that loads up to three alternatives with room, time and why.

Not done / limits:
- Not yet run against the live cluster, so the ranking quality on the real 417 talks is unmeasured. Treat the order as "similar topic", not "better".
- "Prominent when the room is busy" needs room activity (#42), which was not on main when this was written.
- The cache and rate limit are per API process.
