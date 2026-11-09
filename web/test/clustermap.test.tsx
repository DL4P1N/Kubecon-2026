import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClusterMap } from "../src/pages/ClusterMap.js";
import { api, ApiError } from "../src/api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = {
  runId: "run-1",
  computedAt: "2026-11-09T12:00:00Z",
  clusters: [
    { id: "c1", label: "Kubernetes + Helm", size: 13, topInterests: ["kubernetes", "helm"], other: false },
    { id: "other", label: "Other", size: 6, topInterests: [], other: true },
  ],
  suppressed: 4,
  minClusterSize: 5,
};

it("shows the untested-thresholds note, the clusters and the suppressed count", async () => {
  vi.spyOn(api, "clusters").mockResolvedValue(run);
  render(<ClusterMap />);
  expect(screen.getByText(/Thresholds untested on live data/)).toBeTruthy();
  expect(await screen.findByText("Kubernetes + Helm")).toBeTruthy();
  expect(screen.getByText("13 attendees")).toBeTruthy();
  expect(screen.getByText("Other")).toBeTruthy();
  expect(screen.getByText(/4 opted-in attendees are not shown/)).toBeTruthy();
});

it("says so when no run exists yet", async () => {
  vi.spyOn(api, "clusters").mockResolvedValue({ runId: null, computedAt: null, clusters: [], suppressed: 0, minClusterSize: 5 });
  render(<ClusterMap />);
  expect(await screen.findByText("No cluster run has completed yet.")).toBeTruthy();
});

it("asks for the organizer key on 401 and sends it on retry", async () => {
  const clusters = vi
    .spyOn(api, "clusters")
    .mockRejectedValueOnce(new ApiError("unauthorized", 401))
    .mockResolvedValue(run);
  render(<ClusterMap />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "An organizer key is required.");
  fireEvent.change(screen.getByLabelText("Organizer key"), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Load map" }));
  await waitFor(() => expect(clusters).toHaveBeenLastCalledWith("s3cret"));
  expect(await screen.findByText("Kubernetes + Helm")).toBeTruthy();
});
