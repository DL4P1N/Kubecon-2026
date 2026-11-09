/**
 * Gentle synthetic traffic for the Dash0 dashboard and SLOs (#14, #48).
 *
 *   npx tsx scripts/traffic.ts --url http://127.0.0.1:18085 --minutes 10 [--rps 2] [--dry-run]
 *
 * Mix (weighted): catalog browse, keyword + hybrid searches (the #36 eval
 * questions from scripts/search-eval.ts), /api/status polls, a few
 * registrations of clearly SYNTHETIC attendees ("SYNTHETIC TRAFFIC ...", both
 * consents true, no real data; the API expires them after 24h via retention),
 * onboarding + schedule save/get with those sessions, and an occasional QR
 * access token + scan against a real room from the catalog.
 *
 * Safety: default 2 req/s, hard cap 5 req/s, at most 5 registrations per run,
 * backs off with jitter on 429/503 (honours Retry-After). Tokens and IDs stay
 * in memory only: nothing is logged except per-route request counts, status
 * code counts and client-side p50/p95. `--dry-run` makes no network calls and
 * prints the planned mix.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_RPS = 2;
export const MAX_RPS = 5;
export const MAX_MINUTES = 60;
export const MAX_REGISTRATIONS = 5;
export const WORKERS = 3;
export const SYNTHETIC_NAME_PREFIX = "SYNTHETIC TRAFFIC";

/** The 12 paraphrased attendee questions of the #36 relevance eval (scripts/search-eval.ts EVAL_SET). */
export const EVAL_QUESTIONS = [
  "make sure nobody can tamper with the software I ship to customers",
  "my pager keeps going off at night and I want a computer to help figure out why",
  "spend less money on the machines my containers run on",
  "who is allowed to do what inside my cluster",
  "let people ask questions about our internal documents without sending them to a third party",
  "my pods take ages to start because downloading the container takes forever",
  "keep passwords and API keys out of my config files",
  "automatically add more copies of my service when traffic spikes",
  "release a new version to a small slice of users first so a bad deploy does not break everything",
  "split one expensive graphics card between several jobs",
  "run code written by an AI model without it harming the rest of my system",
  "get my stateful apps back after someone deletes the cluster by accident",
] as const;

/** Broad keyword terms used to browse the catalog (talk tags, rooms and ids are read from the hits). */
export const CATALOG_TERMS = ["kubernetes", "observability", "security", "platform", "ai"] as const;
const FALLBACK_TOPICS = ["kubernetes", "observability", "security"];

export type Action =
  | "catalog"
  | "searchKeyword"
  | "searchHybrid"
  | "status"
  | "register"
  | "onboarding"
  | "scheduleSave"
  | "scheduleGet"
  | "access";

/** Relative weights of each action. `access` issues two requests (token + scan). */
export const MIX: Readonly<Record<Action, number>> = {
  catalog: 10,
  searchKeyword: 25,
  searchHybrid: 25,
  status: 15,
  register: 3,
  onboarding: 6,
  scheduleSave: 5,
  scheduleGet: 7,
  access: 4,
};

/** Requests each action issues. */
const REQUESTS_PER_ACTION: Readonly<Record<Action, number>> = {
  catalog: 1, searchKeyword: 1, searchHybrid: 1, status: 1, register: 1,
  onboarding: 1, scheduleSave: 1, scheduleGet: 1, access: 2,
};

