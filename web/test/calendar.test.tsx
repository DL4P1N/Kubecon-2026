import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError, setToken } from "../src/api.js";
import { Schedule } from "../src/pages/Schedule.js";

const talk = { id: "talk-with-space &", title: "Calendar test talk", speaker: "Demo", abstract: "Test", track: "Security", room: "Hall A", start: "2026-11-10T16:00:00Z", end: "2026-11-10T17:00:00Z", tags: [] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("fetches a calendar with authorization, encoded talk ID, and no shared caching", async () => {
  setToken("synthetic-session");
  const blob = new Blob(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], { type: "text/calendar" });
  const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await api.calendar(talk.id)).toBe(blob);
  expect(fetchMock).toHaveBeenCalledWith("/api/schedule.ics?talkId=talk-with-space+%26", {
    cache: "no-store", headers: { accept: "text/calendar", authorization: "Bearer synthetic-session" },
  });
});

it("downloads the whole schedule or one talk without navigation or a token in the URL", async () => {
  setToken("synthetic-session");
  vi.spyOn(api, "getSchedule").mockResolvedValue({ items: [{ talk }], updatedAt: "" });
  const calendar = vi.spyOn(api, "calendar").mockResolvedValue(new Blob(["calendar"]));
  const objectUrl = vi.fn(() => "blob:synthetic-calendar");
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL {
    static createObjectURL = objectUrl;
    static revokeObjectURL = vi.fn();
  });
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
  render(<MemoryRouter><Schedule /></MemoryRouter>);
  const all = await screen.findByRole("button", { name: "Add to calendar" });
  fireEvent.click(all);
  await waitFor(() => expect(clicks).toEqual(["conference-schedule.ics"]));
  expect(calendar).toHaveBeenCalledWith(undefined);
  fireEvent.click(screen.getByRole("button", { name: `Add ${talk.title} to calendar` }));
  await waitFor(() => expect(clicks).toEqual(["conference-schedule.ics", "conference-talk.ics"]));
  expect(calendar).toHaveBeenCalledWith(talk.id);
  expect(objectUrl).toHaveBeenCalledTimes(2);
  expect(document.querySelector('a[download]')).toBeNull();
});

it("offers registration when the calendar token expires and reports other errors accessibly", async () => {
  setToken("synthetic-session");
  vi.spyOn(api, "getSchedule").mockResolvedValue({ items: [{ talk }], updatedAt: "" });
  const calendar = vi.spyOn(api, "calendar").mockRejectedValueOnce(new Error("network"))
    .mockRejectedValueOnce(new ApiError("Calendar export failed: 401", 401));
  render(<MemoryRouter><Schedule /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Add to calendar" }));
  expect((await screen.findByRole("alert")).textContent).toContain("calendar could not be downloaded");
  fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
  expect(await screen.findByRole("link", { name: "Register now" })).toBeTruthy();
  expect(calendar).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(talk.title)).toBeNull();
});
