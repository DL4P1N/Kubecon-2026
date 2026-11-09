import { MIN_CLUSTER_SIZE, OTHER_TOPIC, type InterestAggregateResponse, type InterestTopicCount } from "@cc/shared";
import type { EsClient } from "../es/client.js";

/** Upper bound on distinct topics read from the terms aggregation. */
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

/** Opted in to the cluster map and still inside the 24h retention window (expired docs count as deleted). */
const optedIn = (now: Date) => [
  { term: { "consent.cluster_map": true } },
  { range: { expires_at: { gt: now.toISOString() } } },
];

interface AggResponse {
  hits: { total: { value: number } | number };
  aggregations?: { topics?: { buckets?: TopicBucket[] } };
}

/** Runs the aggregation in Elasticsearch and applies the k >= 5 suppression. */
export async function aggregateInterests(es: EsClient, now: Date, k = MIN_CLUSTER_SIZE): Promise<InterestAggregateResponse> {
  const { body } = await es.request<AggResponse>("POST", "/attendees/_search", {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: optedIn(now) } },
    aggs: { topics: { terms: { field: "interests", size: MAX_TOPICS } } },
  });
  const total = typeof body.hits.total === "number" ? body.hits.total : body.hits.total.value;
  const { kept, small } = splitBuckets(body.aggregations?.topics?.buckets ?? [], k);

  // Count distinct attendees behind the small topics, so one person with several
  // rare interests is not counted several times toward the "other" threshold.
  let otherCount = 0;
  if (small.length > 0) {
    const res = await es.request<{ count: number }>("POST", "/attendees/_count", {
      query: { bool: { filter: [...optedIn(now), { terms: { interests: small } }] } },
    });
    otherCount = res.body.count;
  }

  return {
    topics: buildTopicCounts(kept, otherCount, k),
    totalOptedIn: total >= k ? total : 0,
    suppressedBelow: k,
    generatedAt: now.toISOString(),
  };
}

/** run_id prefix for aggregate snapshots (k-means runs, task #22, use their own). */
export const AGGREGATE_RUN_PREFIX = "aggregate-";

/**
 * Stores the latest result in `interest_clusters`: one doc per topic with a
 * stable _id (each write overwrites the last), then deletes topics from older
 * aggregate runs that are no longer present. Only suppressed, aggregate
 * counts are written; no attendee IDs.
 */
export async function writeAggregate(es: EsClient, result: InterestAggregateResponse): Promise<void> {
  const runId = `${AGGREGATE_RUN_PREFIX}${result.generatedAt}`;
  if (result.topics.length > 0) {
    const lines: object[] = [];
    for (const t of result.topics) {
      lines.push({ index: { _index: "interest_clusters", _id: `aggregate:${t.topic}` } });
      lines.push({
        cluster_id: `topic:${t.topic}`,
        run_id: runId,
        label: t.topic,
        size: t.count,
        top_interests: [t.topic],
        computed_at: result.generatedAt,
      });
    }
    const res = await es.bulk(lines);
    if (res.errors) throw new Error("interest_clusters write failed");
  }
  await es.request("POST", "/interest_clusters/_delete_by_query?conflicts=proceed", {
    query: {
      bool: {
        filter: [{ prefix: { run_id: AGGREGATE_RUN_PREFIX } }],
        must_not: [{ term: { run_id: runId } }],
      },
    },
  });
}
