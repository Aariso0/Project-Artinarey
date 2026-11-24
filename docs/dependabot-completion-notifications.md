# Dependabot PR completion notifications

This repository posts a detailed comment on a Dependabot pull request after its CI has succeeded. The comment explicitly mentions `@Aariso0` so GitHub sends a notification.

## What triggers it

The automation is defined in [`.github/workflows/dependabot-completion-notify.yml`](../.github/workflows/dependabot-completion-notify.yml).

It runs on the `workflow_run` `completed` event for the existing [`CI`](../.github/workflows/ci.yml) workflow, but only when:

- `github.event.workflow_run.conclusion == 'success'`
- `github.event.workflow_run.event == 'pull_request'`
- the PR author is `dependabot[bot]`
- the PR base branch is `main`
- the PR is open
- the CI run's head SHA still matches the PR's current head SHA
- the CI run came from this repository, not a fork

Failed, cancelled, skipped, timed-out, and non-`pull_request` runs produce no comment. The workflow never approves, merges, rebases, labels, or otherwise modifies the PR.

## Why `workflow_run`

`CI` is the source of truth. Its `node` job runs `pnpm typecheck`, `pnpm lint`, and `pnpm test`. Reading the completed `workflow_run` avoids duplicating those steps and keeps the privileged notification workflow out of the Dependabot PR's code.

`main` currently has no branch protection, so GitHub has no formal required-check list configured. Treat a successful `CI / node` run as the completion signal. See **Manual settings** below if you want this enforced by branch protection.

## Required permissions

The workflow uses only the built-in `GITHUB_TOKEN` with least-privilege permissions:

| Permission | Why |
| --- | --- |
| `contents: read` | Check out the trusted `main` ref to load the helper module. |
| `checks: read` | List completed check runs for the triggering CI check suite. |
| `pull-requests: write` | Create one comment on the PR. |

No personal access token or other secret is used. Unspecified permissions are implicitly `none`.

## Security model

- There is no `pull_request_target` event in the new workflow.
- Checkout uses `ref: main` with `persist-credentials: false`.
- The workflow does not check out, import, build, or execute Dependabot PR code. It reads PR metadata through the GitHub API and renders it with deterministic local JavaScript.
- PR titles, bodies, file names, file paths, check names, and URLs are treated as untrusted data. HTML tags and `<details>` blocks are stripped from the displayed excerpt, Markdown metacharacters and `@` mentions are escaped, the excerpt is capped, and at most three URLs are included.
- The only repository write is `issues.createComment` on the PR.

## What the comment contains

The generated comment includes:

- hidden dedupe marker for the exact head SHA
- explicit `@Aariso0` mention
- PR title, number, and link
- dependency names with previous and updated versions
- patch/minor/major classification and dependency count
- changed files with insertion/deletion counts
- CI status and completed checks
- a sanitized excerpt and relevant links from Dependabot's description
- a concise overall summary

Versions are classified from explicit Dependabot table types when available, otherwise from semantic version components. Grouped Dependabot updates are supported. The dependency table shows up to 50 rows and reports any omitted count so the comment stays readable. Changelog and compare URLs are extracted from the raw Dependabot body, including links inside `<details>` blocks.

## Duplicate handling

Each comment contains a hidden marker:

```text
<!-- dependabot-ci-success:<head-sha> -->
```

Before posting, the workflow lists existing PR comments and skips if that exact marker is already present. Workflow concurrency is keyed by head SHA with `cancel-in-progress: false`, so retried or duplicate `workflow_run` events for the same SHA are serialized and cannot race past the marker check.

If Dependabot pushes new commits, the PR has a new head SHA, so a new successful CI run posts a new notification.

## Files

| File | Purpose |
| --- | --- |
| `.github/workflows/dependabot-completion-notify.yml` | Trusted `workflow_run` workflow and permissions. |
| `.github/scripts/dependabot-completion-notify.cjs` | Deterministic parsing, validation, dedupe, and comment rendering. |
| `.github/scripts/dependabot-completion-notify.test.cjs` | Node test suite for helpers and orchestration. |
| `docs/dependabot-completion-notifications.md` | This document. |
| `README.md` | Status badge fix; unrelated to the automation behavior. |

## How to test

1. Confirm the workflow and helper are on `main`.
2. Open or wait for a Dependabot PR targeting `main` that changes npm or GitHub Actions dependencies.
3. Let `CI` finish successfully.
4. Confirm exactly one comment is posted and that it mentions `@Aariso0`.
5. Re-run the `CI` workflow for the same commit. Confirm no second comment appears.
6. Push another commit to the same Dependabot branch, wait for `CI` to succeed, and confirm a new comment appears with the new head SHA marker.
7. Force a CI failure on a Dependabot PR and confirm no success comment is posted.

Local verification:

```bash
node --test .github/scripts/dependabot-completion-notify.test.cjs
python3 -c "import yaml, pathlib; yaml.safe_load(pathlib.Path('.github/workflows/dependabot-completion-notify.yml').read_text())"
```

## Manual settings to review

`main` is not currently protected. If you want GitHub to require this signal before merge, add a branch protection rule for `main` requiring the `CI / node` status check. This implementation does not change branch protection, approve PRs, or merge them.
