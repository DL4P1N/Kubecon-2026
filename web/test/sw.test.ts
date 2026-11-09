// Runs the real production web/public/sw.js against in-memory Cache Storage fakes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "http://localhost";
const SCHEDULES = "cc-schedules-v1";
const TALKS = "cc-talks-v1";
const SESSION = "11111111-1111-1111-1111-111111111111";
const DAY = 86400000;

type Listener = (event: any) => void;

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const href = (key: string | Request) => new URL(typeof key === "string" ? key : key.url, ORIGIN).href;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      keys: async () => [...store.keys()].map((url) => new Request(url)),
      match: async (key: string | Request) => store.get(href(key))?.clone(),
      put: async (key: string | Request, response: Response) => { store.set(href(key), response); },
      delete: async (key: string | Request) => store.delete(href(key)),
    };
  };
  return {
    stores,
    api: { open, has: async (name: string) => stores.has(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
  };
}

function boot(fetchImpl: (input: any) => Promise<Response> = async () => { throw new TypeError("offline"); }) {
  const { stores, api } = fakeCaches();
  const listeners: Record<string, Listener> = {};
  const self = {
    location: new URL(`${ORIGIN}/sw.js?build=test`),
    addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
    clients: { claim: vi.fn(async () => {}) },
  };
  new Function("self", "caches", "fetch", source)(self, api, fetchImpl);
  const dispatch = async (type: string, event: any = {}) => {
    const pending: Promise<unknown>[] = [];
    const full = { ...event, waitUntil: (p: Promise<unknown>) => { pending.push(p); }, respondWith: (p: Promise<unknown>) => { pending.push(p); full.responded = p; } };
    listeners[type]!(full);
    await Promise.all(pending);
    return full;
  };
  return { stores, dispatch };
}

const entry = (until: number | null, body = "{}") =>
  new Response(body, { headers: until === null ? {} : { "x-cc-offline-until": String(until) } });
const scheduleUrl = (suffix: string) => `${ORIGIN}/__offline/schedule/${suffix}`;
const talkUrl = (id: string) => `${ORIGIN}/api/talks/${id}`;
const seed = (stores: Map<string, Map<string, Response>>, name: string, url: string, response: Response) => {
  if (!stores.has(name)) stores.set(name, new Map());
  stores.get(name)!.set(url, response);
};

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000); });
afterEach(() => { vi.restoreAllMocks(); });

function seedMixed(stores: Map<string, Map<string, Response>>) {
  const now = Date.now();
  seed(stores, SCHEDULES, scheduleUrl("orphan-expired"), entry(now - 1));
  seed(stores, SCHEDULES, scheduleUrl("fresh"), entry(now + DAY));
  seed(stores, SCHEDULES, scheduleUrl("undated"), entry(null));
  seed(stores, TALKS, talkUrl("old"), entry(now - DAY));
  seed(stores, TALKS, talkUrl("new"), entry(now + 1000));
}

const remaining = (stores: Map<string, Map<string, Response>>, name: string) =>
  [...(stores.get(name)?.keys() ?? [])].map((url) => url.replace(ORIGIN, "")).sort();

const shellHtml = '<html><script src="/assets/index-abc.js"></script><link href="/assets/index-abc.css"></html>';
const shellFetch = (assetType: string) => async (input: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.endsWith("index.html")) return new Response(shellHtml, { headers: { "content-type": "text/html" } });
  return new Response(url.endsWith(".css") ? "a{}" : "x", { headers: { "content-type": assetType === "ok" ? (url.endsWith(".css") ? "text/css" : "text/javascript") : "text/html" } });
};

it("activate sweeps expired entries in both caches and keeps live ones", async () => {
  const { stores, dispatch } = boot();
  seedMixed(stores);
  await dispatch("activate");
  expect(remaining(stores, SCHEDULES)).toEqual(["/__offline/schedule/fresh"]);
  expect(remaining(stores, TALKS)).toEqual(["/api/talks/new"]);
});

it("install sweeps expired entries too", async () => {
  const { stores, dispatch } = boot(shellFetch("ok"));
  seedMixed(stores);
  await dispatch("install");
  expect(remaining(stores, SCHEDULES)).toEqual(["/__offline/schedule/fresh"]);
  expect(remaining(stores, TALKS)).toEqual(["/api/talks/new"]);
});

