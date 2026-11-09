---
title: Telemetry allowlist synchronization
description: Review the changed implementation for telemetry allowlist synchronization.
type: check
when: Changes to instrumentation, telemetry allowlists, collector configurations, or this rule file.
actions: Report applicable evidence and violated requirements in Verification Rules. Do not modify code, send external messages, or approve/merge automatically.
---

# Telemetry allowlist synchronization

Every new telemetry attribute key must be justified in docs/telemetry-allowlist.md and synchronized in api/src/telemetry/allowlist.ts, deploy/compose/otel-config.yaml and deploy/k8s/otel-collector/configmap.yaml for its signal. Reusing an already allowlisted key needs no redundant configuration edit. Check api/test/telemetry.test.ts synchronization tests. Allowlisting a key does not sanitize its value: routes must be bounded templates, never raw paths/query strings, and error values must not include attendee input. Sensitive identifiers must never be allowlisted.

For a rule-only change, evaluate whether the rule encodes the stated requirement
and record that as static configuration review. Do not claim runtime compliance
or pretend tests ran. For other non-applicable changes, explain why skipped.
