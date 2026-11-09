---
title: Public endpoint protections
description: Review the changed implementation for public endpoint protections.
type: check
when: Changes to public API routes, rate-limit configuration, aggregate caches, or this rule file.
actions: Report applicable evidence and violated requirements in Verification Rules. Do not modify code, send external messages, or approve/merge automatically.
---

# Public endpoint protections

Public endpoints must enforce a bounded per-client rate limit before expensive Elasticsearch or inference work. Expensive public reads must have bounded server-side caching or a documented freshness/security reason not to cache. Inspect trusted proxy configuration to prevent spoofed client IPs. Sensitive/authenticated responses must use private/no-store and must not be shared across attendees; caching does not mean caching tokens. Check limit and cache/isolation tests for changed behavior.

For a rule-only change, evaluate whether the rule encodes the stated requirement
and record that as static configuration review. Do not claim runtime compliance
or pretend tests ran. For other non-applicable changes, explain why skipped.
