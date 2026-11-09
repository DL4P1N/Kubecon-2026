import { useState, type FormEvent } from "react";
import type { SearchMode, SearchResponse } from "@cc/shared";
import { api } from "../api.js";

export function Search() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      setResult(await api.search(q, mode));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section>
      <h1>Search talks</h1>
      <form onSubmit={onSubmit} role="search">
        <label htmlFor="q">Query</label>
        <input id="q" value={q} onChange={(e) => setQ(e.target.value)} />
        <label htmlFor="mode">Mode</label>
        <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as SearchMode)}>
          <option value="hybrid">Hybrid</option>
          <option value="keyword">Keyword</option>
        </select>
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p role="status">
            {result.hits.length} result(s) in {result.tookMs} ms ({result.mode})
          </p>
          <ul>
            {result.hits.map(({ talk, score }) => (
              <li key={talk.id}>
                <strong>{talk.title}</strong> by {talk.speaker} (score {score.toFixed(2)})
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
