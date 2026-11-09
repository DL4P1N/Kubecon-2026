import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

it("renders the plan, a labelled simulated source, receiver readings and a route", () => {
  renderAt("/navigate");
  expect(screen.getByRole("heading", { level: 1, name: "Find my room" })).toBeTruthy();
  expect(screen.getByText("Simulated signals")).toBeTruthy();
  expect(screen.getByText(/You are in: Lobby and registration/)).toBeTruthy();
  const list = screen.getByRole("heading", { name: "Bluetooth receivers" }).closest("div")!.parentElement!;
  expect(within(list).getAllByRole("listitem").length).toBe(6);
  expect(within(list).getByText(/Receiver B5/).textContent).toMatch(/−\d+ dBm/);
  expect(screen.getByRole("list", { name: /Steps to Main stage/ }).children.length).toBeGreaterThan(1);
  expect(screen.getByRole("img", { name: /Floor plan/ })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/wi-?fi/i);
});

it("preselects the destination from ?to= and falls back for an unknown id", () => {
  renderAt("/navigate?to=room-b");
  expect((screen.getByLabelText("Where to?") as HTMLSelectElement).value).toBe("room-b");
  cleanup();
  renderAt("/navigate?to=nowhere");
  expect((screen.getByLabelText("Where to?") as HTMLSelectElement).value).toBe("main-stage");
});

it("accepts the site's destination aliases in ?to=", () => {
  renderAt("/navigate?to=scan");
  expect((screen.getByLabelText("Where to?") as HTMLSelectElement).value).toBe("room-b");
  cleanup();
  renderAt("/navigate?to=keynote");
  expect((screen.getByLabelText("Where to?") as HTMLSelectElement).value).toBe("main-stage");
});

it("draws you and the simulated attendees as decorative pixel people, with a text line", () => {
  const saved = JSON.stringify({ skin: "d9a066", hair: "2b1b12", shirt: "ff7a59", pants: "24324a", hat: true });
  vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "cc.avatar.v1" ? saved : null) });
  renderAt("/navigate");
  expect(screen.getByText("16 other attendees shown (simulated)")).toBeTruthy();
  const svg = screen.getByRole("img", { name: /Floor plan/ });
  expect(svg.querySelectorAll(".nav-other").length).toBe(16);
  expect(svg.querySelectorAll(".nav-me").length).toBe(1);
  expect(svg.querySelector(".nav-me")!.getAttribute("shape-rendering")).toBe("crispEdges");
  expect(svg.querySelector(".nav-me rect")!.getAttribute("fill")).toBe("#ff7a59"); // the cap, in the shirt colour
  expect(svg.querySelector("g[aria-hidden='true']")).toBeTruthy();
  vi.unstubAllGlobals();
});

it("walks on Start, announces room changes and arrival, and resets", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  renderAt("/navigate?to=lounge");
  const status = () => screen.getAllByRole("status").map((s) => s.textContent).join("|");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  let seen = "";
  for (let i = 0; i < 60; i++) { act(() => { vi.advanceTimersByTime(800); }); seen += status(); }
  expect(seen).toContain("You are now in Hallway.");
  expect(seen).toContain("You have arrived at Lounge.");
  expect(screen.getByText("Walk finished")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.getByText(/You are in: Lobby and registration/)).toBeTruthy();
  // the header's status badge polls /api/status; nothing else, and nothing about position, leaves the page
  expect(fetchSpy.mock.calls.filter(([url]) => url !== "/api/status")).toEqual([]);
  vi.unstubAllGlobals();
});

it("changes the destination and announces it", () => {
  renderAt("/navigate");
  fireEvent.change(screen.getByLabelText("Where to?"), { target: { value: "room-a" } });
  expect(screen.getAllByRole("status").map((s) => s.textContent).join("|")).toContain("Destination: Breakout room A.");
  expect(screen.getByRole("list", { name: /Steps to Breakout room A/ })).toBeTruthy();
});

it("adds Navigate and Profile to the main navigation", () => {
  renderAt("/search");
  const nav = screen.getByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { name: "Navigate" }).getAttribute("href")).toBe("/navigate");
  expect(within(nav).getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/site/profile.html");
});
