import type { RoomActivity, RoomOccupancyResponse } from "@cc/shared";

export function roomCapacities(raw: string | undefined): Map<string, number> {
  if (!raw) return new Map();
  const values: unknown = JSON.parse(raw);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid ROOM_CAPACITIES_JSON");
  const result = new Map<string, number>();
  for (const [room, capacity] of Object.entries(values)) {
    if (!room || room.length > 200 || !Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 100000) {
      throw new Error("Invalid room capacity configuration");
    }
    result.set(room, capacity as number);
  }
  return result;
}

/** Minute buckets hold aggregate counts only: no attendee IDs or per-scan records. */
export class RoomActivityCounter {
  private buckets = new Map<string, Map<number, number>>();
  readonly windowMinutes = 10;
  constructor(private capacities = new Map<string, number>(), private now: () => number = Date.now) {}
  private prune(minute: number) {
    for (const [room, counts] of this.buckets) {
      for (const bucket of counts.keys()) if (bucket <= minute - this.windowMinutes) counts.delete(bucket);
      if (counts.size === 0) this.buckets.delete(room);
    }
  }
  recordAllowed(room: string): void {
    const minute = Math.floor(this.now() / 60000);
    this.prune(minute);
    if (!this.buckets.has(room)) this.buckets.set(room, new Map());
    const counts = this.buckets.get(room)!;
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  snapshot(rooms: string[]): RoomOccupancyResponse {
    this.prune(Math.floor(this.now() / 60000));
    return { source: "in-process-scan-activity", windowMinutes: this.windowMinutes,
      rooms: [...new Set(rooms)].sort().map((room): RoomActivity => {
        const count = [...(this.buckets.get(room)?.values() ?? [])].reduce((sum, value) => sum + value, 0);
        const capacity = this.capacities.get(room) ?? null;
        // Suppress every number that could distinguish 0..4 scans.
        if (count < 5) return { room, level: "quiet", recentScans: null, capacity, percentage: null };
        const percentage = capacity === null ? null : Math.min(100, Math.round(count / capacity * 100));
        const level = percentage === null ? "busy" : percentage >= 80 ? "almost full" : percentage >= 40 ? "busy" : "quiet";
        return { room, level, recentScans: count, capacity, percentage };
      }) };
  }
}
