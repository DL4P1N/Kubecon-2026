import type { Talk } from "@cc/shared";

export function talk(id: string, startHour: number, endHour: number, extra: Partial<Talk> = {}): Talk {
  const iso = (h: number) => new Date(Date.UTC(2026, 10, 10, 0, 0) + h * 3600_000).toISOString();
  return {
    id,
    title: `Talk ${id}`,
    speaker: "Someone",
    abstract: "About things.",
    track: "Security",
    room: "Hall A",
    start: iso(startHour),
    end: iso(endHour),
    tags: ["x"],
    ...extra,
  };
}
