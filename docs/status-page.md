# Live status page (task #41)

Observability as part of the product: attendees and organizers can see service health inside the app.

- **API:** `GET /api/status` (public, no auth). Aggregates only; no attendee ids, query text or locations.
  - `status`: `ok`, `degraded` (hybrid warming up, or 5xx rate at least 5% over 20+ requests) or `down` (Elasticsearch unreachable).
  - `elasticsearch.reachable`: a `GET /talks/_count` probe with a 3 s timeout (same read access the search path uses).
  - `search.keyword` / `search.hybrid`: p95 latency (ms, successful searches) and sample count over the last 5 minutes; `hybrid.state` is `ready`, `warming_up` (latest hybrid search was a 503 `search_overloaded` or an error, within 60 s) or `unknown` (no recent hybrid search).
  - `errorRate`: share of 5xx responses over the same window (`/healthz` and `/api/status` excluded).
  - Cached for 10 s so a busy page cannot load Elasticsearch.
  - Span `status` carries only `http.request.method`, `http.route` and `http.response.status_code` (all on the allowlist, see `telemetry-allowlist.md`); no new attributes.
- **Web:** header badge ("All systems normal", "Search is warming up, try keyword", ...) linking to `/status`, which lists the live values. Text carries the meaning; the symbol and colour only reinforce it.
- **Fallback:** on `/search`, if hybrid answers 503 or 502 while keyword works, the Hybrid column shows the keyword results with a note instead of an error.

Limits (stated honestly):
- Counters are in memory per API process: they reset on restart and cover one replica only (the demo runs one).
- "Last retention run" is not shown: nothing in-process knows it, and we do not fake it.
- The `/api/status` p95 comes from in-process samples, not from Dash0; the Dash0 dashboard (#14) is the durable view.
- Tested with a faked Elasticsearch; not yet run against the live cluster.
