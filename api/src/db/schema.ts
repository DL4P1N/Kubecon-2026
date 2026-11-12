import type { Db } from "./client.js";

/** multilingual-e5-small output size; every vector column uses it. */
export const EMBEDDING_DIMS = 384;

/**
 * Whole schema, idempotent: safe to run on every start. Tables replace the old
 * Elasticsearch indices one for one. Timestamps are timestamptz; "kept
 * indefinitely" profiles use the same far-future `expires_at` sentinel as before.
 * Search: `fts` (weighted tsvector, GIN) plus `pg_trgm` for typo tolerance on
 * the BM25-like leg, and `embedding` (HNSW, cosine) for the semantic leg.
 */
export const SCHEMA_SQL = `
create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists talks (
  id text primary key,
  title text not null,
  abstract text not null default '',
  speaker text not null default '',
  track text not null default '',
  level text,
  room text,
  start_at timestamptz,
  end_at timestamptz,
  tags text[] not null default '{}',
  embedding vector(${EMBEDDING_DIMS}),
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', immutable_array_to_string(tags, ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(speaker, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(abstract, '')), 'D')
  ) stored
);

create table if not exists attendees (
  id text primary key,
  display_name text not null,
  interests text[] not null default '{}',
  interest_vector vector(${EMBEDDING_DIMS}),
  consent_cluster_map boolean not null default false,
  consent_qr_checkin boolean not null default false,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

create table if not exists schedules (
  attendee_id text primary key,
  talk_ids text[] not null default '{}',
  updated_at timestamptz not null,
  expires_at timestamptz not null
);

create table if not exists entitlements (
  attendee_id text primary key,
  pass_type text not null,
  rooms text[] not null default '{}',
  updated_at timestamptz not null,
  expires_at timestamptz not null
);

-- HMAC(provider:subject) -> attendee; the raw provider subject is never stored.
create table if not exists identities (
  id text primary key,
  attendee_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

-- One row per cluster of a run, plus a marker row (see clusters/job.ts) naming the run that is current.
create table if not exists interest_clusters (
  doc_id text primary key,
  cluster_id text,
  run_id text not null,
  label text,
  size integer,
  top_interests text[] not null default '{}',
  centroid vector(${EMBEDDING_DIMS}),
  computed_at timestamptz not null
);

create index if not exists talks_fts_idx on talks using gin (fts);
create index if not exists talks_title_trgm_idx on talks using gin (title gin_trgm_ops);
create index if not exists talks_embedding_idx on talks using hnsw (embedding vector_cosine_ops);
create index if not exists talks_start_idx on talks (start_at);
create index if not exists talks_track_idx on talks (track);
create index if not exists attendees_expires_idx on attendees (expires_at);
create index if not exists schedules_expires_idx on schedules (expires_at);
create index if not exists entitlements_expires_idx on entitlements (expires_at);
create index if not exists identities_attendee_idx on identities (attendee_id);
create index if not exists identities_expires_idx on identities (expires_at);
create index if not exists interest_clusters_run_idx on interest_clusters (run_id);
`;

/** generated columns need an immutable expression; array_to_string is only stable. */
const IMMUTABLE_HELPER_SQL = `
create or replace function immutable_array_to_string(a text[], sep text) returns text
  language sql immutable parallel safe as $$ select array_to_string(a, sep) $$;
`;

/** Creates the extensions, tables and indexes that are missing. Safe to run repeatedly and concurrently at start. */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(7270001)");
    await tx.exec(`create extension if not exists pg_trgm;${IMMUTABLE_HELPER_SQL}${SCHEMA_SQL}`);
  });
}
