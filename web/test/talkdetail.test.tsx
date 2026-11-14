import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RelatedTalksResponse, Talk } from "@cc/shared";
import { TalkDetail } from "../src/pages/TalkDetail.js";
import { App } from "../src/App.js";
import { fetchRelated, fetchTalk, talkHref, TalksError } from "../src/talksApi.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mk = (id: string, over: Partial<Talk> = {}): Talk => ({
  id, title: `Talk ${id}`, speaker: "Ada Lovelace", abstract: "Full abstract text.", track: "Security", room: "Hall A",
  start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: ["security", "k8s"], ...over,
});
const related = (items: RelatedTalksResponse["related"]): RelatedTalksResponse => ({ talkId: "src", related: items });

function renderAt(load: Parameters<typeof TalkDetail>[0]["load"], path = "/talks/src") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/talks/:id" element={<TalkDetail load={load} />} />
        <Route path="/search" element={<p>search page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it("shows speaker, abstract, track, room, time, tags and related talks with links", async () => {
  const load = {
    talk: vi.fn().mockResolvedValue({ talk: mk("src") }),
    related: vi.fn().mockResolvedValue(related([
      { talk: mk("a", { room: "Hall B" }), score: 2, sharedTags: ["security"] },
      { talk: mk("b"), score: 1, sharedTags: [] },
    ])),
  };
  renderAt(load);
  expect(await screen.findByRole("heading", { level: 1, name: "Talk src" })).toBeTruthy();
  expect(load.talk).toHaveBeenCalledWith("src");
  expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  expect(screen.getByText("Full abstract text.")).toBeTruthy();
  expect(screen.getByText("Security")).toBeTruthy(); // track
  expect(screen.getByText("Hall A")).toBeTruthy();
  const tags = within(screen.getByRole("list", { name: "Tags" })).getAllByRole("listitem");
  expect(tags.map((t) => t.textContent)).toEqual(["security", "k8s"]);
  const link = await screen.findByRole("link", { name: "Talk a" });
  expect(link.getAttribute("href")).toBe("/talks/a");
  expect(screen.getByText(/Why: shares security/)).toBeTruthy();
  expect(screen.getByText(/Why: similar topic/)).toBeTruthy();
});

it("says so when a talk does not exist", async () => {
  renderAt({ talk: vi.fn().mockRejectedValue(new TalksError(404)), related: vi.fn().mockRejectedValue(new TalksError(404)) });
  expect(await screen.findByRole("heading", { level: 1, name: "Talk not found" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Search talks" }).getAttribute("href")).toBe("/search");
});

it("shows an alert when the talk fails to load", async () => {
  renderAt({ talk: vi.fn().mockRejectedValue(new TalksError(502)), related: vi.fn().mockRejectedValue(new TalksError(502)) });
  expect(await screen.findByRole("alert")).toBeTruthy();
});

it("still shows the talk when related talks are warming up, failing, or empty", async () => {
  const talk = vi.fn().mockResolvedValue({ talk: mk("src") });
  renderAt({ talk, related: vi.fn().mockRejectedValue(new TalksError(503)) });
  expect(await screen.findByText(/warming up/)).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Talk src" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();
  renderAt({ talk, related: vi.fn().mockRejectedValue(new TalksError(502)) });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Talk src" })).toBeTruthy();
  cleanup();
  renderAt({ talk, related: vi.fn().mockResolvedValue(related([])) });
  expect(await screen.findByText("No related talks found.")).toBeTruthy();
});

it("is routed at /talks/:id in the app", async () => {
  const f = vi.fn(async (url: string) => {
    if (url.includes("/api/status")) return new Response("{}", { status: 503 });
    if (url.includes("/related")) return new Response(JSON.stringify(related([])), { status: 200 });
    return new Response(JSON.stringify({ talk: mk("x y") }), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  render(<MemoryRouter initialEntries={["/talks/x%20y"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { level: 1, name: "Talk x y" })).toBeTruthy();
  expect(f.mock.calls.map((c) => c[0])).toContain("/api/talks/x%20y");
});

it("client builds encoded URLs and maps failures to TalksError", async () => {
  const f = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", f);
  await expect(fetchTalk("a/b")).rejects.toMatchObject({ status: 503 });
  await expect(fetchRelated("a/b", 3)).rejects.toBeInstanceOf(TalksError);
  expect(f.mock.calls.map((c) => c[0])).toEqual(["/api/talks/a%2Fb", "/api/talks/a%2Fb/related?size=3"]);
  expect(talkHref("a b")).toBe("/talks/a%20b");
});

// ---- Add to my schedule
import { AddToSchedule } from "../src/components/AddToSchedule.js";
import { setToken } from "../src/api.js";

const sched = (...ids: string[]) => ({ items: ids.map((id) => ({ talk: mk(id) })), updatedAt: "2026-11-09T00:00:00Z" });
const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

it("add to schedule: appends after existing talks and confirms", async () => {
  setToken("t");
  const api = { getSchedule: vi.fn().mockResolvedValue(sched("a")), saveSchedule: vi.fn().mockResolvedValue(sched("a", "src")) };
  wrap(<AddToSchedule talkId="src" schedule={api} />);
  screen.getByRole("button", { name: "Add to my schedule" }).click();
  expect(await screen.findByText(/Added to your schedule/)).toBeTruthy();
  expect(api.saveSchedule).toHaveBeenCalledWith({ talkIds: ["a", "src"], maxTalks: 12 });
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});

it("add to schedule: already scheduled does not save; overlap and errors are reported", async () => {
  setToken("t");
  const dup = { getSchedule: vi.fn().mockResolvedValue(sched("src")), saveSchedule: vi.fn() };
  wrap(<AddToSchedule talkId="src" schedule={dup} />);
  screen.getByRole("button").click();
  expect(await screen.findByText(/already in your schedule/)).toBeTruthy();
  expect(dup.saveSchedule).not.toHaveBeenCalled();
  cleanup();
  const clash = { getSchedule: vi.fn().mockResolvedValue(sched("a")), saveSchedule: vi.fn().mockResolvedValue({ ...sched("a"), droppedTalkIds: ["src"] }) };
  wrap(<AddToSchedule talkId="src" schedule={clash} />);
  screen.getByRole("button").click();
  expect((await screen.findByRole("alert")).textContent).toMatch(/overlaps/);
  cleanup();
  const boom = { getSchedule: vi.fn().mockRejectedValue(new Error("GET /api/schedule failed: 500")), saveSchedule: vi.fn() };
  wrap(<AddToSchedule talkId="src" schedule={boom} />);
  screen.getByRole("button").click();
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not be updated/);
});

it("add to schedule: asks to register without a session or on 401", async () => {
  wrap(<AddToSchedule talkId="src" hasSession={() => false} schedule={{ getSchedule: vi.fn(), saveSchedule: vi.fn() }} />);
  expect(screen.getByRole("link", { name: "Register" }).getAttribute("href")).toBe("/site/register.html");
  cleanup();
  setToken("t");
  wrap(<AddToSchedule talkId="src" schedule={{ getSchedule: vi.fn().mockRejectedValue(new Error("failed 401")), saveSchedule: vi.fn() }} />);
  screen.getByRole("button").click();
  expect(await screen.findByRole("link", { name: "Register" })).toBeTruthy();
});
