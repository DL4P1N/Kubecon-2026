import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Suggestion } from "@cc/shared";
import { SuggestInput } from "../src/components/SuggestInput.js";
import { fetchSuggestions } from "../src/suggestApi.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const SUGGESTIONS: Suggestion[] = [
  { kind: "title", text: "Kubernetes Security Deep Dive" },
  { kind: "speaker", text: "Ada Lovelace" },
];

function Harness({ load, onSubmit = vi.fn() }: { load: typeof fetchSuggestions; onSubmit?: () => void }) {
  const [q, setQ] = useState("");
  return <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
    <label htmlFor="q">Query</label>
    <SuggestInput id="q" value={q} onChange={setQ} load={load} />
  </form>;
}
const type = (value: string) => fireEvent.change(screen.getByLabelText("Query"), { target: { value } });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

it("debounces: one lookup after typing stops, none below two characters", async () => {
  const load = vi.fn().mockResolvedValue(SUGGESTIONS);
  render(<Harness load={load} />);
  type("k"); await settle();
  expect(load).not.toHaveBeenCalled();
  type("ku"); type("kub"); type("kube");
  await settle();
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0]![0]).toBe("kube");
});

it("shows options in a listbox with combobox semantics and announces the count", async () => {
  render(<Harness load={vi.fn().mockResolvedValue(SUGGESTIONS)} />);
  const input = screen.getByRole("combobox", { name: "Query" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
  type("kube"); await settle();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  const options = screen.getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["Kubernetes Security Deep Dive talk", "Ada Lovelace speaker"]);
  expect(screen.getByRole("status").textContent).toBe("2 suggestions available");
});

it("arrow keys move the active option, Enter picks it without submitting, then no new lookup", async () => {
  const load = vi.fn().mockResolvedValue(SUGGESTIONS);
  const onSubmit = vi.fn();
  render(<Harness load={load} onSubmit={onSubmit} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  type("kube"); await settle();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const second = screen.getAllByRole("option")[1]!;
  expect(second.getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(second.id);
  fireEvent.keyDown(input, { key: "ArrowDown" }); // wraps to the first
  expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("Ada Lovelace");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  await settle();
  expect(load).toHaveBeenCalledTimes(1); // picking did not trigger another lookup
  fireEvent.submit(input.closest("form")!);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("Enter with nothing highlighted is left to the form; Escape closes the list", async () => {
  render(<Harness load={vi.fn().mockResolvedValue(SUGGESTIONS)} />);
  const input = screen.getByRole("combobox");
  type("kube"); await settle();
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true); // not default-prevented
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

it("clicking an option picks it", async () => {
  render(<Harness load={vi.fn().mockResolvedValue(SUGGESTIONS)} />);
  type("kube"); await settle();
  fireEvent.mouseDown(screen.getAllByRole("option")[0]!);
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Kubernetes Security Deep Dive");
});

it("a failed lookup quietly closes the list (no alert), and an empty result stays closed", async () => {
  render(<Harness load={vi.fn().mockRejectedValue(new Error("boom"))} />);
  type("kube"); await settle();
  expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();
  render(<Harness load={vi.fn().mockResolvedValue([])} />);
  type("zzzz"); await settle();
  expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("false");
});

it("ignores a stale response when the user keeps typing", async () => {
  const signals: AbortSignal[] = [];
  const load = vi.fn((_q: string, signal?: AbortSignal) => { signals.push(signal!); return new Promise<Suggestion[]>(() => {}); });
  render(<Harness load={load as unknown as typeof fetchSuggestions} />);
  type("kube"); await settle();
  type("kuber");
  expect(signals[0]!.aborted).toBe(true);
});

it("client sends the query encoded and passes the abort signal", async () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ suggestions: SUGGESTIONS }), { status: 200 }));
  vi.stubGlobal("fetch", f);
  const controller = new AbortController();
  expect(await fetchSuggestions("a&b c", controller.signal)).toEqual(SUGGESTIONS);
  expect(f.mock.calls[0]![0]).toBe("/api/suggest?q=a%26b+c");
  expect(f.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  f.mockResolvedValue(new Response("{}", { status: 503 }));
  await expect(fetchSuggestions("ab")).rejects.toThrow("503");
});

it("picking a suggestion equal to the current text does not swallow the next keystroke's lookup", async () => {
  const load = vi.fn().mockResolvedValue(SUGGESTIONS);
  render(<Harness load={load} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  type("Ada Lovelace"); await settle();
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(screen.getAllByRole("option")[1]!); // "Ada Lovelace": same as what is typed
  expect(input.value).toBe("Ada Lovelace");
  type("Ada Lovelace s"); await settle();
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls[1]![0]).toBe("Ada Lovelace s");
});