/** Picks an action for a uniform random number r in [0, 1). */
export function pickAction(r: number, mix: Readonly<Record<Action, number>> = MIX): Action {
  const entries = Object.entries(mix) as [Action, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const [a, w] of entries) {
    if (x < w) return a;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

export function clampRps(rps: number): number {
  if (!Number.isFinite(rps) || rps <= 0) return DEFAULT_RPS;
  return Math.min(rps, MAX_RPS);
}

export interface Plan {
  rps: number;
  minutes: number;
  totalRequests: number;
  actions: Record<Action, number>;
}

/** Expected number of each action for the run (what --dry-run prints). */
export function planMix(minutes: number, rps: number, mix: Readonly<Record<Action, number>> = MIX): Plan {
  const r = clampRps(rps);
  const m = Math.min(Math.max(minutes, 0), MAX_MINUTES);
  const totalRequests = Math.floor(r * 60 * m);
  const entries = Object.entries(mix) as [Action, number][];
  const weightSum = entries.reduce((s, [, w]) => s + w, 0);
  const reqPerAction = entries.reduce((s, [a, w]) => s + (w / weightSum) * REQUESTS_PER_ACTION[a], 0);
  const totalActions = totalRequests / reqPerAction;
  const actions = {} as Record<Action, number>;
  for (const [a, w] of entries) actions[a] = Math.round((totalActions * w) / weightSum);
  return { rps: r, minutes: m, totalRequests, actions };
}

// ------------------------------------------------------------------ pacing

/**
 * Shared pacer: hands out request slots at most `rps` per second across all
 * workers, and pauses everyone after a 429/503 until `pauseUntil`.
 */
export class RateLimiter {
  private next = 0;
  private pausedUntil = 0;
  readonly intervalMs: number;
  constructor(
    rps: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.intervalMs = 1000 / clampRps(rps);
  }
  /** Reserves the next slot and waits for it. Returns the slot time. */
  async acquire(): Promise<number> {
    const t = Math.max(this.now(), this.next, this.pausedUntil);
    this.next = t + this.intervalMs;
    const wait = t - this.now();
    if (wait > 0) await this.sleep(wait);
    return t;
  }
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.next = Math.max(this.next, this.pausedUntil);
  }
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff with full jitter, floored by Retry-After (seconds) when
 * the server sent one. `attempt` counts consecutive throttled responses from 1.
 */
export function backoffMs(attempt: number, retryAfter: string | null | undefined, rand: () => number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = exp / 2 + rand() * (exp / 2);
  const ra = retryAfter == null ? NaN : Number(retryAfter);
  const floor = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, BACKOFF_MAX_MS) : 0;
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(jittered, floor)));
}

// ------------------------------------------------------------------ stats

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export class Stats {
  private readonly perRoute = new Map<string, { codes: Map<string, number>; ms: number[] }>();
  record(route: string, status: number | "error", ms: number): void {
    let r = this.perRoute.get(route);
    if (!r) this.perRoute.set(route, (r = { codes: new Map(), ms: [] }));
    const k = String(status);
    r.codes.set(k, (r.codes.get(k) ?? 0) + 1);
    r.ms.push(ms);
  }
  get total(): number {
    let n = 0;
    for (const r of this.perRoute.values()) n += r.ms.length;
    return n;
  }
  /** Route labels are fixed strings, never URLs with query text, tokens or IDs. */
  summary(): string {
    const lines = ["route                     requests  p50_ms  p95_ms  status_codes"];
    const all: number[] = [];
    const codes = new Map<string, number>();
    for (const [route, r] of [...this.perRoute.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...r.ms].sort((a, b) => a - b);
      all.push(...sorted);
      for (const [c, n] of r.codes) codes.set(c, (codes.get(c) ?? 0) + n);
      const cs = [...r.codes.entries()].sort().map(([c, n]) => `${c}=${n}`).join(" ");
      lines.push(
        `${route.padEnd(25)} ${String(r.ms.length).padStart(8)}  ${fmt(percentile(sorted, 50))}  ${fmt(percentile(sorted, 95))}  ${cs}`,
      );
    }
    all.sort((a, b) => a - b);
    lines.push(
      `${"TOTAL".padEnd(25)} ${String(all.length).padStart(8)}  ${fmt(percentile(all, 50))}  ${fmt(percentile(all, 95))}  ${[...codes.entries()].sort().map(([c, n]) => `${c}=${n}`).join(" ")}`,
    );
    return lines.join("\n");
  }
}
const fmt = (v: number | null) => (v === null ? "-" : String(Math.round(v))).padStart(6);

// ------------------------------------------------------------------ runner

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface RunOptions {
  url: string;
  minutes: number;
  rps?: number;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  log?: (line: string) => void;
  workers?: number;
}

interface Session {
  /** Bearer token; kept in memory only, never logged. */
  token: string;
  topics: string[];
}

interface Catalog {
  topics: string[];
  rooms: string[];
  talkIds: string[];
}

interface Talkish { talk?: { id?: unknown; room?: unknown; tags?: unknown } }

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

