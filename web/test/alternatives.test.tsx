import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AlternativesResponse, Talk } from "@cc/shared";
import { Alternatives } from "../src/components/Alternatives.js";
import { AlternativesError, fetchAlternatives } from "../src/alternativesApi.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mk = (id: string, room: string, tags: string[] = []): Talk => ({
  id, title: `Talk ${id}`, speaker: "S", abstract: "A", track: "Security", room,
  start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags,
});
const source = mk("src", "Hall A");
const response = (alts: AlternativesResponse["alternatives"]): AlternativesResponse =>
  ({ talkId: "src", window: { start: source.start, end: source.end }, alternatives: alts });

it("loads on demand and lists alternatives with room, time and why", async () => {
  const load = vi.fn().mockResolvedValue(response([
    { talk: mk("a", "Hall B"), score: 2, sharedTags: ["security", "k8s"] },
    { talk: mk("b", "Hall C"), score: 1, sharedTags: [] },
  ]));
  render(<Alternatives talk={source} load={load} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Room full? Similar talks now for Talk src" }));
  const list = await screen.findByRole("list");
  expect(load).toHaveBeenCalledWith("src");
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain("Talk a");
  expect(items[0]!.textContent).toContain("Hall B");
  expect(items[0]!.textContent).toContain("Why: shares security, k8s");
  expect(items[1]!.textContent).toContain("Why: similar topic");
});

it("says so when nothing else is running", async () => {
  render(<Alternatives talk={source} load={vi.fn().mockResolvedValue(response([]))} />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText(/No other sessions are running at this time/)).toBeTruthy();
});

it("shows a warming-up note for 503 and an alert for other failures", async () => {
  render(<Alternatives talk={source} load={vi.fn().mockRejectedValue(new AlternativesError(503))} />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText(/warming up/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();
  render(<Alternatives talk={source} load={vi.fn().mockRejectedValue(new AlternativesError(502))} />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toBeTruthy();
});

it("button is disabled while loading and exposes expanded state", async () => {
  let resolve!: (v: AlternativesResponse) => void;
  const load = vi.fn().mockReturnValue(new Promise<AlternativesResponse>((r) => { resolve = r; }));
  render(<Alternatives talk={source} load={load} />);
  const button = screen.getByRole("button");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  const loading = await screen.findByRole("button", { name: "Finding similar talks… for Talk src" });
  expect((loading as HTMLButtonElement).disabled).toBe(true);
  expect(loading.getAttribute("aria-expanded")).toBe("true");
  resolve(response([]));
  expect(await screen.findByText(/No other sessions/)).toBeTruthy();
});

it("client calls the public endpoint with an encoded id and size, and throws the status on failure", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => response([]) })
    .mockResolvedValueOnce({ ok: false, status: 503 });
  vi.stubGlobal("fetch", fetchMock);
  await fetchAlternatives("a b/c", 2);
  expect(fetchMock).toHaveBeenCalledWith("/api/talks/a%20b%2Fc/alternatives?size=2");
  await expect(fetchAlternatives("x")).rejects.toMatchObject({ status: 503 });
});

it("gives each button a distinct accessible name that includes the talk title", () => {
  render(<><Alternatives talk={mk("a", "Hall A")} load={vi.fn()} /><Alternatives talk={mk("b", "Hall B")} load={vi.fn()} /></>);
  const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual(["Room full? Similar talks now for Talk a", "Room full? Similar talks now for Talk b"]);
});
