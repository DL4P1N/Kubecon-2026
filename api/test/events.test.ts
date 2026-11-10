import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RegisteredEvent } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { EventHub, MAX_EVENT_LISTENERS, MAX_EVENT_LISTENERS_PER_IP, buildRegisteredEvent, sanitizeLabel } from "../src/chat/events.js";
import { fakeEs } from "./helpers.js";

describe("sanitizeLabel / buildRegisteredEvent", () => {
  it("first token only, A-Z a-z 0-9 only, at most 12 characters, Guest when nothing is left", () => {
    for (const [input, want] of [["Ada Lovelace", "Ada"], ["  Grace   Hopper ", "Grace"], ["O'Brien", "OBrien"], ["Zoë", "Zo"], ["Jean-Luc Picard", "JeanLuc"],
      ["Bartholomew-Alexander", "BartholomewA"], ["Supercalifragilistic", "Supercalifra"], ["a\nb", "a"]] as const) {
      expect(sanitizeLabel(input), input).toBe(want);
    }
    for (const empty of ["", "   ", "🙂 Bob", "!!!", "-", null, undefined, 5, "‮​"]) expect(sanitizeLabel(empty)).toBe("Guest");
    expect(sanitizeLabel("x".repeat(500))).toBe("x".repeat(12));
  });

  it("the event carries exactly label, conference, returning and an interest COUNT; the label is Guest unless names are switched on", () => {
    const p = { name: "Ada Lovelace", interests: ["a1", "b2", "c3"], token: "SECRET", email: "a@b.c" } as never;
    expect(buildRegisteredEvent(p, "my-conf", true)).toEqual({ label: "Guest", conference: "my-conf", returning: true, interests: 3 });
    const e = buildRegisteredEvent(p, "my-conf", true, true);
    expect(e).toEqual({ label: "Ada", conference: "my-conf", returning: true, interests: 3 });
    expect(Object.keys(e)).toEqual(["label", "conference", "returning", "interests"]);
    expect(buildRegisteredEvent({ name: "X" }, "c", "yes").returning).toBe(false);
  });
});

const body = (extra: Record<string, unknown> = {}) => ({
  name: "Ada Lovelace-Byron", email: "ada@example.com", interests: ["Kubernetes", "search", "tracing"],
  consent: { clusterMap: true, qrCheckin: true }, ...extra,
});

function setup(opts: { heartbeatMs?: number; failWrites?: boolean; showNames?: boolean; maxPerIp?: number } = {}) {
  const es = fakeEs((call) => {
    if (opts.failWrites && call.method === "PUT") return { status: 500, body: { error: "boom" } };
    if (call.method === "PUT") return { status: 201, body: { result: "created" } };
    return undefined;
  });
  const hub = new EventHub(opts.heartbeatMs, MAX_EVENT_LISTENERS, opts.maxPerIp);
  const app = buildServer(loadConfig({ NODE_ENV: "test", ...(opts.showNames ? { EVENTS_SHOW_NAMES: "on" } : {}) } as NodeJS.ProcessEnv), { es, events: hub, runClaude: null });
  return { app, hub };
}

