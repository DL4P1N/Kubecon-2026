---
title: Attendee identifier and token exposure
description: Review the changed implementation for attendee identifier and token exposure.
type: check
when: Changes to API response contracts, routes, logging, browser storage, telemetry, or this rule file.
actions: Report applicable evidence and violated requirements in Verification Rules. Do not modify code, send external messages, or approve/merge automatically.
---

# Attendee identifier and token exposure

Do not expose attendee IDs, bearer/QR tokens, locations, names, email addresses or free-text input in public/aggregate responses, logs, telemetry attributes, span names or error bodies. Authenticated registration and QR issuance may return the credential required by their documented contract to its authorized owner; this is not permission to log or export it. Verify authorization boundaries and minimization. Never put credentials in URLs, analytics or shared caches. Inspect 404 and error paths as well as successful requests.

For a rule-only change, evaluate whether the rule encodes the stated requirement
and record that as static configuration review. Do not claim runtime compliance
or pretend tests ran. For other non-applicable changes, explain why skipped.
