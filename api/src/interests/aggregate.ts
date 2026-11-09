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

const OPTED_IN = { term: { "consent.cluster_map": true } };

interface AggResponse {
  hits: { total: { value: number } | number };
  aggregations?: { topics?: { buckets?: TopicBucket[] } };
}

/** Runs the aggregation in Elasticsearch and applies the k >= 5 suppression. */
export async function aggregateInterests(es: EsClient, now: Date, k = MIN_CLUSTER_SIZE): Promise<InterestAggregateResponse> {
  const { body } = await es.request<AggResponse>("POST", "/attendees/_search", {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: [OPTED_IN] } },
    aggs: { topics: { terms: { field: "interests", size: MAX_TOPICS } } },
  });
  const total = typeof body.hits.total === "number" ? body.hits.total : body.hits.total.value;
  const { kept, small } = splitBuckets(body.aggregations?.topics?.buckets ?? [], k);

  // Count distinct attendees behind the small topics, so one person with several
  // rare interests is not counted several times toward the "other" threshold.
  let otherCount = 0;
  if (small.length > 0) {
    const res = await es.request<{ count: number }>("POST", "/attendees/_count", {
      query: { bool: { filter: [OPTED_IN, { terms: { interests: small } }] } },
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

/**
 * Stores the latest result in `interest_clusters` (one doc per topic, same
 * run_id). Only suppressed, aggregate counts are written; no attendee IDs.
 */
export async function writeAggregate(es: EsClient, result: InterestAggregateResponse): Promise<void> {
  if (result.topics.length === 0) return;
  const runId = `aggregate-${result.generatedAt}`;
  const lines: object[] = [];
  result.topics.forEach((t, i) => {
    lines.push({ index: { _index: "interest_clusters", _id: `${runId}-${i}` } });
    lines.push({
      cluster_id: `topic:${t.topic}`,
      run_id: runId,
      label: t.topic,
      size: t.count,
      top_interests: [t.topic],
      computed_at: result.generatedAt,
    });
  });
  await es.bulk(lines);
}
