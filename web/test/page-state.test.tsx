import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState, SessionExpiredState, isSessionExpired } from "../src/components/PageState.js";
import { InterestMap } from "../src/pages/InterestMap.js";
import { ClusterMap } from "../src/pages/ClusterMap.js";
import { Search } from "../src/pages/Search.js";
import { Kiosk } from "../src/pages/Kiosk.js";
import { api, ApiError } from "../src/api.js";

vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    async start() { throw new Error("NotAllowedError: Permission denied"); }
    async stop() {}
    clear() {}
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

it("uses status regions for loading and empty states and alert for errors", () => {
  const retry = vi.fn();
  render(<MemoryRouter>
    <LoadingState>Loading talks…</LoadingState>
    <EmptyState><p>Nothing here.</p></EmptyState>
    <ErrorState onRetry={retry}>Could not load.</ErrorState>
  </MemoryRouter>);
  const statuses = screen.getAllByRole("status");
  expect(statuses.map((s) => s.textContent)).toEqual(["Loading talks…", "Nothing here."]);
  expect(screen.getByRole("alert").textContent).toBe("Could not load.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("offers to register again when the session expired", () => {
  render(<MemoryRouter><SessionExpiredState /></MemoryRouter>);
  expect(screen.getByRole("alert").textContent).toContain("session has expired");
  expect(screen.getByRole("link", { name: "Register again" }).getAttribute("href")).toBe("/register");
  expect(isSessionExpired(new ApiError("x", 401))).toBe(true);
  expect(isSessionExpired(new ApiError("x", 500))).toBe(false);
  expect(isSessionExpired(new Error("401"))).toBe(false);
});

it("interest map: shows loading, then a friendly error with retry that reloads", async () => {
  const aggregate = vi.spyOn(api, "aggregate")
    .mockRejectedValueOnce(new Error("GET /api/interests/aggregate failed: 500"))
    .mockResolvedValue({ topics: [{ topic: "kubernetes", count: 9 }], totalOptedIn: 9, suppressedBelow: 5, generatedAt: "" });
  render(<InterestMap />);
  expect(screen.getByRole("status").textContent).toContain("Loading interest map");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("500");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("9 attendees opted in.")).toBeTruthy();
  expect(aggregate).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("interest map: explains the k>=5 threshold when nothing can be shown", async () => {
  vi.spyOn(api, "aggregate").mockResolvedValue({ topics: [], totalOptedIn: 3, suppressedBelow: 5, generatedAt: "" });
  render(<InterestMap />);
  const empty = await screen.findByText(/at least 5 opted-in attendees/);
  expect(empty.closest("[role=status]")).not.toBeNull();
});

it("cluster map: explains the minimum group size when no cluster qualifies", async () => {
  vi.spyOn(api, "clusters").mockResolvedValue({ runId: "r", computedAt: "2026-11-09T12:00:00Z", clusters: [], suppressed: 3, minClusterSize: 5 });
  render(<ClusterMap />);
  expect(await screen.findByText(/clusters smaller than 5 are never displayed/)).toBeTruthy();
});

it("cluster map: network error offers a retry that reloads", async () => {
  const clusters = vi.spyOn(api, "clusters")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ runId: "r", computedAt: "2026-11-09T12:00:00Z", clusters: [
      { id: "c1", label: "Kubernetes + Helm", size: 7, topInterests: [], other: false }], suppressed: 0, minClusterSize: 5 });
  render(<ClusterMap />);
  expect((await screen.findByRole("alert")).textContent).not.toContain("Failed to fetch");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Kubernetes + Helm")).toBeTruthy();
  expect(clusters).toHaveBeenCalledTimes(2);
});

it("search: no results suggest broader terms in a status region", async () => {
  vi.spyOn(api, "search").mockImplementation(async (q, mode) => ({ q, mode, tookMs: 1, hits: [] }));
  render(<Search />);
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: "zzzz" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Comparison ready.");
  const keyword = screen.getByRole("region", { name: "Keyword" });
  expect(within(keyword).getByRole("status").textContent).toContain("Try broader or fewer words");
});

it("search: a network error shows a retry button that searches again", async () => {
  const search = vi.spyOn(api, "search")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementation(async (q, mode) => ({ q, mode, tookMs: 1, hits: [] }));
  render(<Search />);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("Failed to fetch");
  fireEvent.click(screen.getByRole("button", { name: "Retry keyword search" }));
  await waitFor(() => expect(search).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("kiosk: camera denied falls back to the text token input", async () => {
  render(<Kiosk />);
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Type or paste the token");
  const input = screen.getByLabelText(/Token/);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(screen.getByRole("button", { name: "Scan with camera" })).toBeTruthy();
});
