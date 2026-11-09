import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.js";
import { estimateRoom } from "../src/navigation/estimate.js";
afterEach(cleanup);

it("chooses the closest fingerprint and rejects invalid vectors", () => {
  const samples = [{ room: "A", signals: [-40, -80] }, { room: "B", signals: [-80, -40] }];
  expect(estimateRoom([-43, -78], samples)).toBe("A");
  expect(estimateRoom([-78, -43], samples)).toBe("B");
  expect(estimateRoom([], samples)).toBeNull();
  expect(estimateRoom([NaN, 1], samples)).toBeNull();
  expect(estimateRoom([1], samples)).toBeNull();
  expect(estimateRoom([1, 2], [])).toBeNull();
});
it("hides the replay route by default", () => {
  render(<MemoryRouter initialEntries={["/nav-demo"]}><App /></MemoryRouter>);
  expect(screen.getByText("Page not found.")).toBeTruthy();
});
it("shows labelled simulation only when enabled and steps the replay", async () => {
  render(<MemoryRouter initialEntries={["/nav-demo"]}><App navEnabled /></MemoryRouter>);
  await screen.findByRole("heading", { name: "Navigation replay demo" });
  expect(screen.getByText("Simulated signal replay, not measured at the venue.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Frame 1");
  fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
  expect(screen.getByRole("status").textContent).toContain("Frame 2");
  fireEvent.click(screen.getByRole("button", { name: "Reset replay" }));
  expect(screen.getByRole("status").textContent).toContain("Frame 1");
});
