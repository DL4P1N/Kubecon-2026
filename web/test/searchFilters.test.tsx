import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SearchFacets, SearchMode } from "@cc/shared";
import { Search } from "../src/pages/Search.js";
import { api } from "../src/api.js";
import { readSearchState, searchFilterQuery, toFilterParams, writeSearchState } from "../src/searchFilters.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const talk = { id: "talk", title: "Secure Kubernetes", speaker: "Demo Speaker", abstract: "Supply chain security",
  track: "Security", room: "Room A", start: "2026-11-10T16:00:00Z", end: "2026-11-10T17:00:00Z", tags: [] };
const facets: SearchFacets = {
  track: [{ value: "Security", count: 4 }, { value: "Observability", count: 2 }],
  level: [{ value: "beginner", count: 3 }],
  day: [{ value: "2026-11-10", count: 6 }],
};

function mockSearch() {
  return vi.spyOn(api, "search").mockImplementation(async (q: string, mode: SearchMode) => ({
    q, mode, tookMs: 1, hits: [{ talk, score: 1 }], facets,
  }));
}

describe("Search filter chips", () => {
  it("shows facet counts as toggle buttons and re-runs the search with the chosen filters", async () => {
    const search = mockSearch();
    render(<Search />);
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: "supply chain" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Comparison ready.");

    const tracks = screen.getByRole("group", { name: "Track" });
    const security = within(tracks).getByRole("button", { name: "Security (4)" });
    expect(security.getAttribute("aria-pressed")).toBe("false");
    expect(within(screen.getByRole("group", { name: "Day" })).getByRole("button", { name: /Tue, Nov 10 \(6\)/ })).toBeTruthy();

    fireEvent.click(security);
    await screen.findByText("Comparison ready.");
    expect(search).toHaveBeenLastCalledWith("supply chain", "hybrid", false, { track: ["Security"] });
    expect(within(screen.getByRole("group", { name: "Track" })).getByRole("button", { name: "Security (4)" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toBe("?q=supply+chain&track=Security");

    fireEvent.click(within(screen.getByRole("group", { name: "Day" })).getByRole("button", { name: /Nov 10/ }));
    await screen.findByText("Comparison ready.");
    fireEvent.click(within(screen.getByRole("group", { name: "Time slot" })).getByRole("button", { name: /Morning/ }));
    await screen.findByText("Comparison ready.");
    expect(search).toHaveBeenLastCalledWith("supply chain", "hybrid", false, {
      day: "2026-11-10",
      from: "2026-11-10T08:00:00-07:00",
      to: "2026-11-10T12:00:00-07:00",
      track: ["Security"],
    });
    expect(window.location.search).toBe("?q=supply+chain&day=2026-11-10&slot=morning&track=Security");
  });

  it("restores the query and filters from the URL and runs the search on load", async () => {
    window.history.replaceState(null, "", "/search?q=gitops&level=beginner&track=Security&level=bogus");
    const search = mockSearch();
    render(<Search />);
    await screen.findByText("Comparison ready.");
    expect((screen.getByLabelText("Query") as HTMLInputElement).value).toBe("gitops");
    expect(search).toHaveBeenCalledWith("gitops", "keyword", false, { level: ["beginner"], track: ["Security"] });
    const level = within(screen.getByRole("group", { name: "Level" })).getByRole("button", { name: "Beginner (3)" });
    expect(level.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(window.location.search).toBe("?q=gitops"));
  });
});

describe("search filter state", () => {
  it("round-trips through the query string and drops invalid values", () => {
    const state = readSearchState("?q=x&day=2026-11-10&slot=evening&level=advanced&track=A&track=A&slot=nope");
    expect(state).toEqual({ q: "x", day: "2026-11-10", slot: "evening", level: ["advanced"], track: ["A"] });
    expect(readSearchState(`?${writeSearchState(state)}`)).toEqual(state);
    expect(readSearchState("?day=soon&slot=morning")).toEqual({ q: "", level: [], track: [] });
  });

  it("sends repeated params for multi-value filters", () => {
    const params = toFilterParams({ q: "x", level: ["beginner", "advanced"], track: ["A", "B"] });
    expect(searchFilterQuery(params)).toEqual({ level: ["beginner", "advanced"], track: ["A", "B"] });
  });
});
