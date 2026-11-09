import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  EVAL_QUESTIONS,
  MAX_REGISTRATIONS,
  MAX_RPS,
  MIX,
  RateLimiter,
  SYNTHETIC_NAME_PREFIX,
  backoffMs,
  clampRps,
  main,
  pickAction,
  planMix,
  runTraffic,
  type Action,
  type FetchLike,
} from "../../scripts/traffic.js";

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJlLXNlY3JldA";
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ROOM = "Salt Palace | Level 1 | Hall DE";
const TOKEN_LIKE = /eyJ[\w-]+\.[\w-]+\.[\w-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|Bearer/i;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
});

const catalogBody = {
  hits: [
    { talk: { id: "kcna26-1", room: ROOM, tags: ["security", "supply-chain"] }, score: 1 },
    { talk: { id: "kcna26-2", room: "Room 2", tags: ["observability"] }, score: 1 },
  ],
};

function fakeApi() {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, auth: init?.headers?.authorization });
    switch (`${method} ${u.pathname}`) {
      case "GET /api/search": return json(200, { q: "x", mode: u.searchParams.get("mode"), tookMs: 3, ...catalogBody });
      case "GET /api/status": return json(200, { status: "ok" });
      case "POST /api/register": return json(201, { attendeeId: UUID, token: JWT, expiresAt: "2026-11-10T00:00:00Z" });
      case "POST /api/onboarding": return json(200, { query: { text: "x", topics: [], mode: "hybrid" }, hits: [] });
      case "POST /api/schedule":
      case "GET /api/schedule": return json(200, { items: [], updatedAt: "2026-11-09T00:00:00Z" });
      case "POST /api/access/token": return json(200, { token: JWT, expiresAt: "2026-11-09T00:01:00Z" });
      case "POST /api/access/scan": return json(200, { decision: "allow", room: body.room });
      default: return json(404, { error: "not_found" });
    }
  };
  return { calls, fetch };
}

describe("traffic mix", () => {
  it("pickAction follows the weights", () => {
    const rand = seeded(1);
    const counts = Object.fromEntries(Object.keys(MIX).map((k) => [k, 0])) as Record<Action, number>;
    const n = 50_000;
    for (let i = 0; i < n; i++) counts[pickAction(rand())] += 1;
    const total = Object.values(MIX).reduce((a, b) => a + b, 0);
    for (const [a, w] of Object.entries(MIX) as [Action, number][]) {
      expect(counts[a] / n).toBeCloseTo(w / total, 1);
    }
    expect(pickAction(0)).toBe("catalog");
    expect(pickAction(0.9999999999)).toBe("access");
  });

  it("searches dominate and writes stay a small share", () => {
    const total = Object.values(MIX).reduce((a, b) => a + b, 0);
    expect((MIX.searchKeyword + MIX.searchHybrid) / total).toBeGreaterThanOrEqual(0.4);
    expect(MIX.register / total).toBeLessThan(0.05);
  });

  it("planMix sizes the run from minutes x rps and caps the rate", () => {
    const p = planMix(10, 2);
    expect(p.totalRequests).toBe(1200);
    const requests = Object.entries(p.actions).reduce((s, [a, n]) => s + n * (a === "access" ? 2 : 1), 0);
    expect(Math.abs(requests - 1200)).toBeLessThan(10);
    expect(planMix(10, 50).rps).toBe(MAX_RPS);
    expect(clampRps(-1)).toBe(2);
    expect(clampRps(Number.NaN)).toBe(2);
  });

  it("uses the 12 #36 eval questions", () => {
    expect(EVAL_QUESTIONS).toHaveLength(12);
    expect(new Set(EVAL_QUESTIONS).size).toBe(12);
  });
});

describe("rate limiter and backoff", () => {
  it("spaces slots by 1/rps across concurrent callers", async () => {
    const c = fakeClock();
    const lim = new RateLimiter(2, c.now, c.sleep);
    const t0 = c.now();
    const slots = await Promise.all([lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire()]);
    expect(slots.map((s) => s - t0)).toEqual([0, 500, 1000, 1500]);
  });

  it("never exceeds the hard cap", () => {
    const c = fakeClock();
    expect(new RateLimiter(1000, c.now, c.sleep).intervalMs).toBe(1000 / MAX_RPS);
  });

  it("pause pushes the next slot past the backoff", async () => {
    const c = fakeClock();
    const lim = new RateLimiter(2, c.now, c.sleep);
    const t0 = await lim.acquire();
    lim.pause(4000);
    expect((await lim.acquire()) - t0).toBe(4000);
  });

  it("backoff grows exponentially with jitter, honours Retry-After and is capped", () => {
    expect(backoffMs(1, null, () => 0)).toBe(500);
    expect(backoffMs(1, null, () => 1)).toBe(1000);
    expect(backoffMs(3, null, () => 0)).toBe(2000);
    expect(backoffMs(3, null, () => 0.999)).toBeLessThanOrEqual(4000);
    expect(backoffMs(1, "5", () => 0)).toBe(5000);
    expect(backoffMs(1, "garbage", () => 0)).toBe(500);
    expect(backoffMs(30, "9999", () => 1)).toBe(BACKOFF_MAX_MS);
  });
});

