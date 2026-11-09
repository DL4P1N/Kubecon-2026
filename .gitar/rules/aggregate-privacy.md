---
title: Attendee aggregate privacy
description: Review the changed implementation for attendee aggregate privacy.
type: check
when: Changes to attendee aggregate endpoints, aggregate services, or this rule file.
actions: Report applicable evidence and violated requirements in Verification Rules. Do not modify code, send external messages, or approve/merge automatically.
---

# Attendee aggregate privacy

Suppress attendee-derived groups with fewer than five contributing observations before serializing any count, percentage, centroid or label. Do not expose suppressed counts through totals, debug fields or sibling endpoints. Check boundary tests at four and five. Catalog-only counts (talks, rooms) are not attendee groups. Document repeated-scan and process-local limitations; do not label scan activity as a verified headcount.

For a rule-only change, evaluate whether the rule encodes the stated requirement
and record that as static configuration review. Do not claim runtime compliance
or pretend tests ran. For other non-applicable changes, explain why skipped.
