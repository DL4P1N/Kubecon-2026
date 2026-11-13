import type { FastifyInstance } from "fastify";
import { routes } from "@cc/shared";
import type { Db } from "../db/client.js";
import { applyRateLimit, limitFor } from "../http/rateLimit.js";
import { runQuery } from "../search/errors.js";
import type { RoomActivityCounter } from "../rooms/activity.js";
import { withSpan } from "../telemetry/span.js";

export function registerRoomRoutes(root: FastifyInstance, db: Db, counter: RoomActivityCounter, perMinute = 120, now = Date.now): void {
  let catalog: { at: number; rooms: string[] } | undefined;
  let inflight: Promise<string[]> | undefined;
  async function catalogRooms(): Promise<string[]> {
    if (catalog && now() - catalog.at < 60_000) return catalog.rooms;
    inflight ??= (async () => {
      const rows = await runQuery<{ room: string }>(db, "select distinct room from talks where room is not null and room <> '' order by room");
      const rooms = rows.map(({ room }) => room);
      catalog = { at: now(), rooms };
      return rooms;
    })().finally(() => { inflight = undefined; });
    return inflight;
  }
  root.register(async (app) => {
    await applyRateLimit(app);
    app.get(routes.roomOccupancy.path, limitFor({ max: perMinute }), async (_req, reply) => {
      try {
        return await withSpan("rooms.occupancy", {}, async () => {
          reply.header("cache-control", "no-store");
          return counter.snapshot(await catalogRooms());
        });
      } catch { return reply.code(503).send({ error: "room_activity_unavailable" }); }
    });
  });
}
