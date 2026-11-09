import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Schedule } from "../src/pages/Schedule.js";
import { Kiosk } from "../src/pages/Kiosk.js";
import { api, setToken } from "../src/api.js";
import { RoomActivityBadge } from "../src/pages/RoomActivity.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const activity = { source: "in-process-scan-activity" as const, windowMinutes: 10,
  rooms: [{ room: "room-a", level: "many recent check-ins" as const }] };
it("shows accessible room activity on schedule and kiosk using aggregate data", async () => {
  vi.spyOn(api, "roomOccupancy").mockResolvedValue(activity);
  vi.spyOn(api, "getSchedule").mockResolvedValue({ updatedAt: "", items: [{ talk: {
    id: "a", title: "Talk", room: "room-a", speaker: "Demo", abstract: "", tags: [], track: "Demo",
    start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z",
  } }] });
  setToken("synthetic");
  render(<MemoryRouter><Schedule /></MemoryRouter>);
  expect(await screen.findByText("Scan activity: many recent check-ins")).toBeTruthy();
  expect(screen.queryByText(/%|capacity|almost full/)).toBeNull();
  cleanup();
  render(<Kiosk />);
  fireEvent.change(screen.getByLabelText("Room", { exact: true }), { target: { value: "room-a" } });
  expect(await screen.findByLabelText("room-a: many recent check-ins")).toBeTruthy();
});
it("does not call unavailable data quiet or expose suppressed counts", () => {
  const view = render(<RoomActivityBadge room="room-a" activity={null} />);
  expect(screen.getByText("Scan activity unavailable")).toBeTruthy();
  view.rerender(<RoomActivityBadge room="room-a" activity={{ ...activity,
    rooms: [{ room: "room-a", level: "quiet" }] }} />);
  expect(screen.getByText("Scan activity: quiet")).toBeTruthy();
  expect(screen.queryByText(/%/)).toBeNull();
});
