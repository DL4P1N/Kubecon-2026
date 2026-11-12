import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { runTraffic } from "../../scripts/traffic.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import type { Db } from "../src/db/client.js";
import { insertTalks, testDb } from "./pg.js";
import { talk } from "./helpers.js";

/** Runs the traffic generator against the real API (PGlite) over HTTP. */
describe("traffic generator against the API on a real in-process Postgres", () => {
  const talks = [
    talk("kcna26-1", 1, 2, { room: "Hall A", tags: ["security"] }),
    talk("kcna26-2", 2, 3, { room: "Hall B", tags: ["observability"] }),
    talk("kcna26-3", 1, 2, { room: "Hall B", tags: ["kubernetes"] }),
  ];
  let db: Db;
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    db = await testDb();
    await insertTalks(db, talks.map((t) => ({ ...t, level: "beginner" as const })));
    app = buildServer(loadConfig({ NODE_ENV: "test" }), { db, embedder: new LocalHashEmbedder() });
    url = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => { await app.close(); await db.close(); });

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
    const attendees = (await db.query<{ display_name: string; consent_cluster_map: boolean; consent_qr_checkin: boolean }>("select display_name, consent_cluster_map, consent_qr_checkin from attendees")).rows;
    expect(attendees.length).toBeGreaterThan(0);
    for (const a of attendees) {
      expect(a.display_name).toMatch(/^SYNTHETIC TRAFFIC \d+$/);
      expect([a.consent_cluster_map, a.consent_qr_checkin]).toEqual([true, true]);
    }
  });
});
