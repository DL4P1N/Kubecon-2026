import {
  OTHER_TOPIC,
  type InterestTopicCount,
  type RoomPlacementResponse,
  type RoomPlacementSlot,
  type RoomPlacementTalk,
  type Talk,
} from "@cc/shared";

/** The talk fields placement reads; attendee data never enters this module. */
export type PlacementTalk = Pick<Talk, "id" | "title" | "room" | "start" | "end" | "tags">;

/** Room name to seats. A room that is absent has an unknown capacity; none is ever assumed. */
export type RoomCapacities = Readonly<Record<string, number>>;

export interface PlacementInput {
  talks: readonly PlacementTalk[];
  /**
   * Topic counts exactly as the interests aggregate returns them, i.e. already
   * k-anonymised: topics under MIN_CLUSTER_SIZE are absent and stay absent here.
   */
  aggregate: readonly InterestTopicCount[];
  capacities: RoomCapacities;
  suppressedBelow: number;
  generatedAt: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Demand formula: demand(talk) = sum of count(topic) over the talk's distinct
 * tags that appear in the aggregate (tags compared trimmed, case-insensitive).
 * Tags missing from the aggregate (suppressed, k < MIN_CLUSTER_SIZE) add 0,
 * and the merged OTHER_TOPIC bucket is never matched. An attendee interested
 * in two of a talk's tags is counted once per tag, so demand is a relative
 * score (an upper bound on interested attendees), not a headcount. It ranks
 * talks; it is never compared with room capacity (see talkPeakInterest).
 */
export function talkDemand(tags: readonly string[], aggregate: readonly InterestTopicCount[]): number {
  const counts = new Map<string, number>();
  for (const t of aggregate) if (t.topic !== OTHER_TOPIC) counts.set(norm(t.topic), t.count);
  let demand = 0;
  for (const tag of new Set(tags.map(norm))) demand += counts.get(tag) ?? 0;
  return demand;
}

/**
 * The largest single-topic count among the talk's distinct tags present in the
 * aggregate. One topic's count is a count of distinct attendees, so this figure
 * can never count a person twice (unlike talkDemand) and is a lower bound on
 * the talk's interested attendees: it is what is compared with room capacity.
 */
export function talkPeakInterest(tags: readonly string[], aggregate: readonly InterestTopicCount[]): number {
  const counts = new Map<string, number>();
  for (const t of aggregate) if (t.topic !== OTHER_TOPIC) counts.set(norm(t.topic), t.count);
  let peak = 0;
  for (const tag of new Set(tags.map(norm))) peak = Math.max(peak, counts.get(tag) ?? 0);
  return peak;
}

const known = (capacities: RoomCapacities, room: string): number | null => {
  const c = Object.prototype.hasOwnProperty.call(capacities, room) ? capacities[room] : undefined;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
};

interface Entry {
  talk: PlacementTalk;
  demand: number;
  /** Largest single-topic attendee count; the only figure compared with capacity. */
  peak: number;
  capacity: number | null;
  startMs: number;
  endMs: number;
}

/**
 * Pure and deterministic room placement.
 *
 * Slots are talks with the identical start and end instant. Within a slot,
 * demand ranks the talks (highest first; ties by current room capacity, then
 * talk id, so equal-demand talks keep their rooms where they can). The rooms a
 * slot already uses are then re-dealt by capacity: the highest-demand talk
 * gets the largest room. Equal-capacity rooms count as interchangeable, and a
 * talk keeps its own room when it is among them.
 *
 * Capacity is never invented. A room without a configured capacity cannot be
 * ranked, so it is left out of the re-dealing: its talk gets
 * `capacityKnown: false` and `suggestedRoom: null`, and only `demandRank`
 * says anything about it. Over-capacity and moved are never flagged for it.
 *
 * `overCapacity` compares the room's seats with the largest single-topic
 * attendee count of the talk, not with the (double-counting) demand score, so
 * it only fires when at least that many distinct attendees want the talk.
 */
export function planPlacement(input: PlacementInput): RoomPlacementResponse {
  const slots = new Map<string, Entry[]>();
  let skippedTalks = 0;
  for (const talk of input.talks) {
    const startMs = Date.parse(talk.start);
    const endMs = Date.parse(talk.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      skippedTalks++;
      continue;
    }
    const key = `${startMs}|${endMs}`;
    const entry: Entry = {
      talk,
      demand: talkDemand(talk.tags, input.aggregate),
      peak: talkPeakInterest(talk.tags, input.aggregate),
      capacity: known(input.capacities, talk.room),
      startMs,
      endMs,
    };
    const list = slots.get(key);
    if (list) list.push(entry);
    else slots.set(key, [entry]);
  }

  const out: RoomPlacementSlot[] = [...slots.values()]
    .sort((a, b) => a[0].startMs - b[0].startMs || a[0].endMs - b[0].endMs)
    .map((entries) => {
      const ordered = [...entries].sort(
        (a, b) =>
          b.demand - a.demand ||
          (b.capacity ?? -1) - (a.capacity ?? -1) ||
          a.talk.id.localeCompare(b.talk.id),
      );
      // Rooms that can be ranked: distinct current rooms of this slot with a known capacity.
      const pool = new Map<string, number>();
      for (const e of ordered) if (e.capacity !== null) pool.set(e.talk.room, e.capacity);

      const talks: RoomPlacementTalk[] = ordered.map((e, i) => {
        const room = e.talk.room;
        let suggestedRoom: string | null = null;
        if (e.capacity !== null) {
          // Largest remaining capacity; equal-capacity rooms are interchangeable.
          let best = -Infinity;
          for (const c of pool.values()) best = Math.max(best, c);
          const tied = [...pool].filter(([, c]) => c === best).map(([r]) => r).sort();
          suggestedRoom = tied.includes(room) ? room : (tied[0] ?? room); // exhausted pool (double-booked room): keep
          pool.delete(suggestedRoom);
        }
        return {
          talkId: e.talk.id,
          title: e.talk.title,
          demand: e.demand,
          demandRank: i + 1,
          currentRoom: room,
          currentCapacity: e.capacity,
          capacityKnown: e.capacity !== null,
          suggestedRoom,
          moved: suggestedRoom !== null && suggestedRoom !== room,
          overCapacity: e.capacity !== null && e.peak > e.capacity,
        };
      });
      return { start: new Date(entries[0].startMs).toISOString(), end: new Date(entries[0].endMs).toISOString(), talks };
    });

  return {
    generatedAt: input.generatedAt,
    suppressedBelow: input.suppressedBelow,
    capacitiesConfigured: Object.keys(input.capacities).length > 0,
    slots: out,
    skippedTalks,
  };
}
