import type { FastifyInstance } from "fastify";
import { routes } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import type { RoomActivityCounter } from "../rooms/activity.js";
import { withSpan } from "../telemetry/span.js";

export function registerRoomRoutes(app: FastifyInstance, es: EsClient, counter: RoomActivityCounter): void {
  app.get(routes.roomOccupancy.path, async (_req, reply) => {
    try {
      return await withSpan("rooms.occupancy", {}, async () => {
        const { body } = await es.request<{ timed_out?: boolean; _shards?: { failed: number }; aggregations?: { rooms: { buckets: { key: string }[] } } }>(
          "POST", "/talks/_search", { size: 0, aggs: { rooms: { terms: { field: "room", size: 1000 } } } },
        );
        if (body.timed_out || body._shards?.failed || !body.aggregations?.rooms?.buckets) throw new Error("Catalog unavailable");
        const rooms = body.aggregations.rooms.buckets.map(({ key }) => key).filter((key) => typeof key === "string" && key.length > 0);
        return counter.snapshot(rooms);
      });
    } catch { return reply.code(503).send({ error: "room_activity_unavailable" }); }
  });
}
