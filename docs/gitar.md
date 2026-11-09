# Gitar setup and CI-failure diagnosis

Gitar reviews pull requests and reads the repository guidance in
`.gitar/review/`. The rules for this project are in
`.gitar/review/conference-companion.md`; update that file when a durable
review rule is needed. These are code-review instructions, distinct from
repository rules in `.gitar/rules/`. The explicit project check is
`.gitar/rules/conference-companion-check.md`: Markdown with YAML frontmatter
(`title`, `description`, `type`, `when`, `actions`). It references the canonical
guidance rather than replacing it. `.gitar/config/apply.md` limits auto-apply
and is read from the default branch after merge.

References: [repository customization](https://docs.gitar.ai/configuration/repository-config),
[repository rules](https://docs.gitar.ai/features/rules).

## One-time administrator setup

1. Sign in at [Gitar](https://app.gitar.ai/) using an account with GitHub
   organization or repository admin access.
2. Install the Gitar GitHub App and grant it access to `DL4P1N/Kubecon-2026`.
3. Confirm the repository is enabled in the Gitar dashboard.
4. Verify repository-rule access on the organization's plan. Rules require
   Pro or Enterprise; configuration files alone cannot enable a paid feature.
5. Configure organization-level auto-apply criteria, then keep the stricter
   repository criteria in `.gitar/config/apply.md`. Leave per-PR auto-apply
   opt-in enabled.

No credentials, GitHub App private keys, or tokens belong in this repository.

Functional validation is a separate Enterprise feature, controlled by
**Settings → Configuration → Behavior → Validate PRs against linked issues**.
It checks linked GitHub issues against the diff; it does not execute tests.
See [functional validation](https://docs.gitar.ai/features/functional-validation).
Board task numbers are not GitHub issue links. CI-failure diagnosis is also
separate from Rules and must have its own observed failure-analysis evidence.
For GitHub Actions, the existing code-host connection supplies CI-log access;
there is no separate CI connection required. Auto-apply remains a separate
per-PR opt-in. See [CI-failure analysis](https://docs.gitar.ai/features/ci-failure-analysis).

## Verifying repository-rule execution

Four focused checks in `.gitar/rules/` extend the original project check:
`aggregate-privacy.md` (attendee k>=5), `public-endpoint-protection.md`
(rate limits and safe caching), `identifier-exposure.md` (response/log/trace
minimization), and `telemetry-allowlist-sync.md` (code, docs and both collectors).
They include necessary exceptions for catalog counts, authorized credential
issuance and existing allowlisted keys. Each also applies to edits to itself,
so its first PR can prove configuration evaluation without claiming runtime
compliance. These are review checks; they grant no automatic write/merge rights.
Verified on [PR55's dashboard](https://github.com/DL4P1N/Kubecon-2026/pull/55#issuecomment-6750358094):
"Rules 5/5 met", "5 passed", with all four new names and the original project
check listed. The earlier head listed only three new checks; explicitly naming
the aggregate rule's path in its trigger made that check run on the next head.
This is configuration evaluation on that PR, not proof of runtime enforcement.

On a PR that contains the rule, inspect Verification → Rules. Request
`gitar display:verbose` to see rule applicability and evidence. Record the
actual dashboard link and outcome in `docs/track-evidence.md`; neither a
green Gitar status check nor an ordinary review proves rule execution.

## Pull-request workflow

Open a small PR and wait for the `gitar-bot` dashboard comment. Review inline
findings and its CI-failure diagnosis before merging. For an approved,
low-risk fix, opt in on that PR using the command shown in the Gitar dashboard
comment (commonly `gitar auto-apply:on`), then verify the resulting commit and
all CI checks. Use an explicit comment to `@gitar-bot` for a requested fix
rather than granting broad write access.

Gitar's first review link should be recorded in `docs/track-evidence.md`.
If the bot does not comment, the administrator should verify the GitHub App's
repository access and the workspace seat/plan in the Gitar dashboard.
