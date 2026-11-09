# Evidence audit snapshot

Scope: README and the evidence ledger, 2026-11-09. This is a documentation
consistency audit, not a new live service test. The
[real/pending table](track-evidence.md#whats-real-vs-pending) is the entry point.
Initial repository base: `1201c4952a44dac745b0352e2f41e448488b6303`;
refreshed after merging subsequent main evidence updates.

## Checks performed

- Checked every relative Markdown link and heading fragment in README and
  `docs/`: 20 Markdown files, 80 local links, zero missing destinations or
  anchors. Fenced code examples
  and external URLs were excluded from that local filesystem check.
- Queried GitHub PR metadata for the referenced implementation/evidence PRs;
  distinguished merged changes from open report/fix work. Verified the
  historical fix commit and committed Radar/video artifacts with `git cat-file`.
- Read the actual operator search report on
  [PR27 comment 6749696162](https://github.com/DL4P1N/Kubecon-2026/pull/27#issuecomment-6749696162),
  rather than treating the original hypothetical query tables as measurements.
- Corrected the historical Gitar fix reference: task #25's code fix was
  [PR8](https://github.com/DL4P1N/Kubecon-2026/pull/8), not the later rules PR25.
  Removed stale claims that signed schedule/access work and retention were
  still waiting for implementation.

## Evidence boundaries retained

The live search evaluation has five hybrid wins and seven ties over twelve
questions, not a majority win. The current mean reciprocal rank and hit-rate
numbers are linked to the full measured source. Publication of the updated
comparison document landed through [PR40](https://github.com/DL4P1N/Kubecon-2026/pull/40).
The [full report](demo/search-eval-report.md) now exists in the repository;
the evaluator merged separately.

The [Radar verdict](demo/radar-ai-investigation.json),
[screenshot](demo/radar-ai-investigation.png) and
[operator verification](demo/radar-ml-verification.json) exist in the repository.
The operator-local Radar run URL is convenient replay only, not a publicly
reachable artifact. Initial ES diagnosis and the later AI investigation are
credited separately, and the injected outage is labelled controlled.

Dash0 code, the collector probe and in-memory privacy tests do not substitute
for actual browser/API/ES trace, dashboard or SLO screenshots. Board task #40's
additional raw URL/path findings remain open at this snapshot. The TLS overlay
is merged but its live rollout/browser trust result is still pending.

The [offline recording](demo/recording.md) is visibly disclosed mock UI, not
live token, search or telemetry evidence. The live attendee recording remains
a separate acceptance item.

Gitar repository-rule execution and acted-on findings are documented with
actual review links. The [updated specific CI audit](gitar-ci-diagnosis.md)
records a later explicitly requested retrospective diagnosis with log analysis
and a verified readiness-race explanation. Automatic triggering and auto-apply
remain unproven, and the teammate's fix predates that request. Functional
validation is not enabled. No Sonar tooling integration is claimed.

External operator-only endpoints and future screenshot filenames were not
treated as portable working links. Pending artifacts must be added and the
snapshot refreshed after live checks; this audit does not certify future
changes or every third-party website's availability.
