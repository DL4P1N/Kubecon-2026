# Recent room activity

The public endpoint limits each client to 120 reads per minute before work.
Its bounded catalog room list is cached server-side for 60 seconds with
concurrent refreshes shared; scan buckets are evaluated fresh on each request.
Responses use `Cache-Control: no-store` so browsers do not reuse stale activity.

`GET /api/rooms/occupancy` is a public aggregate view. It gets room names from
the talks index and reports allowed scans in roughly the last ten minutes,
using minute buckets in the API process. No attendee IDs, device identifiers,
or individual scan records are retained by this counter. Denied, invalid and
revoked scans are excluded. Catalog failures return 503 rather than a false
quiet result. A `rooms.occupancy` span contains no user attributes.
The public endpoint permits 120 requests per client IP per minute before
rejecting requests with 429, before a database query is made.

Only a coarse label is public: quiet below five allowed scans, some recent
check-ins for five through nineteen, or many recent check-ins for twenty or
more. Suppression is applied after summing all minute buckets. Exact counts,
percentages and room-capacity estimates are never returned, including above
the suppression threshold. Capacity configuration is not used.

These labels reduce the precision available through repeated polling; they
are **not** formal anonymity or a claim of five distinct people. A valid QR
can be replayed, and someone adding their own scans can influence a bucket or
infer information when a coarse boundary is crossed. Minute-bucket expiry can
also change a label. Rate limits constrain request volume, not this inference.
Do not treat these labels as attendance, room fullness or available seats.

This is a check-in signal, not measured occupancy: there are no exit events,
repeat scans count again, and data resets on restart. Multiple API replicas
have separate counters. The demo must run one API replica or replace this
with a shared aggregate store before claiming a consistent multi-pod view.
The schedule and kiosk refresh every 30 seconds; kiosk also refreshes after
scanning. Unavailable activity is labelled unavailable, never quiet.
