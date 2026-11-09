import { useState, type FormEvent } from "react";
import type { SearchMode, SearchResponse } from "@cc/shared";
import { ApiError, api } from "../api.js";
import { talkHref } from "../talksApi.js";
import "./discovery.css";

type Result = SearchResponse & { debug?: unknown };
const modes = ["keyword", "hybrid"] as const;
export function Search() {
  const [q, setQ] = useState("");
  const [debug, setDebug] = useState(false);
  const [results, setResults] = useState<Partial<Record<SearchMode, Result>>>({});
  const [errors, setErrors] = useState<Partial<Record<SearchMode, string>>>({});
  const [pending, setPending] = useState(false);
  // Hybrid was overloaded (503) or failing in Elasticsearch (502): keyword results are shown in its place.
  const [hybridFellBack, setHybridFellBack] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setResults({});
    setErrors({});
    setHybridFellBack(false);
    const responses = await Promise.allSettled(modes.map((mode) => api.search(q.trim(), mode, debug)));
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
    setResults(next);
    setErrors(failures);
    setPending(false);
  }
  return <section className="discovery">
    <h1>Search talks</h1>
    <p>Compare exact keyword matches with hybrid search, which also looks for related meaning.</p>
    <form onSubmit={onSubmit} role="search" aria-busy={pending}>
      <label htmlFor="q">Query</label>
      <input id="q" value={q} maxLength={1000} onChange={(event) => setQ(event.target.value)} placeholder="Securing my Kubernetes supply chain" />
      <label><input type="checkbox" checked={debug} onChange={(event) => setDebug(event.target.checked)} /> Include Elasticsearch query details</label>
      <button type="submit" disabled={pending}>{pending ? "Searching…" : "Search"}</button>
    </form>
    <p role="status">{pending ? "Searching both methods…" : Object.keys(results).length > 0 ? "Comparison ready." : "Enter a query to compare results."}</p>
    <div className="search-comparison">{modes.map((mode) => <section key={mode} aria-labelledby={`heading-${mode}`}>
      <h2 id={`heading-${mode}`}>{mode === "keyword" ? "Keyword" : "Hybrid"}</h2>
      {errors[mode] && <p role="alert">{errors[mode]}</p>}
      {mode === "hybrid" && hybridFellBack && <p role="status">Hybrid search is warming up, so keyword results are shown here instead. Try again in a few seconds.</p>}
      {results[mode] && <>
        <p>{results[mode]!.hits.length} results · {results[mode]!.tookMs} ms</p>
        {results[mode]!.hits.length === 0 && <p>No matching talks. Try a broader query.</p>}
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