export async function runTraffic(opts: RunOptions): Promise<Stats> {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = opts.rand ?? Math.random;
  const log = opts.log ?? ((l: string) => console.log(l));
  const limiter = new RateLimiter(opts.rps ?? DEFAULT_RPS, now, sleep);
  const stats = new Stats();
  const deadline = now() + Math.min(Math.max(opts.minutes, 0), MAX_MINUTES) * 60_000;
  const catalog: Catalog = { topics: [], rooms: [], talkIds: [] };
  const sessions: Session[] = [];
  let registrations = 0;
  let throttled = 0;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];

  /** One paced request. `route` is a fixed label; the URL (query text) is never logged. */
  async function call(route: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown }> {
    await limiter.acquire();
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const start = performance.now();
    try {
      const res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const ms = performance.now() - start;
      stats.record(route, res.status, ms);
      if (res.status === 429 || res.status === 503) {
        throttled += 1;
        limiter.pause(backoffMs(throttled, res.headers.get("retry-after"), rand));
      } else {
        throttled = 0;
      }
      let json: unknown = undefined;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      return { status: res.status, json };
    } catch {
      // Network error: count it, back off, never print the error (could echo the URL).
      stats.record(route, "error", performance.now() - start);
      throttled += 1;
      limiter.pause(backoffMs(throttled, null, rand));
      return { status: 0, json: undefined };
    }
  }

  function learnCatalog(json: unknown): void {
    const hits = (json as { hits?: Talkish[] } | undefined)?.hits;
    if (!Array.isArray(hits)) return;
    const topics = new Set(catalog.topics), rooms = new Set(catalog.rooms), ids = new Set(catalog.talkIds);
    for (const h of hits) {
      const t = h?.talk;
      if (!t) continue;
      if (typeof t.id === "string") ids.add(t.id);
      if (typeof t.room === "string" && t.room.trim()) rooms.add(t.room);
      if (Array.isArray(t.tags)) for (const tag of t.tags) if (typeof tag === "string" && tag.length <= 64) topics.add(tag);
    }
    catalog.topics = [...topics].slice(0, 200);
    catalog.rooms = [...rooms].slice(0, 100);
    catalog.talkIds = [...ids].slice(0, 500);
  }

  const topicsFor = (n: number) => {
    const pool = catalog.topics.length ? catalog.topics : FALLBACK_TOPICS;
    return [...new Set(Array.from({ length: n }, () => pick(pool)))];
  };

  async function register(): Promise<Session | undefined> {
    if (registrations >= MAX_REGISTRATIONS) return undefined;
    registrations += 1;
    const topics = topicsFor(3);
    const r = await call("POST /api/register", "POST", "/api/register", {
      name: `${SYNTHETIC_NAME_PREFIX} ${registrations}`,
      interests: topics,
      consent: { clusterMap: true, qrCheckin: true },
    });
    const token = (r.json as { token?: unknown } | undefined)?.token;
    if (r.status !== 201 || typeof token !== "string") return undefined;
    const s = { token, topics };
    sessions.push(s);
    return s;
  }

  async function session(): Promise<Session | undefined> {
    if (sessions.length && (sessions.length >= MAX_REGISTRATIONS || registrations >= MAX_REGISTRATIONS || rand() < 0.7)) {
      return pick(sessions);
    }
    return (await register()) ?? (sessions.length ? pick(sessions) : undefined);
  }

  const answers = (s: Session) => ({
    topics: s.topics,
    experience: pick(LEVELS),
    goals: ["learn"],
    freeText: pick(EVAL_QUESTIONS),
  });

  const search = (mode: "keyword" | "hybrid", q: string, route = `GET /api/search ${mode}`) =>
    call(route, "GET", `/api/search?q=${encodeURIComponent(q)}&mode=${mode}&size=10`);

  async function browseCatalog(): Promise<void> {
    const r = await call("GET catalog (keyword)", "GET", `/api/search?q=${encodeURIComponent(pick(CATALOG_TERMS))}&mode=keyword&size=50`);
    if (r.status === 200) learnCatalog(r.json);
  }

  async function perform(action: Action): Promise<void> {
    switch (action) {
      case "catalog": return browseCatalog();
      case "searchKeyword": { const r = await search("keyword", pick(EVAL_QUESTIONS)); if (r.status === 200) learnCatalog(r.json); return; }
      case "searchHybrid": { await search("hybrid", pick(EVAL_QUESTIONS)); return; }
      case "status": { await call("GET /api/status", "GET", "/api/status"); return; }
      case "register": { if (!(await register())) await call("GET /api/status", "GET", "/api/status"); return; }
      case "onboarding": {
        const s = await session();
        if (s) await call("POST /api/onboarding", "POST", "/api/onboarding", { answers: answers(s) }, s.token);
        return;
      }
      case "scheduleSave": {
        const s = await session();
        if (!s) return;
        const body = catalog.talkIds.length && rand() < 0.5
          ? { talkIds: Array.from({ length: 4 }, () => pick(catalog.talkIds)).filter((v, i, a) => a.indexOf(v) === i), maxTalks: 6 }
          : { answers: answers(s), maxTalks: 6 };
        await call("POST /api/schedule", "POST", "/api/schedule", body, s.token);
        return;
      }
      case "scheduleGet": {
        const s = await session();
        if (s) await call("GET /api/schedule", "GET", "/api/schedule", undefined, s.token);
        return;
      }
      case "access": {
        const s = await session();
        if (!s) return;
        if (!catalog.rooms.length) await browseCatalog();
        if (!catalog.rooms.length) return;
        const t = await call("POST /api/access/token", "POST", "/api/access/token", {}, s.token);
        const qr = (t.json as { token?: unknown } | undefined)?.token;
        if (t.status === 200 && typeof qr === "string") {
          await call("POST /api/access/scan", "POST", "/api/access/scan", { token: qr, room: pick(catalog.rooms) });
        }
        return;
      }
    }
  }

  log(`traffic: ${base} for ${Math.min(opts.minutes, MAX_MINUTES)} min at ${limiter.intervalMs > 0 ? (1000 / limiter.intervalMs).toFixed(1) : "?"} req/s (synthetic attendees prefixed "${SYNTHETIC_NAME_PREFIX}", max ${MAX_REGISTRATIONS})`);
  // Warm-up: one hybrid query first (the first semantic call can be slow while the model loads), then the catalog.
  await search("hybrid", EVAL_QUESTIONS[0], "GET /api/search hybrid (warm-up)");
  await browseCatalog();

  const worker = async () => {
    while (now() < deadline) await perform(pickAction(rand()));
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.workers ?? WORKERS) }, worker));
  return stats;
}

