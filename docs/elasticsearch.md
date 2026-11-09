# Elasticsearch indices, talk catalog and seeding

Code lives in `api/src/es/`. Design doc sections 3 and 5.

## Requirements (read first)

Talk vectors come from Elasticsearch built-in inference through a `semantic_text` field, not from client code.

- **Version**: Elasticsearch 8.17+ or 9.x (preconfigured `.multilingual-e5-small-elasticsearch` and `.elser-2-elasticsearch` endpoints).
- **License**: the built-in ELSER/E5 inference services need a Platinum/Enterprise license. For the hackathon use a 30-day trial, started once by an admin (superuser, not `companion_svc`):
  `POST _license/start_trial?acknowledge=true`. Without it the mapping cannot be created.
- **ML node**: at least one node with the `ml` role. Memory (approximate, verify on your cluster): the default E5-small endpoint needs about 1 GB for the model on top of normal heap, so give a single-node Docker setup at least 4 GB RAM. ELSER needs roughly 4 GB or more for the model alone (8 GB+ node recommended). The first request downloads/deploys the model and can take minutes; `npm run seed` retries on 429/503 while that happens.
- **Endpoint choice**: default `ES_INFERENCE_ID=.multilingual-e5-small-elasticsearch` (dense, 384 dims, multilingual, small). Chosen over ELSER because it is much lighter on a laptop/hackathon ML node, handles non-English abstracts, and a dense endpoint also lets `embed()` serve attendee interest vectors. ELSER (`.elser-2-elasticsearch`) works for `semantic_text` too (set `ES_INFERENCE_ID`) but is sparse, so `embed()` cannot use it.

### Privileges for `companion_svc`

Same account as before, plus inference. Not verified against a live cluster (none was available when this was written); #3 (ES security/role setup) should confirm.

| Scope | Privileges | Why |
|---|---|---|
| cluster | `monitor_inference` | read the endpoint (`GET _inference/<id>` preflight in `es:init`/`seed`) and run inference for `embed()` (`POST _inference/text_embedding/<id>`) |
| indices `talks*`, `attendees*`, `schedules*`, `entitlements*`, `interest_clusters*` | `create_index`, `manage`, `read`, `write` | create versioned indices, attach the alias, index and search |

`manage_inference` is only needed to create or change endpoints (for example a custom endpoint), which an admin should do, not the service account. If `semantic_text` indexing or `semantic` queries return a security exception on `cluster:monitor/xpack/inference`, add `monitor_inference` (or as a last resort `manage_inference`) and tell #3.

## Commands

Set `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` (the `companion_svc` account, never the superuser), then:

```
npm run es:init   # check the inference endpoint, create missing versioned indices (idempotent)
npm run seed      # same, then bulk-index data/talks.json (text only; ES embeds on ingest)
```

Both are safe to re-run: talk ids are used as `_id`, so seeding overwrites. Seeding sends batches of 25 and retries on 429/502/503/504.

Integration test: `api/test/es.integration.test.ts` runs only when `ES_URL` is set (seeds, then checks a `semantic` query on `content_semantic` returns hits). It has not been run against a live cluster by the author.

## Indices

Physical name is `<name>-v<SCHEMA_VERSION>` (now `v2`) with an alias `<name>` (alias is only claimed when nothing owns it yet, so ensure is idempotent and never steals it). Mappings are `dynamic: strict` and carry `_meta.schema_version`.

To change a mapping (or the embedding dimension or inference endpoint), bump `SCHEMA_VERSION` in `mappings.ts`, run `es:init`, reindex (or re-seed), then move the alias atomically:

```
POST _aliases
{ "actions": [
  { "remove": { "index": "talks-v1", "alias": "talks" } },
  { "add":    { "index": "talks-v2", "alias": "talks" } } ] }
```

v1 -> v2: `talks.embedding` (client-side `dense_vector`, local hashed embedder) was removed and `content_semantic` added. Re-seed into `talks-v2`; there is nothing to migrate.

