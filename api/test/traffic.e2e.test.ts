import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { runTraffic } from "../../scripts/traffic.js";
import { esHit, fakeEs, talk } from "./helpers.js";

/** Runs the traffic generator against the real API (fake Elasticsearch) over HTTP. */
describe("traffic generator against the API with faked ES", () => {
  const talks = [
    talk("kcna26-1", 1, 2, { room: "Hall A", tags: ["security"] }),
    talk("kcna26-2", 2, 3, { room: "Hall B", tags: ["observability"] }),
    talk("kcna26-3", 1, 2, { room: "Hall B", tags: ["kubernetes"] }),
  ];
  const docs = new Map<string, unknown>();
  const es = fakeEs((call) => {
    if (call.path.endsWith("/_search")) return { body: { took: 1, hits: { hits: talks.map((t, i) => esHit(t, 3 - i)) } } };
    if (call.path.endsWith("/_count")) {
      const room = (call.body as { query?: { term?: { room?: string } } } | undefined)?.query?.term?.room;
      return { body: { count: room === undefined ? talks.length : talks.filter((t) => t.room === room).length } };
    }
    if (call.path.includes("_inference")) return { body: { text_embedding: [{ embedding: [0.6, 0.8] }] } };
    const m = /^\/([\w-]+)\/_(?:doc|create)\/([^?]+)/.exec(call.path);
    if (!m) return undefined;
    const key = `${m[1]}/${decodeURIComponent(m[2])}`;
    if (call.method === "PUT") { docs.set(key, call.body); return { body: { result: "created" } }; }
    return docs.has(key) ? { body: { found: true, _source: docs.get(key) } } : { status: 404, body: { found: false } };
  });
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = buildServer(loadConfig({ NODE_ENV: "test" }), { es });
    url = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => { await app.close(); });

  it("runs the whole mix with no 5xx and every flow succeeding", async () => {
    let t = Date.now();
    const out: string[] = [];
    const stats = await runTraffic({
      url, minutes: 0.5, rps: 5, now: () => t, sleep: async (ms) => { t += ms; }, log: (l) => out.push(l),
    });
    const summary = stats.summary();
    expect(stats.total).toBeGreaterThan(100);
    expect(summary).not.toMatch(/\s5\d\d=|error=/);
    for (const route of ["POST /api/register", "POST /api/onboarding", "POST /api/schedule", "GET /api/schedule", "POST /api/access/scan", "GET /api/status"]) {
      expect(summary).toContain(route);
    }
    expect(summary).toMatch(/POST \/api\/register\s+\d+\s+\S+\s+\S+\s+201=\d+$/m);
    expect(summary).toMatch(/POST \/api\/access\/scan\s+\d+\s+\S+\s+\S+\s+200=\d+$/m);
    const attendees = [...docs.entries()].filter(([k]) => k.startsWith("attendees/")).map(([, v]) => v as { display_name: string; consent: unknown });
    expect(attendees.length).toBeGreaterThan(0);
    for (const a of attendees) {
      expect(a.display_name).toMatch(/^SYNTHETIC TRAFFIC \d+$/);
      expect(a.consent).toEqual({ cluster_map: true, qr_checkin: true });
    }
  });
});
