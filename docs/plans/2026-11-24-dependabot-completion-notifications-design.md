# Dependabot PR Completion Notifications — Design

## Intent

Notify `@Aariso0` with a readable, deterministic PR comment whenever a Dependabot PR targeting `main` has passed the repository's CI. The notification is information only: it must not approve, merge, label, or otherwise modify Dependabot PRs.

## Goals

- Trigger from the existing `CI` workflow completion, treating its successful conclusion as the source of truth for required checks.
- Only handle Dependabot-authored, open PRs whose base is `main` and whose head SHA matches the triggering CI run.
- Summarize dependency names, old/new versions, patch/minor/major classification, update count, changed files, CI status, and useful text from the Dependabot description.
- Deduplicate per head SHA; allow a fresh notification after Dependabot pushes new commits.
- Use only the built-in `GITHUB_TOKEN` with least-privilege permissions.
- Never check out or execute Dependabot PR code in the privileged workflow.

## Non-goals / anti-goals

- No approval, merge, rebase, label, or automatic remediation of Dependabot PRs.
- No modification of the existing CI workflow or application source.
- No paid AI API or external service.
- No reliance on a formal branch-protection required-check list: `main` currently has no branch protection.

## Constraints

- Repository default branch is `main`.
- Existing CI: `.github/workflows/ci.yml`, name `CI`, single job `node`, steps typecheck → lint → test, triggered by `push` and `pull_request` on `main`/`MO/**`.
- Dependabot config: `.github/dependabot.yml`, ecosystems `github-actions` and `npm`, weekly.
- Existing docs live under `docs/plans/`; do not create `docs/superpowers/`.
- Treat GitHub-provided text as untrusted data; parse it deterministically and cap its size in the comment.

## Approaches considered

1. **`workflow_run` on CI completion (chosen).** Runs in the base repository context with a write-capable token, never checks out PR code, and uses the actual CI workflow result. Slightly more API work to resolve the PR and metadata.
2. **`check_run` / `check_suite` completion.** More granular, but brittle against check-name changes and offers no benefit with a single CI job.
3. **`pull_request` close/merge events.** Wrong timing: the requested notification is CI completion, not merge.

## Decisions

- Add a dedicated workflow `.github/workflows/dependabot-completion-notify.yml`.
- Trigger: `workflow_run` for workflow named `CI`, `types: [completed]`, gated on `conclusion == 'success'` and `event == 'pull_request'`.
- Validate: PR author is `dependabot[bot]`, PR state is `open`, base ref is `main`, head SHA equals the triggering run's head SHA, and head repository is this repository.
- Permissions: workflow-level `contents: read`, `checks: read`, `pull-requests: write`. Checkout is limited to the base `main` ref for loading the trusted helper module; no Dependabot PR code is checked out or executed. No secrets beyond `GITHUB_TOKEN`.
- Use `actions/github-script@v9` with the pre-authenticated Octokit client for all API calls.
- Resolve PRs from `workflow_run.pull_requests`, with a fallback `pulls.list` by head branch filtered by head SHA.
- Parse dependency data from the PR title and body: single-dependency `Bumps [name] from old to new`, grouped Dependabot tables, and title fallback. Prefer Dependabot's `Type` column when present; otherwise compute patch/minor/major from version strings.
- List changed files via `pulls.listFiles` and include path plus additions/deletions.
- List completed checks via `checks.listForSuite` on the triggering run's `check_suite_id` and include each check name plus conclusion.
- Include a trimmed, sanitized excerpt of the Dependabot description and any changelog/compare URLs found in it.
- Deduplicate with a hidden marker `<!-- dependabot-ci-success:<head-sha> -->`; before commenting, paginate issue comments and skip if the marker exists.
- Add workflow/job concurrency keyed by PR head SHA with `cancel-in-progress: false` so duplicate `workflow_run` events for the same SHA are serialized and dedupe is reliable.
- Add `docs/dependabot-completion-notifications.md` documenting trigger conditions, permissions, dedupe behavior, and manual test steps.

## Left to the implementer

- Exact YAML structure, script implementation, and validation commands.
- Confirm workflow YAML parses and expressions/permissions are correct.
- Report manual GitHub settings (notably branch protection / required checks) without changing them.
