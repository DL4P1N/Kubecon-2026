import { MIN_CLUSTER_SIZE, OTHER_TOPIC, type InterestAggregateResponse, type InterestTopicCount } from "@cc/shared";
import type { Db } from "../db/client.js";

/** Upper bound on distinct topics read by the topic count. */
export const MAX_TOPICS = 500;

export interface TopicBucket {
  key: string;
  doc_count: number;
}

/**
 * k-anonymity (design doc section 6): keeps topics with at least `k` attendees
 * and returns the names of the smaller ones so their attendees can be counted
 * once, as a single "other" group.
 */
export function splitBuckets(buckets: TopicBucket[], k = MIN_CLUSTER_SIZE): { kept: InterestTopicCount[]; small: string[] } {
  const kept: InterestTopicCount[] = [];
  const small: string[] = [];
  for (const b of buckets) {
    if (b.doc_count >= k && b.key !== OTHER_TOPIC) kept.push({ topic: b.key, count: b.doc_count });
    else small.push(b.key);
  }
  return { kept, small };
}

/**
 * Builds the public topic list: small topics never appear individually; their
 * distinct attendees (`otherCount`) form one "other" bucket, dropped when it
 * is itself below `k`. Sorted by count, descending.
 */
export function buildTopicCounts(kept: InterestTopicCount[], otherCount: number, k = MIN_CLUSTER_SIZE): InterestTopicCount[] {
  const topics = kept.filter((t) => t.count >= k);
  if (otherCount >= k) topics.push({ topic: OTHER_TOPIC, count: otherCount });
  return topics.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/** Attendees opted in to the cluster map and not past an expiry (expired rows count as deleted). */
const OPTED_IN = "consent_cluster_map and expires_at > $1";

/**
 * Counts topics in SQL and applies the k >= 5 suppression. Only catalog tags become topics: the
 * endpoint is public and registration is open, so free-text interests would let anyone put text on the map.
 */
export async function aggregateInterests(db: Db, now: Date, k = MIN_CLUSTER_SIZE): Promise<InterestAggregateResponse> {
  const at = now.toISOString();
  // distinct per attendee: a repeated interest in one profile counts once.
  const topics = await db.query<{ key: string; doc_count: string }>(
    `select t as key, count(*) as doc_count
       from (select distinct id, unnest(interests) as t from attendees where ${OPTED_IN}) x
     where t in (select unnest(tags) from talks)
      group by t
      order by count(*) desc, t
      limit $2`,
    [at, MAX_TOPICS],
  );
  const total = await db.query<{ n: string }>(`select count(*) as n from attendees where ${OPTED_IN}`, [at]);
  const buckets = topics.rows.map((r) => ({ key: r.key, doc_count: Number(r.doc_count) }));
  const totalOptedIn = Number(total.rows[0]?.n ?? 0);
  const { kept, small } = splitBuckets(buckets, k);

  // Count distinct attendees behind the small topics, so one person with several
  // rare interests is not counted several times toward the "other" threshold.
  let otherCount = 0;
  if (small.length > 0) {
    const res = await db.query<{ n: string }>(`select count(*) as n from attendees where ${OPTED_IN} and interests && $2::text[]`, [at, small]);
    otherCount = Number(res.rows[0]?.n ?? 0);
  }

  return {
    topics: buildTopicCounts(kept, otherCount, k),
    totalOptedIn: totalOptedIn >= k ? totalOptedIn : 0,
    suppressedBelow: k,
    generatedAt: now.toISOString(),
  };
}

/** run_id prefix for aggregate snapshots (k-means runs, task #22, use their own). */
export const AGGREGATE_RUN_PREFIX = "aggregate-";

/**
 * Stores the latest result in `interest_clusters`: one row per topic with a
 * stable doc_id (each write overwrites the last), then deletes topics from older
 * aggregate runs that are no longer present. Only suppressed, aggregate
 * counts are written; no attendee IDs.
 */
export async function writeAggregate(db: Db, result: InterestAggregateResponse): Promise<void> {
  const runId = `${AGGREGATE_RUN_PREFIX}${result.generatedAt}`;
  await db.transaction(async (tx) => {
    for (const t of result.topics) {
      await tx.query(
        `insert into interest_clusters (doc_id, cluster_id, run_id, label, size, top_interests, computed_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (doc_id) do update set cluster_id = excluded.cluster_id, run_id = excluded.run_id, label = excluded.label,
           size = excluded.size, top_interests = excluded.top_interests, computed_at = excluded.computed_at`,
        [`aggregate:${t.topic}`, `topic:${t.topic}`, runId, t.topic, t.count, [t.topic], result.generatedAt],
      );
    }
    await tx.query(`delete from interest_clusters where starts_with(run_id, $1) and run_id <> $2`, [AGGREGATE_RUN_PREFIX, runId]);
  });
}
