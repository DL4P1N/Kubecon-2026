import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScheduleResponse, SkippedTalk, Talk } from "@cc/shared";
import { api, ApiError } from "../src/api.js";
import { SkippedTalks } from "../src/components/SkippedTalks.js";
import { relevantSkipped, swapTalkIds } from "../src/skippedTalks.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mk = (id: string, title: string, start: string, end: string): Talk => ({ id, title, speaker: "S", abstract: "",
  track: "T", room: "Hall A", start: `2026-11-09T${start}:00Z`, end: `2026-11-09T${end}:00Z`, tags: [] });
const keynote = mk("keynote", "Keynote", "09:00", "10:00");
const lunch = mk("lunch", "Lunch talk", "12:00", "13:00");
const ebpf = mk("ebpf", "eBPF deep dive", "09:30", "10:30");
const mesh = mk("mesh", "Mesh panel", "12:00", "12:30");
const items = [{ talk: keynote }, { talk: lunch }];
const skipped: SkippedTalk[] = [
  { talkId: "ebpf", conflictsWith: ["keynote"], talk: ebpf },
  { talkId: "mesh", conflictsWith: ["lunch"], talk: mesh },
];

describe("swapTalkIds", () => {
  it("puts the skipped talk first and the displaced talk and other skipped talks last", () => {
    expect(swapTalkIds(items, skipped, skipped[0]!)).toEqual(["ebpf", "lunch", "keynote", "mesh"]);
  });
});

describe("relevantSkipped", () => {
  it("hides entries whose conflict is no longer scheduled or that are already scheduled", () => {
    expect(relevantSkipped([{ talk: keynote }], skipped).map((s) => s.talkId)).toEqual(["ebpf"]);
    expect(relevantSkipped([{ talk: keynote }, { talk: ebpf }], skipped)).toEqual([]);
  });
});

describe("SkippedTalks", () => {
  it("lists skipped talks with their conflict and a recording note", () => {
    render(<SkippedTalks items={items} skipped={skipped} onSwapped={() => {}} />);
    expect(screen.getByRole("heading", { name: "We skipped 2 talks that overlapped" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "eBPF deep dive" })).toBeTruthy();
    expect(screen.getAllByText(/Watch the recording later/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Swap eBPF deep dive in for Keynote" })).toBeTruthy();
  });

  it("renders nothing visible when nothing was skipped", () => {
    render(<SkippedTalks items={items} skipped={[]} onSwapped={() => {}} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("swaps by re-saving the schedule and announces the result", async () => {
    const next: ScheduleResponse = { items: [{ talk: ebpf }, { talk: lunch }], updatedAt: "",
      skipped: [{ talkId: "keynote", conflictsWith: ["ebpf"], talk: keynote }, skipped[1]!] };
    const save = vi.spyOn(api, "saveSchedule").mockResolvedValue(next);
    const onSwapped = vi.fn();
    render(<SkippedTalks items={items} skipped={skipped} onSwapped={onSwapped} />);
    fireEvent.click(screen.getByRole("button", { name: "Swap eBPF deep dive in for Keynote" }));
    await waitFor(() => expect(onSwapped).toHaveBeenCalledWith(next));
    expect(save).toHaveBeenCalledWith({ talkIds: ["ebpf", "lunch", "keynote", "mesh"] });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Swapped: eBPF deep dive is now in your schedule instead of Keynote.");
  });

  it("reports a failed swap without changing the schedule", async () => {
    vi.spyOn(api, "saveSchedule").mockRejectedValue(new ApiError("POST /api/schedule failed: 502", 502));
    const onSwapped = vi.fn();
    render(<SkippedTalks items={items} skipped={skipped} onSwapped={onSwapped} />);
    fireEvent.click(screen.getByRole("button", { name: "Swap Mesh panel in for Lunch talk" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be saved/);
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it("hands an expired session back to the page", async () => {
    vi.spyOn(api, "saveSchedule").mockRejectedValue(new ApiError("POST /api/schedule failed: 401", 401));
    const onUnauthorized = vi.fn();
    render(<SkippedTalks items={items} skipped={skipped} onSwapped={() => {}} onUnauthorized={onUnauthorized} />);
    fireEvent.click(screen.getByRole("button", { name: "Swap Mesh panel in for Lunch talk" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
