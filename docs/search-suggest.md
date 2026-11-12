# Typo tolerance and search-as-you-type

Attendees type on phones and misspell ("kuberentes", "opentelementry"). Two changes, both without touching the live index mapping.

## 1. Fuzziness on the keyword leg

`api/src/search/queries.ts`: the BM25 `multi_match` (keyword mode and the keyword leg of hybrid) now sends `fuzziness: "AUTO"` and `prefix_length: 1`.

- AUTO allows 1 edit for terms of 3-5 letters and 2 for longer ones; terms of 1-2 letters stay exact. A transposition counts as one edit.
- `prefix_length: 1` means the first letter must match, which cuts false hits and cost.
- The semantic leg is unchanged, so hybrid already understood many typos; this helps the keyword leg and keyword mode.
- The knobs live in `SearchTuning` (`fuzziness`, `fuzzyPrefixLength`). Leaving `fuzziness` unset restores exact matching. The offline eval's `baseline` variant has it unset; `current` uses the new default.

**Not measured:** the search eval (`scripts/search-eval.ts`) needs the live index and was not re-run for this change. Fuzzy matches score below exact ones, but whether the 5 wins / 7 ties / 0 losses result still holds is unverified. Re-run `current` against `excl` on the cluster before relying on it.

## 2. `GET /api/suggest?q=`

Returns up to 8 completions: `{ suggestions: [{ text, kind: "title" | "speaker" }] }`.

- Query: one SQL statement over `title` and `speaker`: a word-prefix match (finishes the last word) plus `pg_trgm` `word_similarity` for typed words of 4+ letters (forgives typos in whole words). No schema change is needed; the catalog is small enough that the trigram index on `title` is optional.
- A speaker is suggested only when a typed word starts one of their name's words, once even if they have several talks.
- Fewer than 2 characters: `200` with an empty list and no database call. More than 100: `400`. A repeated `q`: `400`.
- Public and cheap to abuse, so: 30 s in-memory cache (500 entries, key = lower-cased trimmed query), `Cache-Control: public, max-age=30`, and a per-client rate limit of 120/min (people firing several requests while typing; cached hits count).
- Privacy: the typed text is never logged and never on a span. The span `search.suggest` carries only the allowlisted `http.request.method`, `http.route` (the route template), `http.response.status_code` and `search.hits`. No new telemetry attribute.
- An unreachable database is `503` + `Retry-After: 5`; other failures `502`.

## 3. Search box

`web/src/components/SuggestInput.tsx` replaces the plain input on `/search` with the ARIA combobox pattern (list autocomplete):

- 250 ms debounce, minimum 2 characters, and the previous request is aborted on each keystroke, so a slow answer never overwrites a newer one.
- Focus stays in the input. Arrow keys move the highlight (wrapping), Enter picks the highlighted option instead of submitting (with nothing highlighted Enter submits the search as before), Escape closes, mouse/touch picks on press.
- `aria-expanded`, `aria-controls`, `aria-activedescendant`, `role=listbox/option`, and a polite live region announcing "N suggestions available". Options are at least 44 px tall.
- Suggestions are an enhancement: a failed request closes the list silently. No error is shown.

## Tests

Real SQL on an in-process Postgres (`api/test/suggest.test.ts`, `search.routes.test.ts`, `web/test/suggest.test.tsx`). Typo tolerance is `pg_trgm` word similarity. Not verified: an axe run for the combobox (CI runs axe).
