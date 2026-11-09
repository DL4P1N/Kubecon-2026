import { useEffect, useState } from "react";
import { OTHER_TOPIC, type InterestAggregateResponse } from "@cc/shared";
import { api } from "../api.js";
import "./map.css";

export const ROOM_STEP = 25;

/** Suggested room size: the count rounded up to the nearest 25 seats. */
export function roomSize(count: number): number {
  return Math.max(ROOM_STEP, Math.ceil(count / ROOM_STEP) * ROOM_STEP);
}

const label = (topic: string) => (topic === OTHER_TOPIC ? "Other (smaller groups combined)" : topic);

export function InterestMap() {
  const [data, setData] = useState<InterestAggregateResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.aggregate().then((res) => { if (active) setData(res); }, () => {
      if (active) setError("The interest map could not be loaded. Please try again shortly.");
    });
    return () => { active = false; };
  }, []);
  const max = Math.max(1, ...(data?.topics ?? []).map((t) => t.count));
  return <section className="interest-map">
    <h1>Interest map</h1>
    <p>Aggregate interests of attendees who opted in to the cluster map, for planning rooms.</p>
    <p className="map-note"><strong>{`Groups smaller than ${data?.suppressedBelow ?? 5} are hidden. Thresholds are untested on live data.`}</strong></p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading interest map…</p>}
    {data && data.topics.length === 0 && <p>Not enough opted-in attendees to show any group yet.</p>}
    {data && data.topics.length > 0 && <>
      <p>{data.totalOptedIn} attendees opted in.</p>
      <h2 id="chart-heading">Attendees per topic</h2>
      <ul className="bar-chart" aria-labelledby="chart-heading">{data.topics.map((t) =>
        <li key={t.topic}>
          <span className="bar-label">{label(t.topic)}</span>
          <span className="bar-track" aria-hidden="true"><span className="bar" style={{ width: `${(t.count / max) * 100}%` }} /></span>
          <span className="bar-value">{t.count}</span>
        </li>)}
      </ul>
      <table>
        <caption>Interest counts and suggested room sizes (rounded up to {ROOM_STEP} seats)</caption>
        <thead><tr><th scope="col">Topic</th><th scope="col">Attendees</th><th scope="col">Suggested room size</th></tr></thead>
        <tbody>{data.topics.map((t) =>
          <tr key={t.topic}><th scope="row">{label(t.topic)}</th><td>{t.count}</td><td>{roomSize(t.count)} seats</td></tr>)}
        </tbody>
      </table>
    </>}
  </section>;
}
