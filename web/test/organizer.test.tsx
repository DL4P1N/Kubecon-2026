import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { InterestAggregateResponse, InterestClustersResponse, RoomPlacementResponse, StatusResponse } from "@cc/shared";
import { Organizer } from "../src/pages/Organizer.js";
import { api, ApiError } from "../src/api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const aggregate: InterestAggregateResponse = {
  topics: [
    { topic: "kubernetes", count: 42 },
    { topic: "security", count: 7 },
  ],
  totalOptedIn: 60,
  suppressedBelow: 5,
} as InterestAggregateResponse;

const clusters: InterestClustersResponse = {
  runId: "run-1",
  computedAt: "2026-11-09T12:00:00Z",
  clusters: [{ id: "c1", label: "Kubernetes + Helm", size: 13, topInterests: ["kubernetes", "helm"], other: false }],
  suppressed: 4,
  minClusterSize: 5,
};

const status: StatusResponse = {
  status: "ok", generatedAt: "2026-11-09T12:00:00Z", windowSeconds: 300,
  api: { up: true, version: "0.1.0" }, elasticsearch: { reachable: true },
  search: { keyword: { samples: 4, p95Ms: 12 }, hybrid: { samples: 3, p95Ms: 240, state: "ready" } },
  errorRate: { requests: 40, serverErrors: 0, ratio: 0 },
};

const placement: RoomPlacementResponse = {
  generatedAt: "2026-11-09T12:00:00Z",
  suppressedBelow: 5,
  capacitiesConfigured: true,
  skippedTalks: 0,
  slots: [{
    start: "2026-11-10T09:00:00Z",
    end: "2026-11-10T10:00:00Z",
    talks: [
      { talkId: "k8s", title: "Scaling Kubernetes", demand: 42, demandRank: 1, currentRoom: "Small", currentCapacity: 30, capacityKnown: true, suggestedRoom: "Big", moved: true, overCapacity: true },
      { talkId: "sec", title: "Supply chain security", demand: 7, demandRank: 2, currentRoom: "Big", currentCapacity: 300, capacityKnown: true, suggestedRoom: "Small", moved: true, overCapacity: false },
      { talkId: "wasm", title: "WASM at the edge", demand: 0, demandRank: 3, currentRoom: "Mystery", currentCapacity: null, capacityKnown: false, suggestedRoom: null, moved: false, overCapacity: false },
    ],
  }],
};

function mockAll() {
  vi.spyOn(api, "roomPlacement").mockResolvedValue(placement);
  vi.spyOn(api, "aggregate").mockResolvedValue(aggregate);
  vi.spyOn(api, "status").mockResolvedValue(status);
  return vi.spyOn(api, "clusters").mockResolvedValue(clusters);
}

it("renders every section with accessible headings", async () => {
  mockAll();
  render(<Organizer />);
  expect(screen.getByRole("heading", { level: 1, name: "Organizer dashboard" })).toBeTruthy();
  for (const name of ["Topic interest", "Interest clusters", "Room placement", "Room scan activity", "Service status", "How to use this for room and speaker placement"]) {
    expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
  }
  expect(screen.getByText(/Not available yet/)).toBeTruthy();
  expect(await screen.findByText(/All systems normal/)).toBeTruthy();
});

it("shows a suggested room size per track table from interest counts", async () => {
  mockAll();
  render(<Organizer />);
  const table = await screen.findByRole("table", { name: /Suggested room size per track/ });
  const rows = within(table).getAllByRole("row");
  expect(rows[1].textContent).toContain("kubernetes");
  expect(rows[1].textContent).toContain("50 seats");
  expect(rows[2].textContent).toContain("25 seats");
});

it("shows clusters and carries over the k>=5 suppression notes", async () => {
  mockAll();
  render(<Organizer />);
  const table = await screen.findByRole("table", { name: /Latest k-means run/ });
  expect(within(table).getByRole("rowheader", { name: "Kubernetes + Helm" })).toBeTruthy();
  expect(screen.getByText(/4 opted-in attendees are not shown because their group has fewer than 5 members/)).toBeTruthy();
  expect(screen.getByText(/groups smaller than 5 are hidden/)).toBeTruthy();
  expect(screen.getByText(/fewer than 5 attendees are combined or hidden/)).toBeTruthy();
});

