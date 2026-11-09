export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The profile a finished chat produces (validated by script.js validateProfile). */
export interface ChatProfile {
  name: string;
  role: string;
  interests: string[];
  goal: string;
  formats: string;
}
