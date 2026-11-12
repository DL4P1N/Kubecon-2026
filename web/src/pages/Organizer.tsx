import { useEffect, useState, type FormEvent } from "react";
import { OTHER_TOPIC, type InterestAggregateResponse, type InterestClustersResponse, type RoomPlacementResponse } from "@cc/shared";
import { api, ApiError } from "../api.js";
import { EmptyState, ErrorState, LoadingState } from "../components/PageState.js";
import { describeStatus, useStatus } from "../components/status.js";
import { ROOM_STEP, roomSize } from "./InterestMap.js";
import "./discovery.css";
import "../components/status.css";

const slotTime = (start: string, end: string) =>
  `${new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

const topicLabel = (topic: string) => (topic === OTHER_TOPIC ? "Other (smaller groups combined)" : topic);

/**
 * One page for organizers: topic interest, k-means clusters, room activity and service status.
 * Aggregates only (no attendee ids); groups below the k >= 5 threshold are suppressed by the API.
 * The organizer key lives in component state only and is never stored.
 */
export function Organizer() {
  const [aggregate, setAggregate] = useState<InterestAggregateResponse | null>(null);
  const [aggregateError, setAggregateError] = useState("");
  const [key, setKey] = useState("");
  const [clusters, setClusters] = useState<InterestClustersResponse | null>(null);
  const [clusterError, setClusterError] = useState("");
  const [placement, setPlacement] = useState<RoomPlacementResponse | null>(null);
  const [placementError, setPlacementError] = useState("");
  const [placementLoading, setPlacementLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const { status, loaded } = useStatus();
  const statusView = describeStatus(status);

  useEffect(() => {
    let active = true;
    api.aggregate().then(
      (res) => active && setAggregate(res),
      () => active && setAggregateError("Topic interest could not be loaded. Please try again shortly."),
    );
    return () => {
      active = false;
    };
  }, []);

  async function loadClusters(organizerKey: string) {
    setPending(true);
    setClusterError("");
    try {
      setClusters(await api.clusters(organizerKey));
    } catch (err) {
      setClusters(null);
      setClusterError(err instanceof ApiError && err.status === 401 ? "An organizer key is required." : "Could not load clusters. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function loadPlacement(organizerKey: string) {
    setPlacementLoading(true);
    setPlacementError("");
    try {
      setPlacement(await api.roomPlacement(organizerKey));
    } catch (err) {
      setPlacement(null);
      setPlacementError(err instanceof ApiError && err.status === 401 ? "An organizer key is required." : "Could not load room placement. Please try again.");
    } finally {
      setPlacementLoading(false);
    }
  }

  useEffect(() => {
    void loadClusters("");
    void loadPlacement("");
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    void loadClusters(key.trim());
    void loadPlacement(key.trim());
  }

  const k = aggregate?.suppressedBelow ?? clusters?.minClusterSize ?? 5;

  return (
    <section className="discovery organizer">
      <h1>Organizer dashboard</h1>
      <p>
        Aggregate views for room and speaker placement. No attendee IDs are shown; groups smaller than {k} are hidden.
        Thresholds are untested on live data.
      </p>

      <form onSubmit={onSubmit}>
        <label htmlFor="organizer-key">Organizer key</label>
        <input id="organizer-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        <button type="submit" disabled={pending}>
          {pending ? "Loading" : "Load organizer data"}
        </button>
      </form>

      <section aria-labelledby="org-interest">
        <h2 id="org-interest">Topic interest</h2>
        {aggregateError && <p role="alert">{aggregateError}</p>}
        {!aggregate && !aggregateError && <p role="status">Loading topic interest…</p>}
        {aggregate && aggregate.topics.length === 0 && <p>Not enough opted-in attendees to show any group yet.</p>}
        {aggregate && aggregate.topics.length > 0 && (
          <>
            <p>
              {aggregate.totalOptedIn} attendees opted in. Topics with fewer than {aggregate.suppressedBelow} attendees are combined or hidden.
            </p>
            <table>
              <caption>Suggested room size per track (attendee count rounded up to {ROOM_STEP} seats)</caption>
              <thead>
                <tr>
                  <th scope="col">Track</th>
                  <th scope="col">Interested attendees</th>
                  <th scope="col">Suggested room size</th>
                </tr>
              </thead>
              <tbody>
                {aggregate.topics.map((t) => (
                  <tr key={t.topic}>
                    <th scope="row">{topicLabel(t.topic)}</th>
                    <td>{t.count}</td>
                    <td>{roomSize(t.count)} seats</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-labelledby="org-clusters">
        <h2 id="org-clusters">Interest clusters</h2>
        {clusterError && <p role="alert">{clusterError}</p>}
        {clusters && clusters.runId === null && <p>No cluster run has completed yet.</p>}
        {clusters && clusters.runId !== null && (
          <>
            {clusters.clusters.length === 0 ? (
              <p>No group reached the minimum of {clusters.minClusterSize} attendees, so nothing is shown.</p>
            ) : (
              <table>
                <caption>Latest k-means run, computed {new Date(clusters.computedAt ?? "").toLocaleString()}</caption>
                <thead>
                  <tr>
                    <th scope="col">Cluster</th>
                    <th scope="col">Attendees</th>
                    <th scope="col">Top interests</th>
                  </tr>
                </thead>
                <tbody>
                  {clusters.clusters.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">{c.label}</th>
                      <td>{c.size}</td>
                      <td>{c.topInterests.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p>
              {clusters.suppressed > 0
                ? `${clusters.suppressed} opted-in attendee${clusters.suppressed === 1 ? " is" : "s are"} not shown because their group has fewer than ${clusters.minClusterSize} members.`
                : `Every opted-in attendee is in a group of at least ${clusters.minClusterSize}.`}
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="org-placement">
        <h2 id="org-placement">Room placement</h2>
        {placementLoading && <LoadingState>Loading room placement…</LoadingState>}
        {placementError && <ErrorState onRetry={() => void loadPlacement(key.trim())}>{placementError}</ErrorState>}
        {placement && placement.slots.length === 0 && <EmptyState><p>No talks with a readable time were found.</p></EmptyState>}
        {placement && placement.slots.length > 0 && (
          <>
            <p>
              Demand is the sum of attendee counts for a talk&apos;s tags. Only topics with at least {placement.suppressedBelow} opted-in
              attendees count, and one attendee can be counted under several tags, so read it as a relative score, not a headcount.
            </p>
            {!placement.capacitiesConfigured && (
              <p role="status">
                No room capacities are configured (ROOM_CAPACITIES), so no room is suggested. Talks are ranked by demand only.
              </p>
            )}
            <table className="placement-table">
              <caption>Talks by time slot, highest demand first</caption>
              <thead>
                <tr>
                  <th scope="col">Slot</th>
                  <th scope="col">Talk</th>
                  <th scope="col">Demand</th>
                  <th scope="col">Current room</th>
                  <th scope="col">Suggested room</th>
                </tr>
              </thead>
              <tbody>
                {placement.slots.flatMap((slot) =>
                  slot.talks.map((t) => (
                    <tr key={`${slot.start}-${slot.end}-${t.talkId}`}>
                      <td>{slotTime(slot.start, slot.end)}</td>
                      <th scope="row">{t.title}</th>
                      <td>{t.demand}</td>
                      <td>
                        {t.currentRoom}
                        {t.overCapacity && t.currentCapacity !== null && (
                          <strong className="placement-flag">Over capacity: demand {t.demand}, {t.currentCapacity} seats</strong>
                        )}
                        {!t.capacityKnown && <span className="placement-flag">Capacity unknown</span>}
                      </td>
                      <td>
                        {t.suggestedRoom ?? "No suggestion"}
                        {t.moved && <strong className="placement-flag">Move</strong>}
                        {t.suggestedRoom !== null && !t.moved && <span className="placement-flag">Keep</span>}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
            {placement.skippedTalks > 0 && (
              <p>{placement.skippedTalks} talk{placement.skippedTalks === 1 ? " was" : "s were"} left out because the time could not be read.</p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="org-rooms">
        <h2 id="org-rooms">Room scan activity</h2>
        <p>Not available yet: live room occupancy from QR check-ins (#42) has not been merged.</p>
      </section>

      <section aria-labelledby="org-status">
        <h2 id="org-status">Service status</h2>
        {!loaded && <p role="status">Checking status…</p>}
        {loaded && (
          <p className={`status-${statusView.tone}`}>
            <strong>
              {statusView.symbol} {statusView.label}
            </strong>
          </p>
        )}
        {loaded && !status && <p>The status endpoint could not be reached.</p>}
        {status && (
          <table className="status-table">
            <caption>Live values from the API</caption>
            <tbody>
              <tr><th scope="row">Database</th><td>{status.database.reachable ? "Reachable" : "Not reachable"}</td></tr>
              <tr><th scope="row">Hybrid search</th><td>{status.search.hybrid.state.replace("_", " ")}</td></tr>
              <tr><th scope="row">Server errors</th><td>{(status.errorRate.ratio * 100).toFixed(1)}% of {status.errorRate.requests} requests</td></tr>
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="org-howto">
        <h2 id="org-howto">How to use this for room and speaker placement</h2>
        <ul>
          <li>Put the tracks with the most interested attendees in the largest rooms; use the suggested room size as a floor, not a cap.</li>
          <li>Use clusters to avoid scheduling talks with shared top interests in the same slot, and to pick speakers for combined sessions.</li>
          <li>Counts only cover attendees who opted in, and small groups are hidden, so treat them as a lower bound.</li>
        </ul>
      </section>
    </section>
  );
}