it("never renders attendee IDs, even if the API were to leak them", async () => {
  const leakedId = "3f2b9c1e-0000-4000-8000-000000000001";
  vi.spyOn(api, "roomPlacement").mockResolvedValue({ ...placement, attendeeIds: [leakedId] } as RoomPlacementResponse);
  vi.spyOn(api, "aggregate").mockResolvedValue({ ...aggregate, attendeeIds: [leakedId] } as InterestAggregateResponse);
  vi.spyOn(api, "status").mockResolvedValue(status);
  vi.spyOn(api, "clusters").mockResolvedValue({
    ...clusters,
    clusters: clusters.clusters.map((c) => ({ ...c, members: [leakedId] })),
  } as InterestClustersResponse);
  const { container } = render(<Organizer />);
  await screen.findByRole("table", { name: /Latest k-means run/ });
  expect(container.textContent).not.toContain(leakedId);
});

it("asks for the organizer key on 401 and sends it on retry without storing it", async () => {
  vi.spyOn(api, "aggregate").mockResolvedValue(aggregate);
  vi.spyOn(api, "status").mockResolvedValue(status);
  const placementSpy = vi.spyOn(api, "roomPlacement").mockRejectedValueOnce(new ApiError("unauthorized", 401)).mockResolvedValue(placement);
  const spy = vi.spyOn(api, "clusters").mockRejectedValueOnce(new ApiError("unauthorized", 401)).mockResolvedValue(clusters);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  render(<Organizer />);
  expect((await screen.findAllByText("An organizer key is required.")).length).toBe(2);
  fireEvent.change(screen.getByLabelText("Organizer key"), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Load organizer data" }));
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s3cret"));
  await waitFor(() => expect(placementSpy).toHaveBeenLastCalledWith("s3cret"));
  expect(await screen.findByRole("rowheader", { name: "Scaling Kubernetes" })).toBeTruthy();
  expect(await screen.findByRole("rowheader", { name: "Kubernetes + Helm" })).toBeTruthy();
  expect(setItem.mock.calls.some((call) => String(call[1]).includes("s3cret"))).toBe(false);
});

it("shows the room placement table with moved and over-capacity rows marked in text", async () => {
  mockAll();
  render(<Organizer />);
  const table = await screen.findByRole("table", { name: /Talks by time slot/ });
  expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Slot", "Talk", "Demand", "Current room", "Suggested room"]);
  const [, k8s, sec, wasm] = within(table).getAllByRole("row");
  expect(k8s.textContent).toContain("Scaling Kubernetes");
  expect(k8s.textContent).toContain("Over capacity: demand 42, 30 seats");
  expect(k8s.textContent).toMatch(/BigMove/);
  expect(sec.textContent).toMatch(/SmallMove/);
  expect(sec.textContent).not.toContain("Over capacity");
  expect(wasm.textContent).toContain("Capacity unknown");
  expect(wasm.textContent).toContain("No suggestion");
  expect(wasm.textContent).not.toContain("Move");
});

it("says when no capacities are configured instead of implying a suggestion", async () => {
  mockAll();
  vi.spyOn(api, "roomPlacement").mockResolvedValue({ ...placement, capacitiesConfigured: false });
  render(<Organizer />);
  expect(await screen.findByText(/No room capacities are configured/)).toBeTruthy();
});

it("shows an empty state and an error state for room placement", async () => {
  mockAll();
  vi.spyOn(api, "roomPlacement").mockResolvedValueOnce({ ...placement, slots: [] });
  const { unmount } = render(<Organizer />);
  expect(await screen.findByText(/No talks with a readable time/)).toBeTruthy();
  unmount();
  vi.spyOn(api, "roomPlacement").mockRejectedValue(new ApiError("boom", 502));
  render(<Organizer />);
  expect(await screen.findByText("Could not load room placement. Please try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});
