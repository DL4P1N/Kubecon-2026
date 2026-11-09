import { useEffect, useState } from "react";
import type { ScheduleResponse } from "@cc/shared";
import { api } from "../api.js";

export function Schedule() {
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getSchedule().then(setSchedule, (err) => setError(String(err)));
  }, []);

  return (
    <section>
      <h1>My schedule</h1>
      {error && <p role="alert">{error}</p>}
      {!schedule && !error && <p>Loading...</p>}
      {schedule && schedule.items.length === 0 && <p>No talks scheduled yet.</p>}
      <ul>
        {schedule?.items.map(({ talk, reason }) => (
          <li key={talk.id}>
            <strong>{talk.title}</strong> ({talk.room}, {new Date(talk.start).toLocaleTimeString()})
            {reason && <div>{reason}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
