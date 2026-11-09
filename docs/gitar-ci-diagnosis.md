# Gitar CI-diagnosis evidence audit

Audit date: 2026-11-09. **CI-log access and explicitly requested retrospective
diagnosis are now verified. Automatic CI-failure triggering and auto-apply
remain unproven.** A matching code-review finding alone is not diagnosis proof.

## Verified diagnosis after an explicit request on an open PR

A read-only [request on open PR39](https://github.com/DL4P1N/Kubecon-2026/pull/39#issuecomment-6749839603)
linked the real failed [Accessibility run 42686153504](https://github.com/DL4P1N/Kubecon-2026/actions/runs/42686153504)
from PR23 at commit `b9544e57`. At 19:52:17 UTC,
[Gitar returned a substantive diagnosis](https://github.com/DL4P1N/Kubecon-2026/pull/39#issuecomment-6749861362)
and said, “Logs were fully accessible via `gh run view --log-failed`.”

- Failed job/step: `axe`, `npm run test:a11y -w web`; 16/17 tests passed.
- Failure: the keyboard-only registration test at
  `web/e2e/accessibility.pw.ts:92` expected the Kubernetes checkbox to be focused.
- Diagnosis: the test pressed Tab after the heading/main were ready, before
  asynchronous topic checkboxes were ready. Gitar inspected the log, source,
  and already-applied fix.
- Fix: [d7282fbb](https://github.com/DL4P1N/Kubecon-2026/commit/d7282fbbf959fe6d7db2a7265c31becfe9985c6d)
  waits for the topic checkbox to be visible before pressing Tab.
- Recovery independently checked: [the fixed-head Accessibility run](https://github.com/DL4P1N/Kubecon-2026/actions/runs/42687055796)
  succeeded; Gitar, build-test, and Docker checks also passed on that head.

This verifies actual log reading and diagnosis through an explicit comment.
The fix predates the request: it was authored by the teammate, not applied by
Gitar. No code changes, pushes, job retries, permission changes, or auto-apply
were requested or performed for this diagnosis.

Gitar also speculated that an OTLP proxy connection refusal indicated backend
availability trouble. A collector refusal does not establish that the topic
API was unavailable; this audit relies on the readiness race, source fix, and
green rerun rather than that extra causal claim.

The repo owner reported through the board that automatic reviews run and the
documented automatic-processing toggle is not visible in their dashboard.
The owner uses a personal GitHub account; its installation path is
`github.com/settings/installations` → Gitar → Configure. The successful log
read resolves the access uncertainty without changing permissions. The
installation's pending-warning UI was not inspected by this agent.

## Real failures inspected

| PR | Actual failed run | Observed failure | Retained Gitar evidence |
| --- | --- | --- | --- |
| [#14](https://github.com/DL4P1N/Kubecon-2026/pull/14) | [CI run 42679520614](https://github.com/DL4P1N/Kubecon-2026/actions/runs/42679520614), commit `1aac90d` | Docker web build could not resolve `../../../data/nav-replay.json?raw` from `NavDemo.tsx` | [Inline finding](https://github.com/DL4P1N/Kubecon-2026/pull/14#discussion_r4516757221) explains the missing fixture COPY; dashboard labels it **Code Review**. No separate CI-analysis section is retained. |
| [#22](https://github.com/DL4P1N/Kubecon-2026/pull/22) | [Accessibility run 42681287637](https://github.com/DL4P1N/Kubecon-2026/actions/runs/42681287637), commit `5d41e6f` | Schedule checks at 375px and 1280px timed out waiting for `Kubernetes security`; the new session gate required test-session setup | [Dashboard](https://github.com/DL4P1N/Kubecon-2026/pull/22#issuecomment-6749256330) has an approved Code Review but no retained CI-analysis section. |

The original PR14 inline finding was posted at **19:03:33 UTC**; the failure
log reports the missing import at **19:03:43 UTC**. The finding therefore
predates the observed failure and cannot be presented as proof of reading that
failed run's logs. The actual fix is
[commit b8abad9](https://github.com/DL4P1N/Kubecon-2026/commit/b8abad977d223d31fce3527057afdf7294db2cd7)
(copy the fixture into the image and expose the build flag); its
[subsequent CI run](https://github.com/DL4P1N/Kubecon-2026/actions/runs/42680891662)
succeeded. This proves an acted-on review finding and real CI recovery.

PR32's runtime-dependency fix was also inspected. Its
[Gitar dashboard](https://github.com/DL4P1N/Kubecon-2026/pull/32#issuecomment-6749557579)
reviews the fix and new smoke check; it does not show a failed CI diagnosis.
The issue occurred in the deployed container, not in one of the two failed
Actions runs found by this audit.

For the two failed commits, the Gitar check-run `output.summary` and
`output.text` were empty. Current issue comments, inline review comments,
review timestamps, check-run output, and real failed Actions logs were checked.
GitHub's current comment API does not provide the historical bodies of edited
dashboard comments, so the audit cannot prove whether a transient analysis
was ever shown.

## Documented behavior and initial follow-up

The official [CI analysis documentation](https://docs.gitar.ai/features/ci-failure-analysis)
says GitHub Actions logs use the code-host connection without another CI
credential. Analysis is automatic for PR failures, and events for superseded
commits are ignored. That latter rule could explain missed historical events,
but the actual reason in this installation is not established.

The [organization settings](https://docs.gitar.ai/configuration/settings)
include **Settings → Configuration → Behavior → Disable automatic processing**,
with repository overrides. This affects automatic CI analysis as well as
reviews; it is different from auto-apply and from retrying unrelated failures.
There is no separate GitHub Actions “enable CI diagnosis” toggle documented on
these pages.

The [GitHub connection guide](https://docs.gitar.ai/connecting-code/github)
documents **GitHub organization Settings → Installed GitHub Apps → Gitar →
Configure** for repository access. Actions/Checks/Workflows permissions enable
log access. An admin was asked on board question #15 to confirm these states
and any access warnings. Credentials were not requested. Regular reviews
already work; missing Actions access is a hypothesis, not an observed fact.

Follow-up checks: the repository reports `push: true`, `admin: false` for this
CLI account. Installation-administration endpoints reject this credential.
The Gitar App metadata attached to
[the original check run](https://api.github.com/repos/DL4P1N/Kubecon-2026/check-runs/129369968026)
declares `actions`, `checks`, `workflows`, and `statuses` write permissions;
this describes the App's declared permissions, not a verified inspection of
the installation's effective grant or pending permission warnings. Gitar also
reviewed this audit PR automatically, which is evidence that automatic review
processing is active for it. The organization and repository override controls
still require an authenticated administrator to inspect directly.

A [read-only retrospective request](https://github.com/DL4P1N/Kubecon-2026/pull/14#issuecomment-6749678468)
asks Gitar to analyze the real PR14 failure and cite evidence, without changing
code, pushing, retrying CI, or enabling auto-apply. Its
[bot response](https://github.com/DL4P1N/Kubecon-2026/pull/14#issuecomment-6749702226)
only says “No push was confirmed in this run” and suggests checking the branch;
it provides no CI root cause or log analysis. This is not diagnosis evidence,
and does not establish why historical analysis is absent. Preserve any later
substantive response as retrospective, not original CI diagnosis.

To verify automatic triggering on a future natural failure at the current PR head, capture the actual Gitar
CI-analysis section and run URL before pushing a fix. Do not manufacture a
failure for evidence. Auto-apply stays off: no unresolved low-risk CI fix was
available to approve in the inspected runs. Its documented per-PR command is
`gitar auto-apply:on`; this audit did not send it.
