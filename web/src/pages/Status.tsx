import { describeStatus, useStatus } from "../components/status.js";
import "../components/status.css";

const ms = (v: number | null) => (v === null ? "no searches yet" : `${v} ms`);
const hybridText = { ready: "Ready", warming_up: "Warming up (keyword search still works)", unknown: "No recent hybrid searches" } as const;

export function Status() {
  const { status, loaded } = useStatus();
  const view = describeStatus(status);
  return (
    <section>
      <h1>Service status</h1>
      {!loaded && <p role="status">Checking status…</p>}
      {loaded && <p role="status" className={`status-${view.tone}`}><strong>{view.symbol} {view.label}</strong></p>}
      {loaded && !status && <p>The status endpoint could not be reached. The app may be restarting; try again in a moment.</p>}
      {status && (
        <>
          <table className="status-table">
            <caption>Live values from the API, last {Math.round(status.windowSeconds / 60)} minutes</caption>
            <tbody>
              <tr><th scope="row">API</th><td>Up (version {status.api.version})</td></tr>
              <tr><th scope="row">Database</th><td>{status.database.reachable ? "Reachable" : "Not reachable"}</td></tr>
              <tr><th scope="row">Keyword search</th><td>p95 {ms(status.search.keyword.p95Ms)} ({status.search.keyword.samples} searches)</td></tr>
              <tr><th scope="row">Hybrid search</th><td>{hybridText[status.search.hybrid.state]}; p95 {ms(status.search.hybrid.p95Ms)} ({status.search.hybrid.samples} searches)</td></tr>
              <tr><th scope="row">Server errors</th><td>{status.errorRate.serverErrors} of {status.errorRate.requests} requests ({(status.errorRate.ratio * 100).toFixed(1)}%)</td></tr>
            </tbody>
          </table>
          <p>Updated {new Date(status.generatedAt).toLocaleTimeString()}. Values are counted by this API process only, are cached for ~10 seconds, and reset when it restarts. They contain no attendee data.</p>
        </>
      )}
    </section>
  );
}
