import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { ExperienceLevel, SearchHit } from "@cc/shared";
import { api } from "../api.js";
import { TopicChoices } from "./TopicChoices.js";
import "./attendee.css";

export function selectTalks(hits: SearchHit[]): string[] {
  const chosen: SearchHit[] = [];
  for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
    const start = Date.parse(hit.talk.start);
    const end = Date.parse(hit.talk.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
    if (chosen.every(({ talk }) => end <= Date.parse(talk.start) || start >= Date.parse(talk.end))) chosen.push(hit);
  }
  return chosen.map(({ talk }) => talk.id);
}

export function Onboarding() {
  const navigate = useNavigate();
  const [topics, setTopics] = useState<string[]>([]);
  const [experience, setExperience] = useState<ExperienceLevel>("beginner");
  const [goals, setGoals] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (topics.length === 0 && goals.length === 0 && freeText.trim() === "") {
      setError("Choose a topic or goal, or describe what you would like to learn.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await api.onboarding({ answers: { topics, experience, goals, freeText: freeText.trim() } });
      const matches = await api.search(result.query.text, result.query.mode);
      const talkIds = selectTalks(matches.hits);
      if (talkIds.length === 0) {
        setError("No matching talks found. Try a broader topic or a shorter description.");
        return;
      }
      await api.saveSchedule({ talkIds });
      navigate("/schedule");
    } catch {
      setError("We could not build your schedule. Please try again. If your session expired, register again.");
    } finally { setPending(false); }
  }
  return <form className="attendee-form" onSubmit={onSubmit} aria-busy={pending}>
    <h1>Onboarding</h1>
    <p>Tell us what you want to learn. We’ll find relevant talks and save a schedule without overlapping sessions.</p>
    <TopicChoices selected={topics} onChange={setTopics} />
    <label htmlFor="experience">Your experience level</label>
    <select id="experience" value={experience} onChange={(event) => setExperience(event.target.value as ExperienceLevel)}>
      <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
    </select>
    <fieldset><legend>What do you want from the conference?</legend>
      {["Learn the basics", "Solve a production problem", "Explore new tools", "Hear real-world stories"].map((goal) => <label key={goal}>
        <input type="checkbox" checked={goals.includes(goal)} onChange={(event) => setGoals(event.target.checked
          ? [...goals, goal] : goals.filter((value) => value !== goal))} /> {goal}
      </label>)}
    </fieldset>
    <label htmlFor="learning-goal">What would you like to learn, in your own words?</label>
    <p id="learning-help">For example, “How can I secure my Kubernetes supply chain?” Please leave out personal or sensitive information.</p>
    <textarea id="learning-goal" aria-describedby="learning-help" rows={4} maxLength={1000}
      value={freeText} onChange={(event) => setFreeText(event.target.value)} />
    <button type="submit" disabled={pending}>{pending ? "Building your schedule…" : "Find talks"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
