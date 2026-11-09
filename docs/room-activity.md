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
rejecting requests with 429, before an Elasticsearch query is made.

Under five allowed scans, both `recentScans` and `percentage` are null and the
label is quiet. This is small-count suppression, **not** a claim of five
distinct people or formal anonymity: one person can scan repeatedly.

Set `ROOM_CAPACITIES_JSON` to a JSON object of exact catalog room names and
positive integer capacities. No room sizes are invented. With a configured
capacity, recent scans produce quiet (<40%), busy (40–79%) or almost full
(80%+) labels. Percentage is capped at 100. Without a configured capacity,
percentage is null and at least five scans mean busy scan activity.

This is a check-in signal, not measured occupancy: there are no exit events,
repeat scans count again, and data resets on restart. Multiple API replicas
have separate counters. The demo must run one API replica or replace this
with a shared aggregate store before claiming a consistent multi-pod view.
The schedule and kiosk refresh every 30 seconds; kiosk also refreshes after
scanning. Unavailable activity is labelled unavailable, never quiet.
