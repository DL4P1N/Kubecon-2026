import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { App, siteNavigation } from "../src/App.js";

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
// The site header also polls /api/status; only the callback path gets the scripted answer.
const reply = (status: number, body: unknown) => vi.fn(async (url: string) => url.includes("/api/auth/")
  ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  : new Response("{}", { status: 503 }));
const authCalls = (m: ReturnType<typeof reply>) => m.mock.calls.filter((c) => String(c[0]).includes("/api/auth/")) as unknown as [string, RequestInit][];

let sessionData: Map<string, string>;
beforeEach(() => {
  // A Map-backed stand-in: the runtime's own localStorage global is not reliable under jsdom here.
  const data = new Map<string, string>();
  sessionData = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => sessionData.get(k) ?? null,
    setItem: (k: string, v: string) => { sessionData.set(k, v); },
    removeItem: (k: string) => { sessionData.delete(k); },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("/auth/:provider/callback", () => {
  it("posts code and state, stores the linked account (merged) and goes back to the return path", async () => {
    localStorage.setItem("cc.linked.v1", JSON.stringify({ google: { displayName: "Ada", linkedAt: "2026-01-01T00:00:00.000Z" } }));
    const fetchMock = reply(200, { provider: "github", displayName: "Grace Hopper", handle: "ghopper", avatarUrl: "https://a.example/x.png", return: "/site/profile.html", app: false, session: { token: "session-token", expiresAt: "2026-11-11T20:00:00.000Z" } });
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/auth/github/callback?code=abc&state=xyz");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/profile.html"));
    const [url, init] = authCalls(fetchMock)[0]!;
    expect(url).toBe("/api/auth/github/callback");
    expect(JSON.parse(init.body as string)).toEqual({ code: "abc", state: "xyz" });
    const stored = JSON.parse(localStorage.getItem("cc.linked.v1")!);
    expect(stored.google.displayName).toBe("Ada");
    expect(stored.github).toMatchObject({ displayName: "Grace Hopper", handle: "ghopper", avatarUrl: "https://a.example/x.png" });
    expect(Number.isNaN(Date.parse(stored.github.linkedAt))).toBe(false);
  });

  it("stores a new identity claim and sends a default profile return to registration", async () => {
    vi.stubGlobal("fetch", reply(200, { provider: "github", displayName: "Grace", return: "/site/profile.html", app: false, claim: { token: "identity-claim-token", expiresAt: "2026-11-11T12:15:00.000Z" } }));
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/auth/github/callback?code=abc&state=claim");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/register.html?via=github"));
    expect(sessionStorage.getItem("cc.identity-claim")).toBe(JSON.stringify({ token: "identity-claim-token", expiresAt: "2026-11-11T12:15:00.000Z" }));
  });

  it("stores a returning attendee session token and follows the requested path", async () => {
    vi.stubGlobal("fetch", reply(200, { provider: "google", displayName: "Ada", return: "/schedule", app: false, session: { token: "attendee-session", expiresAt: "2026-11-11T20:00:00.000Z" } }));
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/auth/google/callback?code=abc&state=session");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/schedule"));
    expect(sessionStorage.getItem("cc.token")).toBe("attendee-session");
  });

  it("posts the one-time state only once under StrictMode", async () => {
    const fetchMock = reply(200, { provider: "github", displayName: "Grace", return: "/site/profile.html", app: false, session: { token: "strict-token", expiresAt: "2026-11-11T20:00:00.000Z" } });
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    render(<StrictMode><MemoryRouter initialEntries={["/auth/github/callback?code=abc&state=strict1"]}><App /></MemoryRouter></StrictMode>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/profile.html"));
    expect(authCalls(fetchMock)).toHaveLength(1);
    expect(localStorage.getItem("cc.linked.v1")).toContain("github");
  });

  it("finishes in the native app when the flow began there, and keeps a fallback link", async () => {
    vi.stubGlobal("fetch", reply(200, { provider: "google", displayName: "Ada L", return: "/site/profile.html", app: true, claim: { token: "native-claim", expiresAt: "2026-11-11T12:15:00.000Z" } }));
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/auth/google/callback?code=abc&state=xyz");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("confcompanion://linked?provider=google&name=Ada%20L"));
    expect(screen.getByRole("link", { name: "Back to your profile" }).getAttribute("href")).toBe("/site/profile.html");
  });

  it.each([
    ["the provider sent an error", "/auth/github/callback?error=access_denied&state=xyz", null],
    ["the code is missing", "/auth/github/callback?state=xyz", null],
    ["the API refuses", "/auth/github/callback?code=abc&state=xyz", 400],
  ])("shows a plain message and a way back when %s", async (_n, path, status) => {
    const fetchMock = reply(status ?? 200, { error: "invalid_state" });
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt(path);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not link/i);
    expect(screen.getByRole("link", { name: "Back to your profile" }).getAttribute("href")).toBe("/site/profile.html");
    expect(replace).not.toHaveBeenCalled();
    expect(localStorage.getItem("cc.linked.v1")).toBeNull();
    if (status === null) expect(authCalls(fetchMock)).toHaveLength(0);
  });
});
