import { describe, expect, it, vi } from "vitest";
import type { AuthCallbackResponse, AuthProvidersResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createStateStore, identityId, sanitizeReturn } from "../src/auth/oauth.js";
import { fakeEs, type FakeHandler } from "./helpers.js";

const SECRET = "test-secret-value";
const ENV = {
  NODE_ENV: "test",
  IDENTITY_HASH_KEY: "identity-hash-key-long-enough-for-tests",
  GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: SECRET, GITHUB_OAUTH_REDIRECT_URI: "http://localhost:5173/auth/github/callback",
  GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  LINKEDIN_CLIENT_ID: "li-id", LINKEDIN_CLIENT_SECRET: SECRET, LINKEDIN_OAUTH_REDIRECT_URI: "http://localhost:5173/auth/linkedin/callback",
};

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake provider network: records calls, answers the token exchange then the profile call. */
function fakeFetch(profile: unknown, opts: { tokenStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return opts.tokenStatus && opts.tokenStatus >= 400 ? jsonRes({ error: "bad_verification_code" }, opts.tokenStatus) : jsonRes({ access_token: "tok-123" });
    return jsonRes(profile);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function setup(env: Record<string, string> = ENV, fetchFn?: typeof fetch, now?: () => number, esHandler: FakeHandler = () => undefined) {
  return buildServer(loadConfig(env as NodeJS.ProcessEnv), { es: fakeEs(esHandler), runClaude: null, auth: { fetch: fetchFn, now } });
}

async function start(app: ReturnType<typeof setup>, provider: string, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/auth/${provider}/start${query}` });
  const loc = res.headers.location ? new URL(String(res.headers.location)) : null;
  const state = loc?.searchParams.get("state") ?? "";
  const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0];
  if (cookie) cookies.set(state, cookie);
  return { res, loc, state, cookie };
}
// state -> the nonce cookie the start response set, so callback() behaves like the same browser.
const cookies = new Map<string, string>();
const callback = (app: ReturnType<typeof setup>, provider: string, payload: unknown, cookie?: string) =>
  app.inject({
    method: "POST",
    url: `/api/auth/${provider}/callback`,
    payload: payload as object,
    headers: { cookie: cookie ?? cookies.get((payload as { state?: string }).state ?? "") ?? "" },
  });

describe("GET /api/auth/providers", () => {
  it("lists the three providers and whether each is fully configured", async () => {
    const all = await setup().inject({ url: "/api/auth/providers" });
    expect(all.json<AuthProvidersResponse>().providers).toEqual([
      { id: "github", enabled: true }, { id: "google", enabled: true }, { id: "linkedin", enabled: true },
    ]);
    const partial = await setup({ NODE_ENV: "test", IDENTITY_HASH_KEY: ENV.IDENTITY_HASH_KEY, GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", GOOGLE_OAUTH_REDIRECT_URI: "http://localhost/cb" }).inject({ url: "/api/auth/providers" });
    expect(partial.json<AuthProvidersResponse>().providers.map((p) => p.enabled)).toEqual([false, true, false]);
    expect(JSON.stringify(all.json())).not.toContain(SECRET);
  });
});

describe("GET /api/auth/:provider/start", () => {
  it("redirects to each provider with client_id, redirect_uri, state and the right scope, and never the secret", async () => {
    const app = setup();
    const cases = [
      ["github", "github.com", "read:user", false],
      ["google", "accounts.google.com", "openid profile", true],
      ["linkedin", "www.linkedin.com", "openid profile", false],
    ] as const;
    for (const [id, host, scope, pkce] of cases) {
      const { res, loc } = await start(app, id);
      expect(res.statusCode).toBe(302);
      expect(loc!.host).toBe(host);
      expect(loc!.searchParams.get("scope")).toBe(scope);
      expect(loc!.searchParams.get("client_id")).toBeTruthy();
      expect(loc!.searchParams.get("redirect_uri")).toBe(`http://localhost:5173/auth/${id}/callback`);
      expect(loc!.searchParams.get("state")!.length).toBeGreaterThan(20);
      expect(loc!.searchParams.has("code_challenge")).toBe(pkce);
      expect(String(res.headers.location)).not.toContain(SECRET);
      expect(loc!.searchParams.get("scope")).not.toMatch(/email/);
    }
  });

  it("404s an unknown or unconfigured provider with the shared error shape", async () => {
    const app = setup({ NODE_ENV: "test", IDENTITY_HASH_KEY: ENV.IDENTITY_HASH_KEY, GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", GITHUB_OAUTH_REDIRECT_URI: "http://localhost/cb" });
    for (const p of ["myspace", "google"]) {
      const res = await app.inject({ url: `/api/auth/${p}/start` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found", message: "unknown or disabled sign-in provider" });
    }
    expect((await callback(app, "google", { code: "c", state: "s" })).statusCode).toBe(404);
  });

  it.each([
    ["//evil.example"], ["https://evil.example/x"], ["/\\evil.example"], ["javascript:alert(1)"], ["evil"], ["/a\nb"], ["/" + "a".repeat(600)],
  ])("rejects return=%s as an open redirect", async (ret) => {
    const { res } = await start(setup(), "github", `?return=${encodeURIComponent(ret)}`);
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it("sanitizeReturn accepts relative paths and defaults to the profile page", () => {
    expect(sanitizeReturn(undefined)).toBe("/site/profile.html");
    expect(sanitizeReturn("/site/profile.html?x=1#y")).toBe("/site/profile.html?x=1#y");
    expect(sanitizeReturn("//evil")).toBeNull();
    expect(sanitizeReturn("/\\evil")).toBeNull();
    expect(sanitizeReturn("https://evil.example")).toBeNull();
  });
});

describe("POST /api/auth/:provider/callback", () => {
  it("github: returns a short-lived claim for a new identity, without the subject or provider token", async () => {
    const f = fakeFetch({ id: 42, login: "ghopper", name: "Grace Hopper", avatar_url: "https://avatars.example/g.png", email: "g@example.com" });
    const app = setup(ENV, f.fn);
    const { state } = await start(app, "github", "?return=%2Fsite%2Fprofile.html%3Fx%3D1");
    const res = await callback(app, "github", { code: "the-code", state });
    expect(res.statusCode).toBe(200);
    expect(res.json<AuthCallbackResponse>()).toMatchObject({ provider: "github", displayName: "Grace Hopper", handle: "ghopper", return: "/site/profile.html?x=1", app: false, claim: { expiresAt: expect.any(String) } });
    expect(res.json<AuthCallbackResponse>().session).toBeUndefined();
    expect(res.body).not.toMatch(/tok-123|g@example/);
    expect(res.json<Record<string, unknown>>()).not.toHaveProperty("subject");
    expect(f.calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(String(f.calls[0]!.init!.body)).toContain(`client_secret=${SECRET}`);
    expect(String(f.calls[0]!.init!.body)).toContain("code=the-code");
    expect(f.calls[1]!.url).toBe("https://api.github.com/user");
    expect((f.calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("github falls back to the login when the account has no display name", async () => {
    const app = setup(ENV, fakeFetch({ id: 43, login: "octo" }).fn);
    const { state } = await start(app, "github");
    expect((await callback(app, "github", { code: "c", state })).json<AuthCallbackResponse>()).toMatchObject({ displayName: "octo", handle: "octo", claim: { token: expect.any(String) } });
  });

  it("google: sends the PKCE verifier and reads userinfo; app flag round-trips", async () => {
    const f = fakeFetch({ name: "Ada Lovelace", picture: "https://lh3.example/a.png", sub: "1" });
    const app = setup(ENV, f.fn);
    const { state, loc } = await start(app, "google", "?app=1");
    const res = await callback(app, "google", { code: "c", state });
    expect(res.json<AuthCallbackResponse>()).toMatchObject({ provider: "google", displayName: "Ada Lovelace", avatarUrl: "https://lh3.example/a.png", return: "/site/profile.html", app: true, claim: { token: expect.any(String) } });
    const body = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(f.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")!.length).toBeGreaterThan(20);
    expect(body.get("code_verifier")).not.toBe(loc!.searchParams.get("code_challenge"));
    expect(f.calls[1]!.url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  });

  it("linkedin: reads OpenID userinfo", async () => {
    const f = fakeFetch({ name: "Linus T", sub: "urn:li:123", picture: "http://insecure.example/p.png" });
    const app = setup(ENV, f.fn);
    const { state } = await start(app, "linkedin");
    const res = await callback(app, "linkedin", { code: "c", state });
    expect(res.json<AuthCallbackResponse>()).toMatchObject({ provider: "linkedin", displayName: "Linus T", return: "/site/profile.html", app: false, claim: { token: expect.any(String) } });
    expect(f.calls[0]!.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(f.calls[1]!.url).toBe("https://api.linkedin.com/v2/userinfo");
  });

  it("rejects provider profiles without a valid stable subject", async () => {
    for (const [provider, profile] of [["github", { login: "octo", name: "Octo" }], ["github", { id: 1.5, login: "octo" }], ["google", { name: "Ada" }], ["linkedin", { name: "Linus" }]] as const) {
      const app = setup(ENV, fakeFetch(profile).fn);
      const { state } = await start(app, provider);
      expect((await callback(app, provider, { code: "c", state })).statusCode).toBe(502);
    }
  });

  it("returns 503 when identity lookup storage fails", async () => {
    const app = setup(ENV, fakeFetch({ id: 123, login: "octo" }).fn, undefined, () => { throw new Error("private ES path"); });
    const { state } = await start(app, "github");
    const res = await callback(app, "github", { code: "c", state });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "storage_unavailable", message: "could not check sign-in" });
    expect(res.body).not.toContain("private ES path");
  });
  it("returns an attendee session for a live identity and deletes a stale identity before issuing a claim", async () => {
    const hash = identityId(ENV.IDENTITY_HASH_KEY, "github", "9001");
    const known = setup(ENV, fakeFetch({ id: 9001, login: "ada" }).fn, undefined, (call) => {
      if (call.method === "GET" && call.path === `/identities/_doc/${hash}`) return { status: 200, body: { found: true, _source: { attendee_id: "attendee-1" } } };
      if (call.method === "GET" && call.path.startsWith("/attendees/_doc/")) return { status: 200, body: { found: true, _source: { id: "attendee-1", display_name: "Ada", interests: ["search"], consent: { cluster_map: true, qr_checkin: false }, expires_at: "9999-12-31T23:59:59.999Z" } } };
      return undefined;
    });
    const { state } = await start(known, "github");
    const res = await callback(known, "github", { code: "c", state });
    const session = res.json<AuthCallbackResponse>().session?.token;
    expect(session).toBeTruthy();
    expect(res.json<AuthCallbackResponse>().claim).toBeUndefined();
    const me = await known.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${session}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ attendeeId: "attendee-1", name: "Ada", interests: ["search"] });

    const calls: string[] = [];
    const stale = setup(ENV, fakeFetch({ id: 9001, login: "ada" }).fn, undefined, (call) => {
      calls.push(`${call.method} ${call.path}`);
      if (call.method === "GET" && call.path === `/identities/_doc/${hash}`) return { status: 200, body: { found: true, _source: { attendee_id: "missing" } } };
      return undefined;
    });
    const staleState = (await start(stale, "github")).state;
    const staleRes = await callback(stale, "github", { code: "c", state: staleState });
    expect(staleRes.json<AuthCallbackResponse>().claim?.token).toBeTruthy();
    expect(calls).toContain(`DELETE /identities/_doc/${hash}`);
  });

  it("runs new-account claim -> registration -> cross-device session -> profile deletion -> fresh claim", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const esHandler: FakeHandler = (call) => {
      const path = call.path.split("?")[0]!;
      const docMatch = /^\/(\w+)\/(_create|_doc)\/([^/]+)$/.exec(path);
      if (call.method === "GET" && docMatch) {
        const key = `${docMatch[1]}/${decodeURIComponent(docMatch[3]!)}`;
        const source = docs.get(key);
        return source ? { status: 200, body: { found: true, _source: source } } : { status: 404, body: { found: false } };
      }
      if (call.method === "PUT" && docMatch) {
        const key = `${docMatch[1]}/${decodeURIComponent(docMatch[3]!)}`;
        if (docMatch[2] === "_create" && docs.has(key)) return { status: 409, body: { error: "version_conflict_engine_exception" } };
        docs.set(key, call.body as Record<string, unknown>);
        return { status: 201, body: { result: "created" } };
      }
      if (call.method === "DELETE" && docMatch) {
        docs.delete(`${docMatch[1]}/${decodeURIComponent(docMatch[3]!)}`);
        return { status: 200, body: { result: "deleted" } };
      }
      if (call.method === "POST" && path === "/identities/_delete_by_query") {
        const attendeeId = (call.body as { query: { term: { attendee_id: string } } }).query.term.attendee_id;
        for (const [key, source] of docs) if (key.startsWith("identities/") && source.attendee_id === attendeeId) docs.delete(key);
        return { status: 200, body: { deleted: 1 } };
      }
      return { status: 400, body: {} };
    };
    const f = fakeFetch({ id: 9002, login: "ada", name: "Ada" });
    const app = setup(ENV, f.fn, undefined, esHandler);
    const firstState = (await start(app, "github")).state;
    const first = await callback(app, "github", { code: "c", state: firstState });
    const claim = first.json<AuthCallbackResponse>().claim?.token;
    expect(claim).toBeTruthy();
    const created = await app.inject({ method: "POST", url: "/api/register", payload: { name: "Ada", interests: ["search"], identityClaim: claim, consent: { clusterMap: true, qrCheckin: false } } });
    expect(created.statusCode).toBe(201);
    const attendeeId = created.json<{ attendeeId: string }>().attendeeId;
    f.calls.length = 0;

    const secondState = (await start(app, "github")).state;
    const second = await callback(app, "github", { code: "c", state: secondState });
    const session = second.json<AuthCallbackResponse>().session?.token;
    expect(session).toBeTruthy();
    expect(second.json<AuthCallbackResponse>().claim).toBeUndefined();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${session}` } });
    expect(me.json()).toMatchObject({ attendeeId, name: "Ada", interests: ["search"] });

    await app.inject({ method: "DELETE", url: "/api/me", headers: { authorization: `Bearer ${session}` } });
    expect([...docs.keys()].some((key) => key.startsWith("identities/"))).toBe(false);
    f.calls.length = 0;
    const thirdState = (await start(app, "github")).state;
    const third = await callback(app, "github", { code: "c", state: thirdState });
    expect(third.json<AuthCallbackResponse>().claim?.token).toBeTruthy();
    await app.close();
  });

  it("consumes state: a second use is rejected, and so are a made-up state and another provider's", async () => {
    const f = fakeFetch({ id: 71, login: "x" });
    const app = setup(ENV, f.fn);
    const { state } = await start(app, "github");
    expect((await callback(app, "github", { code: "c", state })).statusCode).toBe(200);
    const again = await callback(app, "github", { code: "c", state });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "invalid_state" });
    expect((await callback(app, "github", { code: "c", state: "nope" })).statusCode).toBe(400);
    const other = await start(app, "github");
    expect((await callback(app, "google", { code: "c", state: other.state })).statusCode).toBe(400);
    expect(f.calls).toHaveLength(2);
  });

  it("rejects state after ten minutes", async () => {
    let t = 1_000;
    const app = setup(ENV, fakeFetch({ id: 72, login: "x" }).fn, () => t);
    const { state } = await start(app, "github");
    t += 10 * 60 * 1000 + 1;
    expect((await callback(app, "github", { code: "c", state })).statusCode).toBe(400);
  });

  it("validates the body without echoing it", async () => {
    const app = setup();
    for (const payload of [{}, { code: "", state: "s" }, { code: "c" }, { code: "x".repeat(3000), state: "s" }, { code: "c", state: "s".repeat(200) }]) {
      const res = await callback(app, "github", payload);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("xxxx");
    }
  });

  it("answers a fixed 502 on provider failure and does not leak provider text", async () => {
    const app = setup(ENV, fakeFetch({}, { tokenStatus: 400 }).fn);
    const { state } = await start(app, "github");
    const res = await callback(app, "github", { code: "secret-code", state });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "provider_error", message: "the sign-in provider could not be reached, try again" });
    expect(res.body).not.toMatch(/bad_verification_code|secret-code/);
    const thrown = setup(ENV, (async () => { throw new Error("socket secret-code"); }) as unknown as typeof fetch);
    const s2 = (await start(thrown, "github")).state;
    expect((await callback(thrown, "github", { code: "c", state: s2 })).json()).toMatchObject({ error: "provider_error" });
  });

  it("answers 429 in the shared shape once the limit is passed", async () => {
    const app = buildServer(loadConfig(ENV as NodeJS.ProcessEnv), { es: fakeEs(() => undefined), runClaude: null, rateLimits: { auth: { max: 2 } } });
    for (let i = 0; i < 2; i++) expect((await app.inject({ url: "/api/auth/providers" })).statusCode).toBe(200);
    const res = await app.inject({ url: "/api/auth/providers" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ statusCode: 429, error: "rate_limited" });
  });
});

describe("OAuth browser binding", () => {
  it("sets an HttpOnly SameSite=Lax nonce cookie scoped to /api/auth at start", async () => {
    const { res } = await start(setup(), "github");
    const c = String(res.headers["set-cookie"]);
    expect(c).toMatch(/^cc_oauth=[\w-]{20,}; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/);
  });

  it("rejects a callback without the cookie or with another browser's cookie, and burns the state", async () => {
    const app = setup(ENV, fakeFetch({ id: 44, login: "ghopper", name: "Grace Hopper" }).fn);
    const a = await start(app, "github");
    const b = await start(app, "github");
    expect((await callback(app, "github", { code: "c", state: a.state }, "")).json()).toMatchObject({ error: "invalid_state" });
    expect((await callback(app, "github", { code: "c", state: b.state }, a.cookie)).statusCode).toBe(400);
    expect((await callback(app, "github", { code: "c", state: a.state }, a.cookie)).statusCode).toBe(400); // already consumed
    const c = await start(app, "github");
    expect((await callback(app, "github", { code: "c", state: c.state }, `x=1; ${c.cookie}`)).statusCode).toBe(200);
  });
});

describe("state store", () => {
  it("is bounded: the oldest entries are dropped past the cap", () => {
    const s = createStateStore({ max: 3 });
    const first = s.create({ provider: "github", return: "/a", app: false }).state;
    for (let i = 0; i < 3; i++) s.create({ provider: "github", return: "/a", app: false });
    expect(s.size).toBe(3);
    expect(s.consume(first, "github")).toBeNull();
  });
});
