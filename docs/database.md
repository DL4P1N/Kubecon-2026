# Database, talk catalog and seeding

Code lives in `api/src/db/` and `api/src/embed/`. The API stores everything in one Postgres database with
the `pgvector` extension: Supabase's free tier in the toghouse deployment, or the compose Postgres locally.
This replaced Elasticsearch; see [Why](#why-postgres) for the footprint reasons.

## Requirements

- **Postgres 15+ with `pgvector` and `pg_trgm`.** Supabase has both (`vector` is enabled by default; the API
  runs `create extension if not exists` for each on start).
- **Connection.** `DATABASE_URL` is a standard connection string. On Supabase use the **session pooler**
  (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<project-ref>`): the direct `db.<ref>.supabase.co`
  host is IPv6 only, and the toghouse cluster has IPv4 only. The password in the URL must be URL-encoded.
- **TLS, always verified.** Any non-local host connects with certificate verification on. Supabase signs with its
  own root CA, not a public one: set `DATABASE_CA_FILE` to `deploy/k8s/overlays/toghouse/supabase-ca.crt` (Supabase's
  published "Supabase Root 2021 CA", valid until 2031-04-26). There is no flag that skips verification.
- **Free-tier limits.** A free Supabase project pauses after about a week without activity (the API then answers
  503 until you restore it in the dashboard) and holds 500 MB. This app uses a few MB.

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

Elasticsearch needed about 2.5 GB of RAM on the single worker, a 4 Gi pod request, and a Platinum/trial licence for
its built-in E5 inference and RRF fusion (the 30-day trial lapses). Postgres on Supabase moves the data off the
cluster (api about 0.6 GB, web, cloudflared remain) and needs no licence.
