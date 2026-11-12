# Database, talk catalog and seeding

Code lives in `api/src/db/` and `api/src/embed/`. The API stores application data in PostgreSQL with `pgvector` and
`pg_trgm`; the same database can be provided by a managed service or run in the cluster. Local development uses the
PostgreSQL service in Docker Compose. This replaced Elasticsearch; see [Why](#why-postgres).

## Requirements

- **PostgreSQL 15+ with `pgvector` and `pg_trgm`.** The API enables the extensions on startup; the database role must
  be permitted to create them, or they must already exist.
- **Connection.** `DATABASE_URL` is a standard connection string. URL-encode the password. The database must be
  reachable from the API workload.
- **TLS, always verified.** Non-local database connections verify the server certificate. For a private CA, set
  `DATABASE_CA_FILE` to a PEM CA file mounted into the API container. There is no flag that disables verification.


## Commands

```
npm run db:init   # create the extensions, tables and indexes that are missing (idempotent, also runs at API start)
npm run seed      # same, then upsert data/talks.json with one e5 embedding per talk
```

Both are safe to re-run: talk ids are the primary key, so seeding overwrites. The first run needs the model:
set `MODEL_ALLOW_DOWNLOAD=true` (and optionally `MODEL_CACHE_DIR`) so it can fetch `Xenova/multilingual-e5-small`
once (about 120 MB). The container image bakes the model in and never downloads it.

Local database: `docker compose -f deploy/compose/docker-compose.yml up -d postgres`, then
`DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres`.

## Tables

The schema is `SCHEMA_SQL` in `api/src/db/schema.ts`; there are no migration files. Changing it means an additive
`create ... if not exists` / `alter table ... add column if not exists` statement there.

| Table | Columns |
|---|---|
| `talks` | id, title, abstract, speaker, track, level, room, start_at, end_at, tags[], `embedding vector(384)`, generated `fts` tsvector (title weight A, tags B, speaker C, abstract D) |
| `attendees` | id, display_name, interests[], interest_vector, consent_cluster_map, consent_qr_checkin, created_at, expires_at (far-future sentinel `9999-12-31T23:59:59.999Z` while profiles are kept; created + `ATTENDEE_RETENTION_HOURS` when set) |
| `schedules` | attendee_id, talk_ids[], updated_at, expires_at |
| `entitlements` | attendee_id, pass_type, rooms[], updated_at, expires_at |
| `identities` | id (HMAC of provider:subject), attendee_id, created_at, expires_at |
| `interest_clusters` | doc_id, cluster_id, run_id, label, size, top_interests[], centroid, computed_at |

Indexes: GIN on `talks.fts` and on `talks.title` (trigram), HNSW (cosine) on `talks.embedding`, B-tree on every
`expires_at` and on `identities.attendee_id`. Email is deliberately not stored.

## Search

Hybrid search fuses two ranked lists with reciprocal rank fusion inside Postgres: a keyword leg
(`fts @@ websearch_to_tsquery`, ranked with `ts_rank_cd`, plus trigram matching for typos) and a semantic leg
(`embedding <=> query_vector`). The query vector is computed in the API by multilingual-e5-small (384 dims,
100+ languages) with the `query:` prefix; talks are embedded with the `passage:` prefix at seed time. See
`api/src/search/` and `docs/evidence/search-eval-pg.md` for the measured quality.

## Embedding provider

`EMBEDDINGS_PROVIDER` selects the embedder:

- `e5` (default): runs the quantised ONNX model in the API process. About 0.5 GB of RAM at runtime and about 10 s to
  load; the API loads it before it starts listening.
- `local`: deterministic hashed bag-of-words, no model and no network. Lexical quality only. Used by the unit tests
  and for quick offline runs.

Both produce 384-dimension vectors, which the schema fixes. Changing the model means a new vector size and a re-seed.

## Why Postgres

PostgreSQL provides the full-text, trigram and vector operators the application uses, with no additional search
service required. The API runs multilingual-e5-small locally and stores 384-dimensional vectors in `pgvector`.
