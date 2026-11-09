# Gitar setup and CI-failure diagnosis

Gitar reviews pull requests and reads the repository guidance in
`.gitar/review/`. The rules for this project are in
`.gitar/review/conference-companion.md`; update that file when a durable
review rule is needed.

## One-time administrator setup

1. Sign in at [Gitar](https://app.gitar.ai/) using an account with GitHub
   organization or repository admin access.
2. Install the Gitar GitHub App and grant it access to `DL4P1N/Kubecon-2026`.
3. Confirm the repository is enabled in the Gitar dashboard.
4. In Gitar **Settings → Configuration**, enable CI-failure diagnosis. It
   automatically classifies failures as change-related, flaky, or
   infrastructure-related when a pull request has CI results.
5. Configure organization-level auto-apply criteria, then keep the stricter
   repository criteria in `.gitar/config/apply.md`. Leave per-PR auto-apply
   opt-in enabled.

No credentials, GitHub App private keys, or tokens belong in this repository.

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
