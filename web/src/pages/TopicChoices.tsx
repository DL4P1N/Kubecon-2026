import { useEffect, useState } from "react";
import { api } from "../api.js";

export function TopicChoices({ selected, onChange }: {
  selected: string[];
  onChange: (topics: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.search("", "keyword").then((result) => {
      if (active) setTags([...new Set(result.hits.flatMap(({ talk }) => talk.tags))].sort());
    }, () => { if (active) setError("Topics could not be loaded. You can continue and describe your interests in onboarding."); });
    return () => { active = false; };
  }, []);
  return <fieldset>
    <legend>Topics that interest you</legend>
    <p>Select any that apply. These topics come from the talk catalog.</p>
    {error && <p role="status">{error}</p>}
    <div className="topic-choices">{tags.map((tag) => <label key={tag}>
      <input type="checkbox" checked={selected.includes(tag)} onChange={(event) =>
        onChange(event.target.checked ? [...selected, tag] : selected.filter((value) => value !== tag))} /> {tag}
    </label>)}</div>
  </fieldset>;
}
