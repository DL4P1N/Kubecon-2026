# Auto-apply criteria

Gitar may auto-apply only small, mechanical fixes that do not change product
behavior: formatting, imports, lint fixes, obvious type corrections, and
missing or corrected tests for already-specified behavior.

Never auto-apply a change that touches authentication, authorization,
attendee data, consent, telemetry fields, database schema or roles,
Kubernetes Secrets, dependencies, CI permissions, or deployment
configuration. Those changes require a human review.

All auto-applied fixes remain subject to the repository's required CI checks
and pull-request review. Per-PR opt-in is required.
