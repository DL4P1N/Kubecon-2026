import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.js";
import { api, getToken, setToken } from "../src/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
beforeEach(() => { localStorage.clear(); vi.spyOn(api, "catalogTopics").mockResolvedValue({ topics: ["kubernetes"] }); });
const talk = { id: "talk-1", title: "Secure Kubernetes", speaker: "Speaker", abstract: "", track: "Security",
  room: "A", start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: ["kubernetes"] };
// Registration is the static site (/site/register.html, landing tests); this covers onboarding onward.
describe("attendee journey", () => {
  it("sends ranked matches for the server to de-overlap and shows what it skipped", async () => {
    setToken("signed");
    const overlap = { ...talk, id: "overlap", title: "Overlapping talk" };
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "hybrid", tookMs: 1,
      hits: [{ talk: overlap, score: 1 }, { talk, score: 2 }] });
    vi.spyOn(api, "onboarding").mockResolvedValue({ query: { text: "secure supply chain", topics: [], mode: "hybrid" } });
    const schedule = { items: [{ talk }], updatedAt: "" };
    const save = vi.spyOn(api, "saveSchedule").mockResolvedValue({ ...schedule, droppedTalkIds: ["overlap"],
      skipped: [{ talkId: "overlap", conflictsWith: ["talk-1"], talk: overlap }] });
    vi.spyOn(api, "getSchedule").mockResolvedValue(schedule);
    render(<MemoryRouter initialEntries={["/onboarding"]}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("What would you like to learn, in your own words?"), { target: { value: "secure supply chain" } });
    fireEvent.click(screen.getByRole("button", { name: "Find talks" }));
    await screen.findByRole("heading", { name: "My schedule" });
    expect(save).toHaveBeenCalledWith({ talkIds: ["talk-1", "overlap"] });
    expect(await screen.findByRole("heading", { name: "We skipped 1 talk that overlapped" })).toBeTruthy();
  });
  it("blocks empty or whitespace-only onboarding without saving a schedule", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [] });
    const onboard = vi.spyOn(api, "onboarding");
    const save = vi.spyOn(api, "saveSchedule");
    render(<MemoryRouter initialEntries={["/onboarding"]}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("What would you like to learn, in your own words?"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Find talks" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onboard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("retains the token when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    setToken("memory-only");
    expect(getToken()).toBe("memory-only");
  });
});
