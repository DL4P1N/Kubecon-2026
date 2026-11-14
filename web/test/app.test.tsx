import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App, siteNavigation } from "../src/App.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <App />
  </MemoryRouter>,
);

describe("web routes", () => {
  it.each([
    ["/onboarding", "Find talks"],
    ["/search", "Search talks"],
    ["/kiosk", "Room check-in"],
  ])("renders %s", async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("groups the organizer pages under one sub-nav with the current page marked", async () => {
    renderAt("/map");
    const nav = await screen.findByRole("navigation", { name: "Organizer" });
    expect(within(nav).getByRole("link", { name: "Interest map" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
  });

  it("main navigation holds the six attendee destinations and no organizer pages", () => {
    renderAt("/search");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(
      ["Conferences", "Schedule", "Find talks", "Search", "Navigate", "Profile"]);
  });

  it("keeps the shell landmarks: skip link, main navigation, main and footer", () => {
    renderAt("/search");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });
});

describe("front door lives in the static site", () => {
  it("sends /register to /site/register.html and keeps the query string", async () => {
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/register?c=cloud-native-hackathon-slc-2026&via=github");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/register.html?c=cloud-native-hackathon-slc-2026&via=github"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "sign-up" }).getAttribute("href")).toBe("/site/register.html?c=cloud-native-hackathon-slc-2026&via=github");
  });

  it("sends a bare /register to /site/register.html", async () => {
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/register");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/register.html"));
  });

  it("sends an SPA-internal / to /site/ with a plain fallback link, not to /register", async () => {
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/site/"));
    expect(screen.getByRole("link", { name: "the Conference Companion home page" }).getAttribute("href")).toBe("/site/");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("does not redirect other routes", () => {
    const replace = vi.spyOn(siteNavigation, "replace").mockImplementation(() => {});
    renderAt("/onboarding");
    expect(replace).not.toHaveBeenCalled();
  });
});
