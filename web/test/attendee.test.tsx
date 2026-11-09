import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.js";
import { api, getToken, setToken } from "../src/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(api, "catalogTopics").mockResolvedValue({ topics: ["kubernetes"] }); });
const talk = { id: "talk-1", title: "Secure Kubernetes", speaker: "Speaker", abstract: "", track: "Security",
  room: "A", start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: ["kubernetes"] };
describe("attendee journey", () => {
  it.each([false, true])("sends consent only after explicit selection: %s", async (optIn) => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [{ talk, score: 1 }] });
    const register = vi.spyOn(api, "register").mockResolvedValue({ attendeeId: "fake", token: "signed", expiresAt: "" });
    render(<MemoryRouter initialEntries={["/register"]}><App /></MemoryRouter>);
    const map = screen.getByLabelText(/Include my interests/);
    const qr = screen.getByLabelText(/Allow QR/);
    expect((map as HTMLInputElement).checked).toBe(false);
    expect((qr as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "demo@example.com" } });
    fireEvent.click(await screen.findByLabelText("kubernetes"));
    if (optIn) fireEvent.click(map);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await screen.findByRole("heading", { name: "Onboarding" });
    expect(register).toHaveBeenCalledWith({ name: "Demo", email: "demo@example.com", interests: ["kubernetes"],
      consent: { clusterMap: optIn, qrCheckin: false } });
    expect(getToken()).toBe("signed");
  });
  it("saves non-overlapping matches before showing the schedule", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "hybrid", tookMs: 1,
      hits: [{ talk, score: 2 }, { talk: { ...talk, id: "overlap" }, score: 1 }] });
    vi.spyOn(api, "onboarding").mockResolvedValue({ query: { text: "secure supply chain", topics: [], mode: "hybrid" } });
    const schedule = { items: [{ talk }], updatedAt: "" };
    const save = vi.spyOn(api, "saveSchedule").mockResolvedValue(schedule);
    vi.spyOn(api, "getSchedule").mockResolvedValue(schedule);
    render(<MemoryRouter initialEntries={["/onboarding"]}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("What would you like to learn, in your own words?"), { target: { value: "secure supply chain" } });
    fireEvent.click(screen.getByRole("button", { name: "Find talks" }));
    await screen.findByRole("heading", { name: "My schedule" });
    expect(save).toHaveBeenCalledWith({ talkIds: ["talk-1"] });
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
