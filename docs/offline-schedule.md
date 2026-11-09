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
the earlier of the session token expiry and 24 hours; expired entries are
deleted on access/worker activation. Closing the tab discards the namespace;
browser site-data controls can remove orphaned entries. Offline data is local
to the device and does not constitute current entitlement validation.

QR issuance, registration, calendar exports, other APIs and OTLP are
network-only. An existing QR is hidden immediately when the browser goes
offline, and offline QR issuance is disabled. No QR tokens or credentials are
stored in Cache Storage. Public talk details have a 24-hour TTL and a 100-entry
bound. Authentication failures invalidate the personal saved response and do
not return a cached schedule.

Run `npm run build -w shared`, `npm run build -w web`, then
`npx playwright test --config playwright.offline.config.ts` from `web`.
The test serves production assets with explicitly synthetic API fixtures,
disconnects Edge/Chromium, reloads the cached schedule, verifies its timestamp,
checks QR hiding and cross-tab isolation, and inspects cache keys/bodies for
credentials. It does not claim live-cluster or real-device acceptance.
