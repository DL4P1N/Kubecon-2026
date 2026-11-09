# Gitar CI-diagnosis evidence audit

Audit date: 2026-11-09. **CI-log diagnosis and auto-apply remain unproven.**
A matching code-review finding is useful evidence, but does not by itself show
that Gitar analyzed a failed CI run.

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

## Documented behavior and follow-up

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

A [read-only retrospective request](https://github.com/DL4P1N/Kubecon-2026/pull/14#issuecomment-6749678468)
asks Gitar to analyze the real PR14 failure and cite evidence, without changing
code, pushing, retrying CI, or enabling auto-apply. No reply had arrived when
this audit was written. Preserve any later response with its timestamp and
label it retrospective; do not rewrite it as original CI diagnosis.

On the next natural failure at the current PR head, capture the actual Gitar
CI-analysis section and run URL before pushing a fix. Do not manufacture a
failure for evidence. Auto-apply stays off: no unresolved low-risk CI fix was
available to approve in the inspected runs. Its documented per-PR command is
`gitar auto-apply:on`; this audit did not send it.