it("fetch events sweep opportunistically, at most once per interval", async () => {
  const { stores, dispatch } = boot();
  seedMixed(stores);
  const other = () => ({ request: new Request(`${ORIGIN}/api/other`) });
  await dispatch("fetch", other());
  expect(remaining(stores, SCHEDULES)).toEqual(["/__offline/schedule/fresh"]);
  expect(remaining(stores, TALKS)).toEqual(["/api/talks/new"]);

  // Within the interval a newly expired orphan is left alone...
  seed(stores, SCHEDULES, scheduleUrl("orphan-2"), entry(Date.now() - 1));
  vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000 + 5 * 60 * 1000);
  await dispatch("fetch", other());
  expect(remaining(stores, SCHEDULES)).toContain("/__offline/schedule/orphan-2");

  // ...and removed once the interval has passed.
  vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000 + 11 * 60 * 1000);
  await dispatch("fetch", other());
  expect(remaining(stores, SCHEDULES)).not.toContain("/__offline/schedule/orphan-2");
  // The talk entry that expired in the meantime is gone as well.
  expect(remaining(stores, TALKS)).toEqual([]);
});

it("sweep does not create caches that do not exist", async () => {
  const { stores, dispatch } = boot();
  await dispatch("activate");
  expect(stores.has(SCHEDULES)).toBe(false);
  expect(stores.has(TALKS)).toBe(false);
});

it("forget-schedule message still deletes only the named key", async () => {
  const { stores, dispatch } = boot();
  seed(stores, SCHEDULES, scheduleUrl(SESSION), entry(Date.now() + DAY));
  seed(stores, SCHEDULES, scheduleUrl("other"), entry(Date.now() + DAY));
  await dispatch("message", { data: { type: "forget-schedule", session: SESSION } });
  expect(remaining(stores, SCHEDULES)).toEqual(["/__offline/schedule/other"]);
});

it("install precaches valid assets and rejects HTML served as an asset", async () => {
  const good = boot(shellFetch("ok"));
  await good.dispatch("install");
  expect(remaining(good.stores, "cc-shell-test")).toEqual(["/assets/index-abc.css", "/assets/index-abc.js", "/index.html"]);

  const bad = boot(shellFetch("html"));
  await expect(bad.dispatch("install")).rejects.toThrow(/Invalid asset/);
  expect(remaining(bad.stores, "cc-shell-test")).not.toContain("/index.html");
});

it("install is all-or-nothing: a later invalid or failing asset leaves no shell cache", async () => {
  // The JS asset is valid and the CSS asset is the SPA fallback (text/html).
  const late = boot(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("index.html")) return new Response(shellHtml, { headers: { "content-type": "text/html" } });
    if (url.endsWith(".js")) return new Response("x", { headers: { "content-type": "text/javascript" } });
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  });
  await expect(late.dispatch("install")).rejects.toThrow(/Invalid asset/);
  expect(late.stores.has("cc-shell-test")).toBe(false);

  // A network error on the second asset behaves the same way.
  const network = boot(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("index.html")) return new Response(shellHtml, { headers: { "content-type": "text/html" } });
    if (url.endsWith(".js")) return new Response("x", { headers: { "content-type": "text/javascript" } });
    throw new TypeError("offline");
  });
  await expect(network.dispatch("install")).rejects.toThrow(/offline/);
  expect(network.stores.has("cc-shell-test")).toBe(false);
});

it("fetch does not cache HTML (SPA fallback) as a missing /assets/ file but caches real ones", async () => {
  const html = boot(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  const missing = await html.dispatch("fetch", { request: new Request(`${ORIGIN}/assets/gone-123.js`) });
  expect(await (await missing.responded).text()).toBe("<!doctype html>");
  expect(remaining(html.stores, "cc-shell-test")).toEqual([]);

  const js = boot(async () => new Response("console.log(1)", { headers: { "content-type": "text/javascript; charset=utf-8" } }));
  await js.dispatch("fetch", { request: new Request(`${ORIGIN}/assets/real-123.js`) });
  expect(remaining(js.stores, "cc-shell-test")).toEqual(["/assets/real-123.js"]);

  const mismatch = boot(async () => new Response("body", { headers: { "content-type": "text/css" } }));
  await mismatch.dispatch("fetch", { request: new Request(`${ORIGIN}/assets/wrong-123.js`) });
  expect(remaining(mismatch.stores, "cc-shell-test")).toEqual([]);
});