describe("runTraffic", () => {
  it("exercises every route, registers only synthetic attendees and never prints tokens or ids", async () => {
    const c = fakeClock();
    const api = fakeApi();
    const out: string[] = [];
    const stats = await runTraffic({
      url: "http://127.0.0.1:18085/", minutes: 3, rps: 2, fetch: api.fetch, now: c.now, sleep: c.sleep, rand: seeded(7),
      log: (l) => out.push(l),
    });
    out.push(stats.summary());
    const text = out.join("\n");

    expect(text).not.toMatch(TOKEN_LIKE);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(UUID);
    for (const q of EVAL_QUESTIONS) expect(text).not.toContain(q);

    // Paced: ~3 min x 2 rps (+ in-flight overshoot).
    expect(stats.total).toBeGreaterThan(300);
    expect(stats.total).toBeLessThanOrEqual(3 * 60 * 2 + 5);

    const first = api.calls[0];
    expect(first.path).toBe("/api/search");
    const paths = new Set(api.calls.map((x) => `${x.method} ${x.path}`));
    for (const p of ["GET /api/status", "POST /api/register", "POST /api/onboarding", "POST /api/schedule", "GET /api/schedule", "POST /api/access/token", "POST /api/access/scan"]) {
      expect(paths).toContain(p);
    }
    const regs = api.calls.filter((x) => x.path === "/api/register");
    expect(regs.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    for (const r of regs) {
      const b = r.body as { name: string; consent: unknown; email?: string };
      expect(b.name.startsWith(SYNTHETIC_NAME_PREFIX)).toBe(true);
      expect(b.consent).toEqual({ clusterMap: true, qrCheckin: true });
      expect(b.email).toBeUndefined();
    }
    for (const s of api.calls.filter((x) => x.path === "/api/access/scan")) {
      expect((s.body as { room: string }).room).toMatch(/^(Salt Palace \| Level 1 \| Hall DE|Room 2)$/);
    }
    expect(api.calls.filter((x) => x.path === "/api/schedule").every((x) => x.auth === `Bearer ${JWT}`)).toBe(true);
  });

  it("backs off on 429/503 instead of hammering", async () => {
    const c = fakeClock();
    let n = 0;
    const fetch: FetchLike = async () => { n += 1; return json(429, { error: "rate_limited" }, { "retry-after": "10" }); };
    const stats = await runTraffic({ url: "http://x", minutes: 1, rps: 5, fetch, now: c.now, sleep: c.sleep, rand: () => 0.5, log: () => {} });
    // Without backoff this would be ~300 requests in a minute at 5 rps.
    expect(n).toBeLessThan(20);
    expect(stats.summary()).toMatch(/429=/);
  });

  it("survives network errors without printing them", async () => {
    const c = fakeClock();
    const out: string[] = [];
    const fetch: FetchLike = async (url) => { throw new Error(`connect ECONNREFUSED ${url} ${JWT}`); };
    const stats = await runTraffic({ url: "http://x", minutes: 1, fetch, now: c.now, sleep: c.sleep, rand: seeded(3), log: (l) => out.push(l) });
    out.push(stats.summary());
    expect(out.join("\n")).not.toMatch(TOKEN_LIKE);
    expect(stats.summary()).toMatch(/error=/);
  });
});

describe("cli", () => {
  it("--dry-run prints the plan without touching the network", async () => {
    const out: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network used in dry run"); }) as typeof fetch;
    try {
      await main(["--url", "http://127.0.0.1:18085", "--minutes", "10", "--dry-run"], (l) => out.push(l));
    } finally {
      globalThis.fetch = orig;
    }
    const text = out.join("\n");
    expect(text).toContain("dry run (no network)");
    expect(text).toContain("~1200 requests");
    for (const a of Object.keys(MIX)) expect(text).toContain(a);
  });

  it("rejects a missing url", async () => {
    await expect(main(["--minutes", "1", "--dry-run"], () => {})).rejects.toThrow(/--url/);
  });
});
