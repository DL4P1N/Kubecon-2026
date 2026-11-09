# Conference Companion privacy, security, and observability rules

Apply these rules to every change in this repository. Treat violations as
blocking findings, even when the changed code otherwise works.

## Privacy and onboarding

- Never log, emit in telemetry, or expose attendee IDs or location data.
- Do not ask for health, political, or identity information during onboarding.
- Collect only the fields required for the current feature and preserve consent
  checks when data is read or written.

## Security

- Never commit secrets. Token-signing keys, Elastic credentials, and Dash0
  tokens must come from Kubernetes Secrets or local environment variables.
- Elasticsearch application code must use the least-privilege
  `companion_svc` account. It must never use the `elastic` superuser.

## Observability

- Every API endpoint must create or continue an OpenTelemetry span.
- Telemetry attributes must be limited to the collector allowlist. Flag any
  new attribute until it is explicitly added to that allowlist.

## Change hygiene

- Keep pull requests small and focused. Flag unrelated refactors, generated
  file churn, and changes that combine independent behavior.
- Require tests or a clear explanation when behavior changes.