interface Listener { status: number; headers: http.IncomingHttpHeaders; text: () => string; close: () => Promise<void>; waitFor: (re: RegExp) => Promise<void> }
function listen(app: FastifyInstance): Promise<Listener> {
  const port = (app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      resolve({
        status: res.statusCode!, headers: res.headers, text: () => text,
        close: () => new Promise((r) => { if (res.destroyed || res.complete) { req.destroy(); r(); return; } res.on("close", () => r()); req.destroy(); setTimeout(r, 300); }),
        waitFor: async (re) => {
          const t0 = Date.now();
          while (!re.test(text)) {
            if (Date.now() - t0 > 2000) throw new Error(`timeout waiting for ${re}, got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 10));
          }
        },
      });
    });
    req.on("error", reject);
  });
}
const frames = (text: string) => text.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => {
  const [ev, data] = f.split("\n");
  return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) as RegisteredEvent };
});

describe("GET /api/events", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("by default the stream carries no name at all: the label is Guest", async () => {
    const s = setup();
    app = s.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const l = await listen(app);
    await app.inject({ method: "POST", url: "/api/register", payload: body({ name: "Zaphod Beeblebrox" }) });
    await l.waitFor(/event: registered/);
    expect(l.text()).not.toMatch(/Zaphod|Beeblebrox/);
    expect(frames(l.text())[0]!.data.label).toBe("Guest");
    await l.close();
  });

  it("with EVENTS_SHOW_NAMES=on it streams a registered event per registration, first name only, with only the allowed keys", async () => {
    const s = setup({ showNames: true });
    app = s.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const l = await listen(app);
    expect(l.status).toBe(200);
    expect(l.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(l.headers["cache-control"]).toBe("no-cache, no-transform");
    await l.waitFor(/: connected/);

    const res = await app.inject({ method: "POST", url: "/api/register", payload: body({ conference: "cloud-native-hackathon-slc-2026", returning: true }) });
    expect(res.statusCode).toBe(201);
    await l.waitFor(/event: registered/);
    const { token, attendeeId } = res.json<{ token: string; attendeeId: string }>();
    const text = l.text();
    for (const secret of ["Lovelace", "Byron", "ada@example", "ubernetes", "search", "tracing", token, attendeeId]) expect(text).not.toContain(secret);
    expect(frames(text)).toEqual([{ event: "registered", data: { label: "Ada", conference: "cloud-native-hackathon-slc-2026", returning: true, interests: 3 } }]);

    // without the optional fields: returning false, conference "unknown"
    await app.inject({ method: "POST", url: "/api/register", payload: body() });
    await l.waitFor(/"returning":false/);
    expect(frames(l.text())[1]!.data).toEqual({ label: "Ada", conference: "unknown", returning: false, interests: 3 });
    await l.close();
  });

  it("a rejected or failed registration broadcasts nothing", async () => {
    const s = setup();
    app = s.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const l = await listen(app);
    await app.inject({ method: "POST", url: "/api/register", payload: body({ name: "" }) });
    await app.inject({ method: "POST", url: "/api/register", payload: body({ conference: "Bad Slug!" }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames(l.text())).toEqual([]);
    await l.close();
    await app.close();

    const f = setup({ failWrites: true });
    app = f.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const l2 = await listen(app);
    expect((await app.inject({ method: "POST", url: "/api/register", payload: body() })).statusCode).toBe(503);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames(l2.text())).toEqual([]);
    await l2.close();
  });

  it("sends a heartbeat comment so idle connections stay open", async () => {
    app = setup({ heartbeatMs: 40 }).app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const l = await listen(app);
    await l.waitFor(/: heartbeat\n\n[\s\S]*: heartbeat\n\n/);
    await l.close();
  });

  it(`allows at most ${MAX_EVENT_LISTENERS} listeners, and closing one frees a slot`, async () => {
    const s = setup({ maxPerIp: 100 });
    app = s.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const open: Listener[] = [];
    for (let i = 0; i < MAX_EVENT_LISTENERS; i++) open.push(await listen(app));
    expect(open.every((l) => l.status === 200)).toBe(true);
    expect(s.hub.size).toBe(MAX_EVENT_LISTENERS);
    const extra = await listen(app);
    expect(extra.status).toBe(503);
    await extra.close();
    await open[0]!.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.hub.size).toBe(MAX_EVENT_LISTENERS - 1);
    const again = await listen(app);
    expect(again.status).toBe(200);
    for (const l of [...open.slice(1), again]) await l.close();
  });

  it(`allows at most ${MAX_EVENT_LISTENERS_PER_IP} concurrent streams per IP, then answers the shared 429 shape`, async () => {
    const s = setup();
    app = s.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const open: Listener[] = [];
    for (let i = 0; i < MAX_EVENT_LISTENERS_PER_IP; i++) open.push(await listen(app));
    expect(open.every((l) => l.status === 200)).toBe(true);
    const extra = await listen(app);
    expect(extra.status).toBe(429);
    expect(JSON.parse(extra.text())).toMatchObject({ statusCode: 429, error: "rate_limited" });
    await extra.close();
    await open[0]!.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await listen(app);
    expect(again.status).toBe(200);
    for (const l of [...open.slice(1), again]) await l.close();
  });

  it("HEAD does not open a stream, and the route is rate limited like the others", async () => {
    const es = fakeEs(() => undefined);
    const hub = new EventHub();
    app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { es, events: hub, runClaude: null, rateLimits: { events: { max: 2 } } });
    const head = await app.inject({ method: "HEAD", url: "/api/events" });
    expect(head.statusCode).toBe(200);
    expect(hub.size).toBe(0);
    await app.inject({ method: "HEAD", url: "/api/events" });
    const limited = await app.inject({ method: "HEAD", url: "/api/events" });
    expect(limited.statusCode).toBe(429);
  });
});
