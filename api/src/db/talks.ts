import type { Talk } from "@cc/shared";

export type TalkLevel = "beginner" | "intermediate" | "advanced";

/** Catalog entry as stored in data/talks.json and the `talks` index (minus the vector). */
export interface CatalogTalk extends Talk {
  level: TalkLevel;
}
