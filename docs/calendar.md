# Calendar export

On **My schedule**, choose **Add to calendar** to download the entire saved
schedule, or **Add this talk to calendar** for one saved talk. Import the `.ics`
file into your calendar app. Event times are UTC, so the calendar displays them
in its configured time zone. This is a downloaded snapshot, not a subscription;
export again after changing your schedule.

`GET /api/schedule.ics` uses the same signed Bearer session and 24-hour saved
schedule expiry as `GET /api/schedule`. Optional `?talkId=...` restricts export
to one talk already in that attendee's saved schedule; an unsaved talk returns
404. Missing, malformed or expired sessions return 401 before personal data is
read. The response is `text/calendar; charset=utf-8`, an attachment, and
`Cache-Control: private, no-store`. The browser sends the token in the header,
never in the download URL or filename.

Each VEVENT has a stable talk-based UID, UTC start/end, generation timestamp,
title, room, and a short abstract plus the official conference schedule URL.
The current talk contract has no per-talk source URL, so the URL links to the
catalog source page. No attendee ID, attendee name, token, or consent fields
are accepted by the calendar serializer or placed in the file. Room names are
public catalog locations, not attendee location tracking. Export creates a
`schedule.export` span using existing safe request metadata.

Serialization follows [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545): CRLF
content lines, TEXT escaping, and folding at 75 UTF-8 octets without splitting
a Unicode code point. Duplicate talk IDs are emitted once. Invalid date ranges
fail rather than generating an invalid event.

Validation: `api/test/calendar.test.ts` parses output with the independent
`ical.js` parser, round-trips punctuation/newlines/Unicode, checks UTC times and
stable UIDs, and exercises session isolation/401/selection. Web component tests
check authenticated Blob downloads, safe filenames and accessible error/session
handling. Real Apple/Google/Outlook import has not been manually verified.
