import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App } from "../src/App.js";
import { Onboarding } from "../src/pages/Onboarding.js";
import { Register } from "../src/pages/Register.js";
import { api, ApiError, getToken, setToken } from "../src/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
beforeEach(() => { vi.spyOn(api, "catalogTopics").mockResolvedValue({ topics: ["kubernetes"] }); });
const talk = { id: "talk-1", title: "Secure Kubernetes", speaker: "Speaker", abstract: "", track: "Security",
  room: "A", start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: ["kubernetes"] };
// /register is now the static site (/site/register.html), so the legacy React form is exercised directly,
// followed by the real onboarding route it hands off to.
const renderRegisterForm = () => render(<MemoryRouter initialEntries={["/register"]}><Routes>
  <Route path="/register" element={<Register />} /><Route path="/onboarding" element={<Onboarding />} />
</Routes></MemoryRouter>);
describe("attendee journey", () => {
  it("explains the required topic selection before sending registration", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [{ talk, score: 1 }] });
    const register = vi.spyOn(api, "register");
    renderRegisterForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });
  it.each([false, true])("sends consent only after explicit selection: %s", async (optIn) => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [{ talk, score: 1 }] });
    const register = vi.spyOn(api, "register").mockResolvedValue({ attendeeId: "fake", token: "signed", expiresAt: "" });
    renderRegisterForm();
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
  it("sends and then clears a sign-in identity claim", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [] });
    const register = vi.spyOn(api, "register").mockResolvedValue({ attendeeId: "fake", token: "signed", expiresAt: "" });
    sessionStorage.setItem("cc.identity-claim", JSON.stringify({ token: "claim.jwt", expiresAt: "2030-01-01T00:00:00Z" }));
    renderRegisterForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo" } });
    fireEvent.click(await screen.findByLabelText("kubernetes"));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await screen.findByRole("heading", { name: "Onboarding" });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ identityClaim: "claim.jwt" }));
    expect(sessionStorage.getItem("cc.identity-claim")).toBeNull();
  });
  it("explains a duplicate profile and an expired claim without ending in a generic failure", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ q: "", mode: "keyword", tookMs: 1, hits: [] });
    sessionStorage.setItem("cc.identity-claim", JSON.stringify({ token: "claim.jwt", expiresAt: "2030-01-01T00:00:00Z" }));
    const register = vi.spyOn(api, "register").mockRejectedValueOnce(new ApiError("POST /api/register failed: 409", 409, "already_registered"));
    renderRegisterForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo" } });
    fireEvent.click(await screen.findByLabelText("kubernetes"));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a profile/i);
    expect(sessionStorage.getItem("cc.identity-claim")).toBeNull();

    register.mockRejectedValueOnce(new ApiError("POST /api/register failed: 400", 400, "invalid_identity_claim"));
    sessionStorage.setItem("cc.identity-claim", JSON.stringify({ token: "stale.jwt", expiresAt: "2030-01-01T00:00:00Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign-in expired/i);
    expect(sessionStorage.getItem("cc.identity-claim")).toBeNull();
  });
  it("sends ranked matches for the server to de-overlap and shows what it skipped", async () => {
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
