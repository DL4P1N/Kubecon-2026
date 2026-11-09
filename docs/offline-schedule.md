# Offline schedule

The production app registers a small service worker on HTTPS (or localhost).
Development mode does not register it. The app shell is versioned by its Vite
entry filename; visited public talk details and the latest successful personal
schedule can be read after losing connectivity. The first online visit must
finish installing the worker; schedules are saved on subsequent controlled
requests. A saved-time status appears for cached schedules, and reconnecting
refreshes the schedule.

Personal responses use a random namespace in tab-scoped sessionStorage.
Cache keys never contain the bearer token or attendee ID, and request headers
are never stored. Only public talk fields are retained, not recommendation
reasons or extra response fields. A changed registration rotates the namespace
and asks the worker to delete its previous entry. Cached schedules expire at
the earlier of the session token expiry and 24 hours; each entry stores its
own expiry, and an expired entry is never served offline. Deletion is not
immediate: the worker sweeps expired entries from both the schedule and talk
caches when it installs, when it activates, and on a fetch event if at least
10 minutes have passed since its last sweep in the current worker run. Closing
the tab discards the namespace without deleting its entry, so an orphaned
schedule stays in Cache Storage, unreadable, until the next sweep. That
happens on the next worker start or the next page request after an expiry, and
may be later still if the browser never starts the worker again. Browser
site-data controls remove entries at any time. Offline data is local to the
device and does not constitute current entitlement validation.

QR issuance, registration, calendar exports, other APIs and OTLP are
network-only. An existing QR is hidden immediately when the browser goes
offline, and offline QR issuance is disabled. No QR tokens or credentials are
stored in Cache Storage. Public talk details are stored with a 24-hour expiry
and a 100-entry bound; expired talk entries are not served offline and are
removed by the same sweep as schedules, with the same timing caveats.
Static `/assets/` files are cached only when the response content type matches
the file type (not `text/html`), so an SPA fallback page is never stored as a
script or stylesheet. Authentication failures invalidate the personal saved response and do
not return a cached schedule.

Run `npm run build -w shared`, `npm run build -w web`, then
`npx playwright test --config playwright.offline.config.ts` from `web`.
The test serves production assets with explicitly synthetic API fixtures,
disconnects Edge/Chromium, reloads the cached schedule, verifies its timestamp,
checks QR hiding and cross-tab isolation, and inspects cache keys/bodies for
credentials. It does not claim live-cluster or real-device acceptance.
