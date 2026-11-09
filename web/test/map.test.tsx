import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { InterestMap, roomSize } from "../src/pages/InterestMap.js";
import { api } from "../src/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("rounds room sizes up to the nearest 25 seats", () => {
  expect([5, 25, 26, 51].map(roomSize)).toEqual([25, 25, 50, 75]);
});

it("renders a bar chart, a table with suggested room sizes and the threshold note", async () => {
  vi.spyOn(api, "aggregate").mockResolvedValue({
    topics: [{ topic: "kubernetes", count: 30 }, { topic: "other", count: 6 }],
    totalOptedIn: 33, suppressedBelow: 5, generatedAt: "2026-11-09T12:00:00Z",
  });
  render(<InterestMap />);
  const chart = await screen.findByRole("list", { name: "Attendees per topic" });
  expect(within(chart).getAllByRole("listitem")).toHaveLength(2);
  const table = screen.getByRole("table");
  const row = within(table).getByRole("row", { name: /kubernetes/ });
  expect(within(row).getByText("50 seats")).toBeTruthy();
  expect(within(table).getByText("Other (smaller groups combined)")).toBeTruthy();
  expect(screen.getByText("Groups smaller than 5 are hidden. Thresholds are untested on live data.")).toBeTruthy();
  expect(screen.getByText("33 attendees opted in.")).toBeTruthy();
});

it("shows an error when loading fails", async () => {
  vi.spyOn(api, "aggregate").mockRejectedValue(new Error("offline"));
  render(<InterestMap />);
  expect(await screen.findByRole("alert")).toBeTruthy();
});
