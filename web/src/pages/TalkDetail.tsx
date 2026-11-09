import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RelatedTalksResponse, Talk } from "@cc/shared";
import { AddToSchedule } from "../components/AddToSchedule.js";
import { fetchRelated, fetchTalk, talkHref, TalksError } from "../talksApi.js";
import "./discovery.css";

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "full", timeStyle: "short" });
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Loader = { talk: typeof fetchTalk; related: typeof fetchRelated };
// Module-level so the effect below does not re-run on every render.
const DEFAULT_LOADER: Loader = { talk: fetchTalk, related: fetchRelated };

/**
 * Talk detail: speaker, full abstract, track, room, time and tags, plus
 * "Related talks" ranked by meaning. Related talks load separately so a slow
 * or warming-up semantic search never blocks the talk itself.
 */
export function TalkDetail({ load = DEFAULT_LOADER }: { load?: Loader }) {
  const { id = "" } = useParams();
  const [talk, setTalk] = useState<Talk | null>(null);
  const [talkState, setTalkState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [related, setRelated] = useState<RelatedTalksResponse | null>(null);
  const [relatedState, setRelatedState] = useState<"loading" | "ok" | "warming" | "error">("loading");

  useEffect(() => {
    let active = true;
    setTalk(null); setRelated(null); setTalkState("loading"); setRelatedState("loading");
    load.talk(id).then(
      (res) => { if (active) { setTalk(res.talk); setTalkState("ok"); } },
      (err: unknown) => { if (active) setTalkState(err instanceof TalksError && err.status === 404 ? "missing" : "error"); },
    );
    load.related(id).then(
      (res) => { if (active) { setRelated(res); setRelatedState("ok"); } },
      (err: unknown) => { if (active) setRelatedState(err instanceof TalksError && err.status === 503 ? "warming" : "error"); },
    );
    return () => { active = false; };
  }, [id, load]);

  if (talkState === "loading") return <section className="discovery"><p role="status">Loading talk…</p></section>;
  if (talkState === "missing") {
    return <section className="discovery"><h1>Talk not found</h1><p>We could not find that talk. <Link to="/search">Search talks</Link>.</p></section>;
  }
  if (talkState === "error" || !talk) {
    return <section className="discovery"><p role="alert">This talk could not be loaded. Please reload to try again.</p></section>;
  }

  return <section className="discovery talk-detail">
    <h1>{talk.title}</h1>
    <p className="talk-speaker">{talk.speaker}</p>
    <dl className="talk-facts">
      <dt>Track</dt><dd>{talk.track}</dd>
      <dt>Room</dt><dd>{talk.room}</dd>
      <dt>When</dt>
      <dd><time dateTime={talk.start}>{when(talk.start)}</time>{" – "}<time dateTime={talk.end}>{hm(talk.end)}</time></dd>
      {talk.level && <><dt>Level</dt><dd>{talk.level}</dd></>}
    </dl>
    {talk.tags.length > 0 && <ul className="talk-tags" aria-label="Tags">{talk.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
    <AddToSchedule talkId={talk.id} />
    <h2>Abstract</h2>
    <p className="talk-abstract">{talk.abstract}</p>
    <section aria-labelledby="related-heading">
      <h2 id="related-heading">Related talks</h2>
      {relatedState === "loading" && <p role="status">Finding related talks…</p>}
      {relatedState === "warming" && <p role="status">Related-talk search is warming up. Reload in a few seconds.</p>}
      {relatedState === "error" && <p role="alert">Related talks could not be loaded.</p>}
      {relatedState === "ok" && related && related.related.length === 0 && <p>No related talks found.</p>}
      {relatedState === "ok" && related && related.related.length > 0 && <ol className="related-list">
        {related.related.map(({ talk: rel, sharedTags }) => <li key={rel.id}>
          <Link to={talkHref(rel.id)}>{rel.title}</Link>
          <br />{rel.speaker} · {rel.room} · <time dateTime={rel.start}>{hm(rel.start)}</time>
          <br />{sharedTags.length > 0 ? `Why: shares ${sharedTags.join(", ")}` : "Why: similar topic"}
        </li>)}
      </ol>}
    </section>
  </section>;
}
