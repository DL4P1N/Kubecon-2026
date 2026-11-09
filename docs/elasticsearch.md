# Elasticsearch indices, talk catalog and seeding

Code lives in `api/src/es/`. Design doc sections 3 and 5.

## Commands

Set `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` (the `companion_svc` account, never the superuser), then:

```
npm run es:init   # create missing versioned indices (idempotent)
npm run seed      # ensure indices, then bulk-index data/talks.json with embeddings
```

Both are safe to re-run: talk ids are used as `_id`, so seeding overwrites.
`companion_svc` needs `create_index`, `manage` (for alias) and `read`/`write` on `talks*`, `attendees*`, `schedules*`, `entitlements*`, `interest_clusters*`.

Integration test: `api/test/es.integration.test.ts` runs only when `ES_URL` is set (seeds, then checks a kNN query returns hits).

## Indices

Physical name is `<name>-v<SCHEMA_VERSION>` with an alias `<name>` (alias is only claimed when nothing owns it yet). Mappings are `dynamic: strict` and carry `_meta.schema_version`.
To change a mapping (or the embedding dimension), bump `SCHEMA_VERSION` in `mappings.ts`, run `es:init`, reindex, then move the alias by hand.

| Index | Fields |
|---|---|
| `talks` | id, title, abstract, speaker, track, level, room, start, end, tags, `all_text` (copy_to for BM25), `embedding` (dense_vector, cosine) |
| `attendees` | id, display_name, interests[], interest_vector, consent.{cluster_map,qr_checkin}, created_at, expires_at (24h retention) |
| `schedules` | attendee_id, talk_ids[], updated_at, expires_at |
| `entitlements` | attendee_id, pass_type, rooms[], updated_at, expires_at |
| `interest_clusters` | cluster_id, run_id, label, size, top_interests[], centroid, computed_at |

Email is deliberately not indexed in `attendees` (not needed for scheduling or clustering).

## Defaults chosen for open product questions (all swappable)

1. Catalog: 64 synthetic but realistic KubeCon-style talks in `data/talks.json`: 2 days, 9 tracks, 3 levels, 6 rooms, tags. Most slots run 5 rooms in parallel, keynotes and evening sessions run alone, lightning talks are 25 minutes. Times are UTC. Replace the file (or point `TALKS_FILE` at another) to use the real schedule; the shape is `CatalogTalk` in `talks.ts`.
2. Vectors: a `dense_vector` field (not `semantic_text`) filled through the `embed(text)` interface in `embeddings.ts`.
   - `EMBEDDINGS_PROVIDER=local` (default): deterministic hashed bag-of-words, `EMBEDDING_DIMS` (default 256), L2-normalised. No network or API key. Quality is lexical, so it is a stand-in for a real model.
   - Any other provider value currently throws. To add one, implement `Embedder` and register it in `createEmbedder`; set `EMBEDDING_DIMS` to the model size, bump `SCHEMA_VERSION`, and re-seed.
   - Seed and search must use the same provider and dimension.