| Index | Fields |
|---|---|
| `talks` | id, title, abstract, speaker, track, level, room, start, end, tags, `all_text` (copy_to for BM25), `content_semantic` (`semantic_text`, inference endpoint `ES_INFERENCE_ID`) |
| `attendees` | id, display_name, interests[], interest_vector, consent.{cluster_map,qr_checkin}, created_at, expires_at (24h retention) |
| `schedules` | attendee_id, talk_ids[], updated_at, expires_at |
| `entitlements` | attendee_id, pass_type, rooms[], updated_at, expires_at |
| `interest_clusters` | cluster_id, run_id, label, size, top_interests[], centroid, computed_at |

`talks.title` and `talks.abstract` both `copy_to` `all_text` and `content_semantic`, so Elasticsearch builds the semantic text from title then abstract; seeding never sends vectors. `attendees.interest_vector` and `interest_clusters.centroid` stay `dense_vector` (dims = `EMBEDDING_DIMS`, 384 by default to match the E5 endpoint) and are filled client-side through `embed()`.

Email is deliberately not indexed in `attendees` (not needed for scheduling or clustering).

### Querying (for hybrid search, #8)

Use the `semantic` query on `content_semantic` (there is no client embedding step) and combine with BM25 on `all_text`, for example with an `rrf` retriever:

```
{ "retriever": { "rrf": { "retrievers": [
  { "standard": { "query": { "match": { "all_text": "<text>" } } } },
  { "standard": { "query": { "semantic": { "field": "content_semantic", "query": "<text>" } } } } ] } } }
```

## Talk catalog

`data/talks.json` is the **real KubeCon + CloudNativeCon North America 2026 schedule** (Salt Lake City, Nov 9-12, 2026; the same event as the hackathon venue week).

- Source: https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/ (the official schedule page, server-rendered). The dedicated sched.com site for this event could not be located (`kccncna2026.sched.com` redirects to the sched.com home page), so the official page was used.
- Scraped: 2026-11-09 with `node data/import-schedule.mjs` (re-run it to refresh; it rewrites `data/talks.json`).
- Contents: 417 sessions kept out of 600 listed (Sun Nov 8 to Thu Nov 12; times are stored in UTC, the venue is MST, UTC-7). Kept fields: id (`kcna26-<session id>`), title, abstract, speaker (names only, comma separated; no contact data, bios or links stored; email-like strings in abstracts would be redacted), track, level, room, start, end, tags.
- Excluded: registration/coat check/coffee/lunch, Solutions Showcase and Sponsor Demo Theater sessions, Experiences, Project Opportunities and Pavilion Tours, co-located events and anything marked "Separate Registration Required", and sessions without speakers or an abstract.
- Derived fields: `track` is the schedule's topic track (Platform Engineering, Security, AI Inference + Agentic, ...) or, for format tracks, the format (Maintainer Track, Keynote Sessions, Project Lightning Talks, ...). `level` is `beginner` or `advanced` when the schedule says so; the schedule has no intermediate level, so "Any Level" and untagged sessions are mapped to `intermediate` (330 of 417). `tags` combine schedule tags (e.g. project names, "End User Talk") with keywords found in title and abstract (kubernetes, ai, gpu, opentelemetry, gitops, ...).

Set `TALKS_FILE` to seed a different file; the shape is `CatalogTalk` in `talks.ts`.

## Embedding provider (`embed()`)

`EMBEDDINGS_PROVIDER` selects the client-side `embed(text)` used for attendee interest vectors (talks do not use it):

- `es-inference` (default): `POST _inference/text_embedding/<ES_INFERENCE_ID>`; dims `EMBEDDING_DIMS` (default 384). Needs a dense endpoint.
- `local`: deterministic hashed bag-of-words (default 256 dims), no network or key, lexical quality only. Offline fallback and what unit tests use. Note that an index created with `semantic_text` still needs a working inference endpoint, so `local` does not make seeding work offline.

If you change `EMBEDDING_DIMS` or the endpoint, bump `SCHEMA_VERSION`, run `es:init`, and re-seed.
