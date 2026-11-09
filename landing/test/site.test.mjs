import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSite, apiUrl, describeStatus, getLiveAggregates, getConfig, resetConfigCache, getStatus, signUp, completeSignup, storeToken, selectTalks,
  toRegisterRequest, toOnboardingAnswers, fetchAccessToken, applyAppLinks, TOKEN_KEY, DEFAULT_EXPERIENCE,
} from "../js/companion-api.js";
import { registrationUrl } from "../js/qr.js";
import { validProfile } from "./helpers.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** Runs fn as if the page were served under /site/ on the app's origin, with a fake fetch and sessionStorage. */
async function onSite(handler, fn) {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, sessionStorage: globalThis.sessionStorage };
  const calls = [];
  globalThis.location = { pathname: "/site/register.html", origin: "http://app.test:5173", search: "" };
  Object.defineProperty(globalThis, "sessionStorage", { value: memoryStorage(), configurable: true, writable: true });
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  resetConfigCache();
  try { return await fn(calls); } finally {
    globalThis.fetch = saved.fetch;
    globalThis.location = saved.location;
    Object.defineProperty(globalThis, "sessionStorage", { value: saved.sessionStorage, configurable: true, writable: true });
    if (saved.location === undefined) delete globalThis.location;
    resetConfigCache();
  }
}

