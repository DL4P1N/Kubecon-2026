import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SearchFacets, SearchMode, SearchResponse } from "@cc/shared";
import { ApiError, api } from "../api.js";
import { talkHref } from "../talksApi.js";
import { SuggestInput } from "../components/SuggestInput.js";
import { EmptyState, ErrorState } from "../components/PageState.js";
import { SearchFilters } from "../components/SearchFilters.js";
import { readSearchState, toFilterParams, writeSearchState, type SearchPageState } from "../searchFilters.js";
import "./discovery.css";

type Result = SearchResponse & { debug?: unknown };
const modes = ["keyword", "hybrid"] as const;
/** Keeps the query and selected filters in the address bar so a search can be shared or reloaded. */
function persistInUrl(state: SearchPageState) {
  const qs = writeSearchState(state);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}

export function Search() {
  const [initial] = useState(() => readSearchState(window.location.search));
  const [q, setQ] = useState(initial.q);
  const [filters, setFilters] = useState<SearchPageState>(initial);
  // The query the shown results are for; filter changes re-run it.
  const [searchedQ, setSearchedQ] = useState<string | null>(null);
  // Facet counts of the last finished search, kept while the next one runs so chips do not flicker.
  const [facets, setFacets] = useState<SearchFacets | undefined>(undefined);
  const [debug, setDebug] = useState(false);
  const [results, setResults] = useState<Partial<Record<SearchMode, Result>>>({});
  const [errors, setErrors] = useState<Partial<Record<SearchMode, string>>>({});
  const [pending, setPending] = useState(false);
  // Hybrid was overloaded (503) or failing in Elasticsearch (502): keyword results are shown in its place.
  const [hybridFellBack, setHybridFellBack] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await run(q.trim(), filters);
  }
  async function onFiltersChange(next: SearchPageState) {
    setFilters(next);
    if (searchedQ === null) persistInUrl({ ...next, q: q.trim() });
    else await run(searchedQ, next);
  }
  // A shared link with a query runs its search on load.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || initial.q.trim() === "") return;
    autoRan.current = true;
    void run(initial.q.trim(), initial);
  }, []);
  async function run(query: string, selected: SearchPageState) {
    if (pending) return;
    persistInUrl({ ...selected, q: query });
    setSearchedQ(query);
    setPending(true);
    setResults({});
    setErrors({});
    setHybridFellBack(false);
    const params = toFilterParams(selected);
    const responses = await Promise.allSettled(modes.map((mode) => api.search(query, mode, debug, params)));
    const next: Partial<Record<SearchMode, Result>> = {};
    const failures: Partial<Record<SearchMode, string>> = {};
    responses.forEach((response, index) => {
      const mode = modes[index]!;
      if (response.status === "fulfilled") next[mode] = response.value;
      else failures[mode] = "Search failed. Please try again.";
    });
    // Attendees should not see an error because the semantic model is warming up.
    const hybridFailure = responses[1]!;
    const fallback = hybridFailure.status === "rejected" && hybridFailure.reason instanceof ApiError
      && (hybridFailure.reason.status === 503 || hybridFailure.reason.status === 502) && next.keyword !== undefined;
    if (fallback) {
      const { debug: _keywordDebug, ...keywordOnly } = next.keyword!;
      next.hybrid = { ...keywordOnly, mode: "hybrid" };
      delete failures.hybrid;
    }
    setHybridFellBack(fallback);
    // Counts come from keyword matches (exact terms); hybrid facets are used when keyword failed.
    setFacets(next.keyword?.facets ?? next.hybrid?.facets);
    setResults(next);
    setErrors(failures);
    setPending(false);
  }
  return <section className="discovery">
    <h1>Search talks</h1>
    <p>Compare exact keyword matches with hybrid search, which also looks for related meaning.</p>
    <form onSubmit={onSubmit} role="search" aria-busy={pending}>
      <label htmlFor="q">Query</label>
      <SuggestInput id="q" value={q} onChange={setQ} maxLength={1000} placeholder="Securing my Kubernetes supply chain" />
      <label><input type="checkbox" checked={debug} onChange={(event) => setDebug(event.target.checked)} /> Include Elasticsearch query details</label>
      <button type="submit" disabled={pending}>{pending ? "Searching…" : "Search"}</button>
    </form>
    <SearchFilters facets={facets} state={filters} onChange={onFiltersChange} disabled={pending} />
    <p role="status">{pending ? "Searching both methods…" : Object.keys(results).length > 0 ? "Comparison ready." : "Enter a query to compare results."}</p>
    <div className="search-comparison">{modes.map((mode) => <section key={mode} aria-labelledby={`heading-${mode}`}>
      <h2 id={`heading-${mode}`}>{mode === "keyword" ? "Keyword" : "Hybrid"}</h2>
      {errors[mode] && <ErrorState onRetry={() => void run(searchedQ ?? q.trim(), filters)} retryLabel={`Retry ${mode} search`}>{errors[mode]}</ErrorState>}
      {mode === "hybrid" && hybridFellBack && <p role="status">Hybrid search is warming up, so keyword results are shown here instead. Try again in a few seconds.</p>}
      {results[mode] && <>
        <p>{results[mode]!.hits.length} results · {results[mode]!.tookMs} ms</p>
        {results[mode]!.hits.length === 0 && <EmptyState>
          <p>No matching talks.</p>
          <p>Try broader or fewer words, for example “security” instead of a full sentence, check the spelling, or clear some filters.</p>
        </EmptyState>}
        <ol className="talk-results">{results[mode]!.hits.map(({ talk, score }) => <li key={talk.id}>
          <h3><a href={talkHref(talk.id)}>{talk.title}</a></h3><p>{talk.speaker} · {talk.room}</p><p>{talk.abstract}</p>
          <p>Score: {score.toFixed(2)}</p>
        </li>)}</ol>
        {debug && !(mode === "hybrid" && hybridFellBack) && <details><summary>Elasticsearch query</summary>
          {results[mode]!.debug === undefined ? <p>Query details are unavailable from this server. Enable details and search again.</p>
            : <pre>{JSON.stringify(results[mode]!.debug, null, 2)}</pre>}
        </details>}
      </>}
    </section>)}</div>
  </section>;
}
