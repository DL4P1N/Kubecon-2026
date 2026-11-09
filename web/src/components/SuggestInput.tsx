import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Suggestion } from "@cc/shared";
import { fetchSuggestions } from "../suggestApi.js";

export const SUGGEST_DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  placeholder?: string;
  load?: typeof fetchSuggestions;
  debounceMs?: number;
}

/**
 * Text input with a debounced suggestions list, using the ARIA combobox
 * pattern (list autocomplete): focus stays in the input, arrow keys move the
 * highlighted option, Enter picks it, Escape closes. Suggestions are an
 * enhancement: a failed request just closes the list, it never shows an error.
 */
export function SuggestInput({ id, value, onChange, maxLength, placeholder, load = fetchSuggestions, debounceMs = SUGGEST_DEBOUNCE_MS }: Props) {
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The text of the suggestion just picked. A value equal to it is not looked up again; the first keystroke
  // that changes the value clears it. (A boolean flag would stay armed when the picked text equals the current
  // value, because no re-render follows, and would silently swallow the next keystroke's lookup.)
  const picked = useRef<string | null>(null);

  useEffect(() => {
    if (picked.current !== null) {
      if (value === picked.current) return;
      picked.current = null;
    }
    const q = value.trim();
    if (q.length < MIN_CHARS) { setItems([]); setOpen(false); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      load(q, controller.signal).then(
        (next) => { setItems(next); setActive(-1); setOpen(next.length > 0); },
        () => { if (!controller.signal.aborted) { setItems([]); setOpen(false); } },
      );
    }, debounceMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [value, load, debounceMs]);

  function pick(item: Suggestion) {
    picked.current = item.text;
    onChange(item.text);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a === -1 ? (step === 1 ? 0 : items.length - 1) : (a + step + items.length) % items.length));
    } else if (event.key === "Enter" && open && active >= 0) {
      event.preventDefault(); // pick the suggestion instead of submitting the form
      pick(items[active]!);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;
  return <div className="suggest">
    <input
      id={id}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
      autoComplete="off"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => { setOpen(false); setActive(-1); }}
    />
    <ul id={listId} role="listbox" aria-label="Suggestions" hidden={!open}>
      {items.map((item, i) => <li
        key={`${item.kind}-${item.text}`}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        // mousedown (not click) so the input keeps focus and onBlur does not close the list first
        onMouseDown={(event) => { event.preventDefault(); pick(item); }}
      >{item.text} <span className="suggest-kind">{item.kind === "speaker" ? "speaker" : "talk"}</span></li>)}
    </ul>
    <p className="visually-hidden" role="status">{open ? `${items.length} suggestion${items.length === 1 ? "" : "s"} available` : ""}</p>
  </div>;
}