export function formatPlan(url: string, p: Plan): string {
  const lines = [
    `dry run (no network): ${url} for ${p.minutes} min at ${p.rps} req/s (cap ${MAX_RPS}) = ~${p.totalRequests} requests`,
    "action          weight  planned",
  ];
  for (const a of Object.keys(MIX) as Action[]) {
    lines.push(`${a.padEnd(15)} ${String(MIX[a]).padStart(6)}  ${String(p.actions[a]).padStart(7)}${a === "access" ? "  (token + scan = 2 requests each)" : ""}`);
  }
  lines.push(`plus 1 hybrid warm-up and 1 catalog request first; registrations capped at ${MAX_REGISTRATIONS} (then existing sessions are reused)`);
  return lines.join("\n");
}

export interface Args { url: string; minutes: number; rps: number; dryRun: boolean }

export function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get("--url") ?? process.env.APP_URL ?? "";
  const minutes = Number(get("--minutes") ?? 10);
  const rps = Number(get("--rps") ?? DEFAULT_RPS);
  if (!/^https?:\/\//.test(url)) throw new Error("--url http(s)://... is required (or APP_URL)");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--minutes must be a positive number");
  if (!Number.isFinite(rps) || rps <= 0) throw new Error("--rps must be a positive number");
  if (rps > MAX_RPS) console.error(`--rps capped at ${MAX_RPS}`);
  return { url, minutes: Math.min(minutes, MAX_MINUTES), rps: clampRps(rps), dryRun: argv.includes("--dry-run") };
}

export async function main(argv = process.argv.slice(2), log = (l: string) => console.log(l)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    log(formatPlan(args.url, planMix(args.minutes, args.rps)));
    return;
  }
  const stats = await runTraffic({ url: args.url, minutes: args.minutes, rps: args.rps, log });
  log(stats.summary());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    // Only our own argument errors carry a message worth printing; never print fetch errors.
    console.error(e instanceof Error && e.message.startsWith("--") ? e.message : "traffic generator failed");
    process.exitCode = 1;
  });
}
