import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { InterestAggregateResponse, InterestClustersResponse, StatusResponse } from "@cc/shared";
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

function mockAll() {
  vi.spyOn(api, "aggregate").mockResolvedValue(aggregate);
  vi.spyOn(api, "status").mockResolvedValue(status);
  return vi.spyOn(api, "clusters").mockResolvedValue(clusters);
}

it("renders every section with accessible headings", async () => {
  mockAll();
  render(<Organizer />);
  expect(screen.getByRole("heading", { level: 1, name: "Organizer dashboard" })).toBeTruthy();
  for (const name of ["Topic interest", "Interest clusters", "Room scan activity", "Service status", "How to use this for room and speaker placement"]) {
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
  const spy = vi.spyOn(api, "clusters").mockRejectedValueOnce(new ApiError("unauthorized", 401)).mockResolvedValue(clusters);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  render(<Organizer />);
  expect(await screen.findByText("An organizer key is required.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Organizer key"), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Load organizer data" }));
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s3cret"));
  expect(await screen.findByRole("rowheader", { name: "Kubernetes + Helm" })).toBeTruthy();
  expect(setItem.mock.calls.some((call) => String(call[1]).includes("s3cret"))).toBe(false);
});
