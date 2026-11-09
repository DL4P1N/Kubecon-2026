import type { FacetBucket, SearchFacets } from "@cc/shared";
import { TIME_SLOTS, dayLabel, type SearchPageState, type TimeSlot } from "../searchFilters.js";

interface Chip {
  value: string;
  label: string;
  count?: number;
}

/** Facet buckets plus any selected value the current results no longer contain (count 0). */
function chipsFor(buckets: FacetBucket[] | undefined, selected: string[], label: (v: string) => string = (v) => v): Chip[] {
  const chips: Chip[] = (buckets ?? []).map((b) => ({ value: b.value, label: label(b.value), count: b.count }));
  for (const v of selected) if (!chips.some((c) => c.value === v)) chips.push({ value: v, label: label(v), count: 0 });
  return chips;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ChipGroup({ legend, chips, isOn, onToggle, disabled }: {
  legend: string;
  disabled: boolean;
  chips: Chip[];
  isOn: (value: string) => boolean;
  onToggle: (value: string) => void;
}) {
  if (chips.length === 0) return null;
  return <fieldset className="filter-group" disabled={disabled}>
    <legend>{legend}</legend>
    {chips.map((c) => <button
      key={c.value}
      type="button"
      className="filter-chip"
      aria-pressed={isOn(c.value)}
      onClick={() => onToggle(c.value)}
    >
      {c.label}{c.count !== undefined && <span className="filter-count"> ({c.count})</span>}
    </button>)}
  </fieldset>;
}

const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Filter chips for /search: day, time slot (once a day is chosen), level and track, with facet counts. */
export function SearchFilters({ facets, state, onChange, disabled = false }: {
  facets?: SearchFacets;
  state: SearchPageState;
  onChange: (next: SearchPageState) => void;
  disabled?: boolean;
}) {
  const days = chipsFor(facets?.day, state.day ? [state.day] : [], dayLabel);
  const levels = chipsFor(facets?.level, state.level, capitalize);
  const tracks = chipsFor(facets?.track, state.track);
  const slots: Chip[] = (Object.keys(TIME_SLOTS) as TimeSlot[]).map((s) => ({
    value: s,
    label: `${TIME_SLOTS[s].label} ${TIME_SLOTS[s].from}–${TIME_SLOTS[s].to}`,
  }));
  const active = Boolean(state.day) || state.level.length > 0 || state.track.length > 0;
  if (days.length + levels.length + tracks.length === 0) return null;
  return <section className="search-filters" aria-label="Filters">
    <ChipGroup disabled={disabled} legend="Day" chips={days} isOn={(v) => state.day === v}
      onToggle={(v) => {
        const { day: _day, slot: _slot, ...rest } = state;
        onChange(state.day === v ? rest : { ...rest, day: v });
      }} />
    {state.day && <ChipGroup disabled={disabled} legend="Time slot" chips={slots} isOn={(v) => state.slot === v}
      onToggle={(v) => {
        const { slot: _slot, ...rest } = state;
        onChange(state.slot === v ? rest : { ...rest, slot: v as TimeSlot });
      }} />}
    <ChipGroup disabled={disabled} legend="Level" chips={levels} isOn={(v) => state.level.includes(v as SearchPageState["level"][number])}
      onToggle={(v) => onChange({ ...state, level: toggle(state.level, v as SearchPageState["level"][number]) })} />
    <ChipGroup disabled={disabled} legend="Track" chips={tracks} isOn={(v) => state.track.includes(v)}
      onToggle={(v) => onChange({ ...state, track: toggle(state.track, v) })} />
    {active && <button type="button" className="filter-clear" disabled={disabled} onClick={() => onChange({ q: state.q, level: [], track: [] })}>
      Clear filters
    </button>}
  </section>;
}
