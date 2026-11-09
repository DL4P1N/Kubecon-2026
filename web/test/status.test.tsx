import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { StatusResponse } from "@cc/shared";
import { App } from "../src/App.js";
import { Search } from "../src/pages/Search.js";
import { Status } from "../src/pages/Status.js";
import { StatusBadge } from "../src/components/StatusBadge.js";
import { describeStatus } from "../src/components/status.js";
import { ApiError, api } from "../src/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const base: StatusResponse = {
  status: "ok", generatedAt: "2026-11-09T12:00:00Z", windowSeconds: 300,
  api: { up: true, version: "0.1.0" }, elasticsearch: { reachable: true },
  search: { keyword: { samples: 4, p95Ms: 12 }, hybrid: { samples: 3, p95Ms: 240, state: "ready" } },
  errorRate: { requests: 40, serverErrors: 0, ratio: 0 },
};
const warming: StatusResponse = { ...base, status: "degraded", search: { ...base.search, hybrid: { samples: 0, p95Ms: null, state: "warming_up" } } };
const talk = { id: "t1", title: "Secure Kubernetes", speaker: "Demo Speaker", abstract: "Supply chain", track: "Security", room: "Room A",
  start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: [] };

it("describes each state in words, not colour alone", () => {
  expect(describeStatus(base).label).toBe("All systems normal");
  expect(describeStatus(warming).label).toBe("Search is warming up, try keyword");
  expect(describeStatus({ ...base, status: "degraded" }).label).toMatch(/failing/);
  expect(describeStatus({ ...base, status: "down" }).label).toMatch(/unavailable/);
  expect(describeStatus(null).label).toBe("Status unavailable");
});

it("badge shows normal, then warming-up, as a link to /status", async () => {
  vi.spyOn(api, "status").mockResolvedValue(base);
  render(<MemoryRouter><StatusBadge /></MemoryRouter>);
  const link = await screen.findByRole("link", { name: /All systems normal/ });
  expect(link.getAttribute("href")).toBe("/status");
  cleanup();
  vi.spyOn(api, "status").mockResolvedValue(warming);
  render(<MemoryRouter><StatusBadge /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: /Search is warming up, try keyword/ })).toBeTruthy();
});

it("badge falls back to 'Status unavailable' when the endpoint fails", async () => {
  vi.spyOn(api, "status").mockRejectedValue(new Error("offline"));
  render(<MemoryRouter><StatusBadge /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: /Status unavailable/ })).toBeTruthy();
});

it("status page renders live values from the API", async () => {
  vi.spyOn(api, "status").mockResolvedValue(base);
  render(<MemoryRouter><Status /></MemoryRouter>);
  expect(await screen.findByRole("heading", { level: 1, name: "Service status" })).toBeTruthy();
  expect(await screen.findByText(/Reachable/)).toBeTruthy();
  expect(screen.getByText(/p95 12 ms \(4 searches\)/)).toBeTruthy();
  expect(screen.getByText(/Ready; p95 240 ms \(3 searches\)/)).toBeTruthy();
  expect(screen.getByText(/0 of 40 requests \(0.0%\)/)).toBeTruthy();
});

it("status page explains a degraded hybrid and an unreachable endpoint", async () => {
  vi.spyOn(api, "status").mockResolvedValue(warming);
  render(<MemoryRouter><Status /></MemoryRouter>);
  expect(await screen.findByText(/Warming up \(keyword search still works\); p95 no searches yet/)).toBeTruthy();
  cleanup();
  vi.spyOn(api, "status").mockRejectedValue(new Error("offline"));
  render(<MemoryRouter><Status /></MemoryRouter>);
  expect(await screen.findByText(/could not be reached/)).toBeTruthy();
});

it("app routes /status and shows the badge in the header", async () => {
  vi.spyOn(api, "status").mockResolvedValue(base);
  render(<MemoryRouter initialEntries={["/status"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { level: 1, name: "Service status" })).toBeTruthy();
  expect(within(screen.getByRole("banner")).getByRole("link", { name: /All systems normal/ })).toBeTruthy();
});

it.each([503, 502])("search falls back to keyword results without an error when hybrid returns %i", async (status) => {
  vi.spyOn(api, "search").mockImplementation(async (q, mode) => {
    if (mode === "hybrid") throw new ApiError("hybrid failed", status);
    return { q, mode, tookMs: 3, hits: [{ talk, score: 1 }], debug: { query: "keyword-debug" } };
  });
  render(<Search />);
  fireEvent.click(screen.getByLabelText("Include Elasticsearch query details"));
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: "secure supply chain" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText(/Hybrid search is warming up, so keyword results are shown here/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  const hybrid = screen.getByRole("region", { name: "Hybrid" });
  expect(within(hybrid).getByText(talk.title)).toBeTruthy();
  // The keyword query details must not be shown under the Hybrid heading.
  expect(within(hybrid).queryByText(/Elasticsearch query/)).toBeNull();
  expect(within(screen.getByRole("region", { name: "Keyword" })).getByText(/Elasticsearch query/)).toBeTruthy();
});

it("search still shows an error when keyword fails too, or hybrid fails with a non-ES error", async () => {
  vi.spyOn(api, "search").mockRejectedValue(new ApiError("down", 503));
  render(<Search />);
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect((await screen.findAllByRole("alert")).length).toBe(2);
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(api, "search").mockImplementation(async (q, mode) => {
    if (mode === "hybrid") throw new ApiError("bad", 400);
    return { q, mode, tookMs: 1, hits: [] };
  });
  render(<Search />);
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/warming up/)).toBeNull();
});
