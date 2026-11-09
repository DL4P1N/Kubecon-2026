export const SUGGEST_PATH = "/api/suggest";

/** One search-as-you-type completion: a talk title or a speaker name. */
export interface Suggestion {
  text: string;
  kind: "title" | "speaker";
}

export interface SuggestResponse {
  suggestions: Suggestion[];
}
