---
title: Conference Companion project requirements
description: Check project privacy, security, instrumentation, and PR scope requirements.
type: check
when: A pull request is opened or updated in this repository, including changes to .gitar configuration or documentation.
actions: Evaluate the applicable project requirements below and report evidence for each result in Verification. Report any violated requirement as an unmet check. Do not modify code or grant approvals automatically.
---

# Conference Companion project requirements

Use the canonical project guidance:

@../review/conference-companion.md

For each PR, check these requirements against the changed files and relevant
implementation. Explain which changed paths support each result. If a
requirement does not apply, state why rather than inventing evidence.

- Never log, emit in telemetry, or expose attendee IDs or location data.
- Onboarding asks no health, politics, or identity questions; collect only
  required fields and preserve consent checks on reads and writes.
- No secrets in the repository; signing keys, Elastic credentials, and Dash0
  tokens come from Kubernetes Secrets or local environment variables.
- Application Elasticsearch access uses the least-privilege `companion_svc`
  account, never the `elastic` superuser.
- Every API endpoint creates or continues an OpenTelemetry span.
- Telemetry attributes are on the collector allowlist; flag new attributes
  until they are explicitly added.
- Pull requests remain small and focused; flag unrelated refactors, generated
  file churn, and independent behavior changes combined in one PR. Behavior
  changes include tests or a clear explanation.

For configuration-only changes, verify that the configuration preserves these
requirements; do not claim runtime execution or CI-failure diagnosis based
on a static review. Keep the outcome in the Rules section so rule execution
can be distinguished from ordinary code-review guidance.
