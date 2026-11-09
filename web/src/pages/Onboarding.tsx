import { useState, type FormEvent } from "react";
import type { ExperienceLevel, OnboardingResponse } from "@cc/shared";
import { api } from "../api.js";

export function Onboarding() {
  const [topics, setTopics] = useState("");
  const [experience, setExperience] = useState<ExperienceLevel>("intermediate");
  const [goals, setGoals] = useState("");
  const [result, setResult] = useState<OnboardingResponse | null>(null);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      setResult(await api.onboarding({ answers: { topics: split(topics), experience, goals: split(goals) } }));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <h1>Onboarding</h1>
      <label htmlFor="topics">Topics you care about (comma separated)</label>
      <input id="topics" value={topics} onChange={(e) => setTopics(e.target.value)} />
      <label htmlFor="experience">Experience</label>
      <select id="experience" value={experience} onChange={(e) => setExperience(e.target.value as ExperienceLevel)}>
        <option value="beginner">Beginner</option>
        <option value="intermediate">Intermediate</option>
        <option value="advanced">Advanced</option>
      </select>
      <label htmlFor="goals">What do you want from the conference? (comma separated)</label>
      <input id="goals" value={goals} onChange={(e) => setGoals(e.target.value)} />
      <button type="submit">Find talks</button>
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">Query: {result.query.text}</p>}
    </form>
  );
}
