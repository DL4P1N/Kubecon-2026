import { describe, expect, it, vi } from "vitest";
import type { AuthCallbackResponse, AuthProvidersResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createStateStore, sanitizeReturn } from "../src/auth/oauth.js";
import { fakeEs } from "./helpers.js";

const SECRET = "test-secret-value";
const ENV = {
  NODE_ENV: "test",
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

function setup(env: Record<string, string> = ENV, fetchFn?: typeof fetch, now?: () => number) {
  return buildServer(loadConfig(env as NodeJS.ProcessEnv), { es: fakeEs(() => undefined), runClaude: null, auth: { fetch: fetchFn, now } });
}

async function start(app: ReturnType<typeof setup>, provider: string, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/auth/${provider}/start${query}` });
  const loc = res.headers.location ? new URL(String(res.headers.location)) : null;
  return { res, loc, state: loc?.searchParams.get("state") ?? "" };
}
const callback = (app: ReturnType<typeof setup>, provider: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/auth/${provider}/callback`, payload: payload as object });

describe("GET /api/auth/providers", () => {
  it("lists the three providers and whether each is fully configured", async () => {
    const all = await setup().inject({ url: "/api/auth/providers" });
    expect(all.json<AuthProvidersResponse>().providers).toEqual([
      { id: "github", enabled: true }, { id: "google", enabled: true }, { id: "linkedin", enabled: true },
    ]);
    const partial = await setup({ NODE_ENV: "test", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", GOOGLE_OAUTH_REDIRECT_URI: "http://localhost/cb" }).inject({ url: "/api/auth/providers" });
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
    const app = setup({ NODE_ENV: "test", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", GITHUB_OAUTH_REDIRECT_URI: "http://localhost/cb" });
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
  it("github: exchanges the code with the secret, returns the profile and no token", async () => {
    const f = fakeFetch({ login: "ghopper", name: "Grace Hopper", avatar_url: "https://avatars.example/g.png", email: "g@example.com" });
    const app = setup(ENV, f.fn);
    const { state } = await start(app, "github", "?return=%2Fsite%2Fprofile.html%3Fx%3D1");
    const res = await callback(app, "github", { code: "the-code", state });
    expect(res.statusCode).toBe(200);
    expect(res.json<AuthCallbackResponse>()).toEqual({ provider: "github", displayName: "Grace Hopper", handle: "ghopper", avatarUrl: "https://avatars.example/g.png", return: "/site/profile.html?x=1", app: false });
    expect(res.body).not.toMatch(/tok-123|g@example/);
    expect(f.calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(String(f.calls[0]!.init!.body)).toContain(`client_secret=${SECRET}`);
    expect(String(f.calls[0]!.init!.body)).toContain("code=the-code");
    expect(f.calls[1]!.url).toBe("https://api.github.com/user");
    expect((f.calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("github falls back to the login when the account has no display name", async () => {
    const app = setup(ENV, fakeFetch({ login: "octo" }).fn);
    const { state } = await start(app, "github");
    expect((await callback(app, "github", { code: "c", state })).json<AuthCallbackResponse>()).toMatchObject({ displayName: "octo", handle: "octo" });
  });

  it("google: sends the PKCE verifier and reads userinfo; app flag round-trips", async () => {
    const f = fakeFetch({ name: "Ada Lovelace", picture: "https://lh3.example/a.png", sub: "1" });
    const app = setup(ENV, f.fn);
    const { state, loc } = await start(app, "google", "?app=1");
    const res = await callback(app, "google", { code: "c", state });
    expect(res.json<AuthCallbackResponse>()).toEqual({ provider: "google", displayName: "Ada Lovelace", avatarUrl: "https://lh3.example/a.png", return: "/site/profile.html", app: true });
    const body = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(f.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")!.length).toBeGreaterThan(20);
    expect(body.get("code_verifier")).not.toBe(loc!.searchParams.get("code_challenge"));
    expect(f.calls[1]!.url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  });

  it("linkedin: reads OpenID userinfo", async () => {
    const f = fakeFetch({ name: "Linus T", picture: "http://insecure.example/p.png" });
    const app = setup(ENV, f.fn);
    const { state } = await start(app, "linkedin");
    const res = await callback(app, "linkedin", { code: "c", state });
    expect(res.json<AuthCallbackResponse>()).toEqual({ provider: "linkedin", displayName: "Linus T", return: "/site/profile.html", app: false });
    expect(f.calls[0]!.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(f.calls[1]!.url).toBe("https://api.linkedin.com/v2/userinfo");
  });

  it("consumes state: a second use is rejected, and so are a made-up state and another provider's", async () => {
    const f = fakeFetch({ login: "x" });
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
    const app = setup(ENV, fakeFetch({ login: "x" }).fn, () => t);
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

describe("state store", () => {
  it("is bounded: the oldest entries are dropped past the cap", () => {
    const s = createStateStore({ max: 3 });
    const first = s.create({ provider: "github", return: "/a", app: false }).state;
    for (let i = 0; i < 3; i++) s.create({ provider: "github", return: "/a", app: false });
    expect(s.size).toBe(3);
    expect(s.consume(first, "github")).toBeNull();
  });
});
