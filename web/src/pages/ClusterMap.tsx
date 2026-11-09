import { useEffect, useState, type FormEvent } from "react";
import type { InterestClustersResponse } from "@cc/shared";
import { api, ApiError } from "../api.js";
import "./discovery.css";
import "./cluster-map.css";

/** Organizer view of the latest k-means batch run. Aggregates only; every cluster has at least 5 attendees. */
export function ClusterMap() {
  const [key, setKey] = useState("");
  const [data, setData] = useState<InterestClustersResponse | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function load(organizerKey: string) {
    setPending(true);
    setError("");
    try {
      setData(await api.clusters(organizerKey));
    } catch (err) {
      setData(null);
      setError(err instanceof ApiError && err.status === 401 ? "An organizer key is required." : "Could not load the cluster map. Please try again.");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!pending) void load(key.trim());
  }

  const max = Math.max(1, ...(data?.clusters.map((c) => c.size) ?? [1]));

  return (
    <section className="discovery cluster-map">
      <h1>Interest cluster map</h1>
      <p className="cluster-note">
        Thresholds untested on live data. With a few hundred attendees the map may look sparse.
      </p>
      <form onSubmit={onSubmit}>
        <label htmlFor="organizer-key">Organizer key</label>
        <input id="organizer-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        <button type="submit" disabled={pending}>
          {pending ? "Loading" : "Load map"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {data && data.runId === null && <p role="status">No cluster run has completed yet.</p>}
      {data && data.runId !== null && (
        <>
          <p role="status">
            {data.clusters.length === 0
              ? `No group reached the minimum of ${data.minClusterSize} attendees, so nothing is shown.`
              : `${data.clusters.length} cluster${data.clusters.length === 1 ? "" : "s"}, computed ${new Date(data.computedAt ?? "").toLocaleString()}.`}
          </p>
          <ul className="cluster-bubbles" aria-label="Interest clusters">
            {data.clusters.map((c) => {
              const diameter = 7 + 7 * Math.sqrt(c.size / max);
              return (
                <li key={c.id} className={c.other ? "cluster-bubble other" : "cluster-bubble"} style={{ width: `${diameter}rem`, height: `${diameter}rem` }}>
                  <strong>{c.label}</strong>
                  <span>{c.size} attendees</span>
                  {c.topInterests.length > 0 && <small>{c.topInterests.join(", ")}</small>}
                </li>
              );
            })}
          </ul>
          <p>
            {data.suppressed > 0
              ? `${data.suppressed} opted-in attendee${data.suppressed === 1 ? " is" : "s are"} not shown because their group has fewer than ${data.minClusterSize} members.`
              : `Every opted-in attendee is in a group of at least ${data.minClusterSize}.`}
          </p>
        </>
      )}
    </section>
  );
}
