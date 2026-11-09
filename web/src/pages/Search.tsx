import { useState, type FormEvent } from "react";
import type { SearchMode, SearchResponse } from "@cc/shared";
import { api } from "../api.js";
import "./discovery.css";

type Result = SearchResponse & { debug?: unknown };
const modes = ["keyword", "hybrid"] as const;
export function Search() {
  const [q, setQ] = useState("");
  const [debug, setDebug] = useState(false);
  const [results, setResults] = useState<Partial<Record<SearchMode, Result>>>({});
  const [errors, setErrors] = useState<Partial<Record<SearchMode, string>>>({});
  const [pending, setPending] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setResults({});
    setErrors({});
    const responses = await Promise.allSettled(modes.map((mode) => api.search(q.trim(), mode, debug)));
    const next: Partial<Record<SearchMode, Result>> = {};
    const failures: Partial<Record<SearchMode, string>> = {};
    responses.forEach((response, index) => {
      const mode = modes[index]!;
      if (response.status === "fulfilled") next[mode] = response.value;
      else failures[mode] = "Search failed. Please try again.";
    });
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
      {results[mode] && <>
        <p>{results[mode]!.hits.length} results · {results[mode]!.tookMs} ms</p>
        {results[mode]!.hits.length === 0 && <p>No matching talks. Try a broader query.</p>}
        <ol className="talk-results">{results[mode]!.hits.map(({ talk, score }) => <li key={talk.id}>
          <h3>{talk.title}</h3><p>{talk.speaker} · {talk.room}</p><p>{talk.abstract}</p>
          <p>Score: {score.toFixed(2)}</p>
        </li>)}</ol>
        {debug && <details><summary>Elasticsearch query</summary>
          {results[mode]!.debug === undefined ? <p>Query details are unavailable from this server. Enable details and search again.</p>
            : <pre>{JSON.stringify(results[mode]!.debug, null, 2)}</pre>}
        </details>}
      </>}
    </section>)}</div>
  </section>;
}
