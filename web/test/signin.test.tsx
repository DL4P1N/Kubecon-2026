import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.js";
import { api, resetProvidersCache, setToken } from "../src/api.js";

beforeEach(() => resetProvidersCache());
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

const renderSchedule = () => render(<MemoryRouter initialEntries={["/schedule"]}><App /></MemoryRouter>);
const providers = (enabled: boolean) => vi.spyOn(api, "authProviders").mockResolvedValue({ providers: [{ id: "github", enabled }] });

it("header offers Sign in with GitHub that returns to the current page", async () => {
  providers(true);
  renderSchedule();
  const link = await within(screen.getByRole("banner")).findByRole("link", { name: "Sign in with GitHub" });
  expect(link.getAttribute("href")).toBe("/api/auth/github/start?return=%2Fschedule");
});

it("header hides the sign-in button when a session exists", async () => {
  const fetched = providers(true);
  vi.spyOn(api, "getSchedule").mockResolvedValue({ items: [], updatedAt: "" });
  setToken("t");
  renderSchedule();
  await waitFor(() => expect(fetched).toHaveBeenCalled());
  await screen.findByRole("heading", { level: 1, name: "My schedule" });
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});

it("header hides the sign-in button when GitHub is not enabled", async () => {
  const fetched = providers(false);
  renderSchedule();
  await waitFor(() => expect(fetched).toHaveBeenCalled());
  await Promise.resolve();
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});
