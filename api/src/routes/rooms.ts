import type { FastifyInstance } from "fastify";
import { routes } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import type { RoomActivityCounter } from "../rooms/activity.js";
import { withSpan } from "../telemetry/span.js";
import rateLimit from "@fastify/rate-limit";

export function registerRoomRoutes(root: FastifyInstance, es: EsClient, counter: RoomActivityCounter, perMinute = 120, now = Date.now): void {
  let catalog: { at: number; rooms: string[] } | undefined;
  let inflight: Promise<string[]> | undefined;
  async function catalogRooms(): Promise<string[]> {
    if (catalog && now() - catalog.at < 60_000) return catalog.rooms;
    inflight ??= (async () => {
      const { body } = await es.request<{ timed_out?: boolean; _shards?: { failed: number }; aggregations?: { rooms: { buckets: { key: string }[] } } }>(
        "POST", "/talks/_search", { size: 0, aggs: { rooms: { terms: { field: "room", size: 1000 } } } },
      );
      if (body.timed_out || body._shards?.failed || !body.aggregations?.rooms?.buckets) throw new Error("Catalog unavailable");
      const rooms = body.aggregations.rooms.buckets.map(({ key }) => key).filter((key) => typeof key === "string" && key.length > 0);
      catalog = { at: now(), rooms };
      return rooms;
    })().finally(() => { inflight = undefined; });
    return inflight;
  }
  root.register(async (app) => {
    await app.register(rateLimit, { global: false });
    app.get(routes.roomOccupancy.path, { config: { rateLimit: { max: perMinute, timeWindow: "1 minute" } } }, async (_req, reply) => {
      try {
        return await withSpan("rooms.occupancy", {}, async () => {
          reply.header("cache-control", "no-store");
          return counter.snapshot(await catalogRooms());
        });
      } catch { return reply.code(503).send({ error: "room_activity_unavailable" }); }
    });
  });
}
