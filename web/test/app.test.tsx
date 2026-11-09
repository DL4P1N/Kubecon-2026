import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App.js";

afterEach(cleanup);

describe("web routes", () => {
  it.each([
    ["/register", "Register"],
    ["/onboarding", "Onboarding"],
    ["/search", "Search talks"],
    ["/kiosk", "Room check-in"],
  ])("renders %s", (path, heading) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });
});
