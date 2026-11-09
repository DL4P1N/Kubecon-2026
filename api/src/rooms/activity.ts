import type { RoomActivity, RoomOccupancyResponse } from "@cc/shared";

/** Minute buckets hold aggregate counts only: no attendee IDs or per-scan records. */
export class RoomActivityCounter {
  private buckets = new Map<string, Map<number, number>>();
  readonly windowMinutes = 10;
  constructor(private now: () => number = Date.now) {}
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
        // Apply suppression after summing all minute buckets. No exact counts,
        // percentages or capacity estimates cross the public boundary.
        const level = count < 5 ? "quiet" : count < 20 ? "some recent check-ins" : "many recent check-ins";
        return { room, level };
      }) };
  }
}