const talks = [
  { talk: { id: "a", start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:00:00Z" }, score: 1 },
  { talk: { id: "b", start: "2026-11-10T09:30:00Z", end: "2026-11-10T10:30:00Z" }, score: 3 },
  { talk: { id: "bad", start: "nope", end: "2026-11-10T10:30:00Z" }, score: 9 },
  { talk: { id: "rev", start: "2026-11-10T11:00:00Z", end: "2026-11-10T10:00:00Z" }, score: 8 },
];

function realApi(over = {}) {
  return (c) => {
    const key = `${c.method} ${c.url.split("?")[0]}`;
    if (over[key]) return over[key](c);
    switch (key) {
      case "POST /api/register": return json({ attendeeId: "att-1", token: "attendee.jwt", expiresAt: "2030-01-01T00:00:00Z" }, 201);
      case "POST /api/onboarding": return json({ query: { text: "kubernetes search", topics: ["kubernetes"], mode: "hybrid" } });
      case "GET /api/search": return json({ hits: talks });
      case "POST /api/schedule": return json({ items: [], updatedAt: "2030-01-01T00:00:00Z" });
      case "POST /api/access/token": return json({ token: "access.jwt", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      default: return new Response("{}", { status: 404 });
    }
  };
}

test("isSite / apiUrl is always the absolute same-origin /api/...", () => {
  assert.equal(isSite("/site/register.html"), true);
  assert.equal(isSite("/site"), true);
  assert.equal(isSite("/register.html"), false);
  assert.equal(isSite("/sitemap.html"), false);
  assert.equal(apiUrl("chat"), "/api/chat");
  assert.equal(apiUrl("events"), "/api/events");
});

test("on the site, config is derived in the browser (no /api/config), appBase is the origin root", async () => {
  await onSite(realApi(), async (calls) => {
    assert.deepEqual(await getConfig(), { events: true, appBase: "", apiBase: "", publicUrl: "http://app.test:5173", chat: "auto" });
    assert.equal(calls.length, 0);
    assert.equal(apiUrl("status"), "/api/status");
    {
      const a = { dataset: { appLink: "/schedule" }, href: "" };
      await applyAppLinks({ querySelectorAll: () => [a] });
      assert.equal(a.href, "/schedule");
    }
  });
});

test("getStatus reads the real /api/status on the site", async () => {
  await onSite((c) => (c.url === "/api/status" ? json({ status: "ok" }) : new Response("", { status: 404 })), async () => {
    assert.equal((await getStatus()).status, "ok");
  });
});

test("registration URL on the site is origin + /site/register.html?c=..&via=qr", () => {
  assert.equal(registrationUrl({ origin: "http://app.test:5173", slug: "c-1", pagePath: "/site/register.html" }), "http://app.test:5173/site/register.html?c=c-1&via=qr");
});

test("toRegisterRequest: the real contract, both consents true, no email", () => {
  const body = toRegisterRequest(validProfile(), { slug: "cn-2026" });
  assert.deepEqual(body, { name: "Ada", email: "", interests: validProfile().interests, consent: { clusterMap: true, qrCheckin: true }, conference: "cn-2026" });
  assert.deepEqual(Object.keys(body).sort(), ["conference", "consent", "email", "interests", "name"]);
});

test("toOnboardingAnswers maps the chat answers onto OnboardingAnswers", () => {
  const a = toOnboardingAnswers({ ...validProfile(), goal: "learn", formats: "workshops", role: "engineer" });
  assert.deepEqual(a, { topics: validProfile().interests, experience: DEFAULT_EXPERIENCE, goals: ["learn"], freeText: "engineer; formats: workshops" });
  assert.deepEqual(toOnboardingAnswers({ ...validProfile(), goal: "", formats: "" }).goals, []);
  assert.ok(["beginner", "intermediate", "advanced"].includes(a.experience));
});

test("selectTalks matches the Onboarding page: best score first, invalid times dropped, overlaps kept", () => {
  assert.deepEqual(selectTalks(talks), ["b", "a"]);
});

test("signUp: register -> app token in sessionStorage 'cc.token' -> onboarding -> search -> schedule -> check-in token for the QR", async () => {
  await onSite(realApi(), async (calls) => {
    const t = await signUp({ slug: "cn-2026", name: "CN" }, validProfile(), { returning: true });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`), [
      "POST /api/register", "POST /api/onboarding", "GET /api/search", "POST /api/schedule", "POST /api/access/token",
    ]);
    assert.equal(sessionStorage.getItem(TOKEN_KEY), "attendee.jwt");
    assert.equal(calls[0].body.returning, true);
    assert.deepEqual(calls[0].body.consent, { clusterMap: true, qrCheckin: true });
    assert.equal(calls[0].headers.authorization, undefined); // register is unauthenticated
    for (const c of calls.slice(1)) assert.equal(c.headers.authorization, "Bearer attendee.jwt");
    assert.deepEqual(calls[3].body, { talkIds: ["b", "a"] });
    assert.match(calls[2].url, /^\/api\/search\?q=kubernetes\+search&mode=hybrid$/);
    assert.equal(t.source, "api");
    assert.equal(t.token, "access.jwt", "the QR encodes the check-in token, not the session token");
    assert.equal(t.expiresAt, "2030-01-01T00:00:00Z");
    assert.equal(t.scheduleSaved, true);
  });
});

test("signUp: storeToken resets the offline session when the token changes, like the React app", async () => {
  await onSite(realApi(), async () => {
    sessionStorage.setItem("cc.offline-session", "old");
    storeToken("t1");
    assert.equal(sessionStorage.getItem("cc.offline-session"), null);
    sessionStorage.setItem("cc.offline-session", "keep");
    storeToken("t1");
    assert.equal(sessionStorage.getItem("cc.offline-session"), "keep");
  });
});

test("signUp: a failing schedule or check-in token still leaves a registered ticket", async () => {
  await onSite(realApi({ "POST /api/onboarding": () => new Response("{}", { status: 500 }), "POST /api/access/token": () => new Response("{}", { status: 401 }) }), async () => {
    const t = await signUp({ slug: "c" }, validProfile());
    assert.equal(t.source, "api");
    assert.equal(t.token, null);
    assert.equal(t.scheduleSaved, false);
    assert.equal(sessionStorage.getItem(TOKEN_KEY), "attendee.jwt");
  });
});

test("signUp: when registration fails the ticket is a local Demo ticket and no app token is stored", async () => {
  for (const handler of [realApi({ "POST /api/register": () => new Response("{}", { status: 503 }) }), () => { throw new TypeError("network"); }, realApi({ "POST /api/register": () => json({ nope: 1 }, 201) })]) {
    await onSite(handler, async () => {
      const t = await completeSignup({ slug: "c" }, validProfile());
      assert.equal(t.source, "local");
      assert.match(t.token, /^demo\./);
      assert.equal(sessionStorage.getItem(TOKEN_KEY), null);
    });
  }
});

test("fetchAccessToken validates the response", async () => {
  await onSite(realApi({ "POST /api/access/token": () => json({ token: "x", expiresAt: "garbage" }) }), async () => {
    await assert.rejects(fetchAccessToken("t"));
  });
});

test("getLiveAggregates: demo-aggregates shape from the real aggregate route, null when unavailable", async () => {
  const agg = { topics: [{ topic: "kubernetes", count: 12 }, { topic: "other", count: 6 }], totalOptedIn: 30, suppressedBelow: 5, generatedAt: "x" };
  await onSite((c) => (c.url === "/api/interests/aggregate" ? json(agg) : c.url === "/api/rooms/occupancy" ? json({ rooms: [{ room: "Hall A", level: "quiet" }] }) : new Response("", { status: 404 })), async () => {
    const live = await getLiveAggregates();
    assert.equal(live.attendeeCount, 30);
    assert.deepEqual(live.topicCounts, [{ tag: "kubernetes", count: 12 }, { tag: "other", count: 6 }]);
    assert.deepEqual(live.clusters[0], { id: "kubernetes", label: "kubernetes", count: 12, topTags: ["kubernetes"] });
    assert.equal(live.clusters[1].id, "other");
    assert.deepEqual(live.roomLevels, [{ room: "Hall A", level: "quiet" }]);
    assert.deepEqual(live.roomOccupancy, []);
    const demo = JSON.parse((await import("node:fs")).readFileSync(new URL("../data/demo-aggregates.json", import.meta.url), "utf8"));
    for (const k of ["attendeeCount", "clusters", "topicCounts", "roomOccupancy", "suppressedGroups"]) assert.ok(k in live && k in demo, k);
  });
  await onSite(() => json({ topics: [], totalOptedIn: 0 }), async () => assert.equal(await getLiveAggregates(), null));
  await onSite(() => { throw new Error("down"); }, async () => assert.equal(await getLiveAggregates(), null));
  assert.equal(await getLiveAggregates(), null); // not on the site
});

test("describeStatus understands the real StatusResponse (no `ok` field) and getStatus passes it through", async () => {
  const real = { status: "degraded", generatedAt: "2026-11-10T09:00:00Z", windowSeconds: 300, api: { up: true, version: "0.1.0" },
    elasticsearch: { reachable: true }, search: { keyword: { samples: 3, p95Ms: 40 }, hybrid: { samples: 0, p95Ms: null, state: "warming_up" } },
    errorRate: { requests: 10, serverErrors: 0, ratio: 0 } };
  await onSite(() => json(real), async () => {
    const st = await getStatus();
    assert.equal(describeStatus(st).label, "Search is warming up, try keyword");
    assert.equal(describeStatus({ ...real, status: "ok" }).tone, "ok");
  });
});
