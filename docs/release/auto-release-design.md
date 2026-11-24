# Auto-release from package version — short design

## Intent

The README should describe the shipped M7/M8 app and how to run it. CI should enforce the project’s real quality gates. A version bump in the root `package.json` should create a GitHub Release with native Tauri bundles, but only after CI has passed. The first release version is `0.1.0`.

## Goals

- Root `package.json` becomes the single release-version authority at `0.1.0`.
- CI runs typecheck, lint, JS/TS tests, build, GUI bundle build, Rust tests/build, dependency audit, whitespace check, app-version script tests, and version agreement between `package.json`, `apps/gui/package.json`, and the Tauri Cargo manifest.
- After CI succeeds on `main`, a new version with no existing `v<version>` tag creates a GitHub Release and attaches Linux `deb`/`rpm`/`appimage`, unsigned macOS `app`/`dmg`, and unsigned Windows `msi`/`nsis` Tauri bundles.
- README documents current status, run commands, and the release flow.

## Non-goals

- No npm publishing: all npm packages are private and this is a desktop app.
- No redesign of the UI or documentation beyond README accuracy.
- No automatic version bumping; a human or agent edits `package.json`, and the workflow reacts.
- No release if CI fails, if the tag already exists, or if the push is not on `main`.
- Release runs are serialized, and non-404 tag lookup failures stop the release instead of being treated as "tag absent".

## Constraints

- Keep the existing `CI` workflow as the required quality gate. Publishing also requires every other check on the release commit to be green, not just the `CI` workflow conclusion.
- Never put secrets in code or workflow files; use the repository `GITHUB_TOKEN`.
- Release workflow must check out the exact `workflow_run.head_sha`, not the moving `main` ref.
- Tauri builds need system dependencies on Linux and native runners for macOS/Windows bundles.

## Approaches considered

1. **GitHub Release + native bundles (chosen).** Trigger from `workflow_run` after `CI` succeeds on `main`. A small Node script reads and validates the root version; tag existence decides whether a release is needed. Matrix builds Linux `deb`/`rpm`/`appimage`, unsigned macOS `app`/`dmg`, and unsigned Windows `msi`/`nsis`; a final job creates the release and uploads artifacts. Fits a private desktop app and needs no package renaming or npm token.
2. **npm publish.** Rejected: every workspace is private, there is no public package name, and users run a native window, not a library.
3. **Release on every successful `main` push.** Rejected: would produce duplicate releases without a version signal and makes rollback ambiguous.

## Design

### Files

- `package.json`: add `"version": "0.1.0"`; add `audit`, `test:ci`, and `version:check` scripts.
- `apps/gui/package.json`: add `"version": "0.1.0"` so the app package agrees with the root.
- `.github/scripts/app-version.cjs`: read/validate versions, compare semantic versions, and expose CLI helpers.
- `.github/scripts/app-version.test.cjs`: unit tests for valid/invalid versions, comparisons, and version agreement across manifests.
- `.github/workflows/ci.yml`: add audit, whitespace check, version-script test, and manifest-version agreement check; keep existing gates.
- `.github/workflows/release.yml`: `workflow_run` on successful `CI`; a verify job waits for every other check on the commit to settle and refuses to publish on any failure; prepare job checks branch, version, and tag; matrix build jobs produce Tauri bundles; publish job creates `v<version>` GitHub Release with artifacts.
- `README.md`: replace stale M0–M6/planned wording with current M0–M8 status, real quick-start commands, run/test gates, and release behaviour.

### Release decision

`prepare` reads the root version, requires a clean `MAJOR.MINOR.PATCH`, checks that `apps/gui/package.json` and `apps/gui/src-tauri/Cargo.toml` agree, and uses the authenticated GitHub API to check for `refs/tags/v<version>`. If the tag exists, all downstream jobs skip. Otherwise, build matrix artifacts from the CI head SHA, stage only releasable files (zipping macOS `.app` directories), then publish with `gh release create v<version> --target <head-sha> --generate-notes`, attaching all bundle artifacts. The explicit target keeps the tag on the verified commit if `main` moves before publish.

### Check gate

`verify` runs before `prepare` and lists all check-runs for `github.event.workflow_run.head_sha`, excluding check-runs from the current release run so the workflow cannot gate on itself. It also excludes workflow runs triggered by `dependabot[bot]`: those are dependency-update maintenance jobs that can fail for reasons unrelated to the commit (for example `security_update_not_possible`) and must not block a release. Every other check counts: the gate waits while any is queued or in progress, then fails on any conclusion other than `success`, `skipped`, or `neutral`. `prepare`, `bundles`, and `publish` are downstream of this gate, so no version work, build, or upload happens until all CI checks pass. A timeout stops a release whose checks never settle.

### Builder calls made here

- Use a three-OS matrix because “native bundles” means a bundle per supported desktop OS. macOS and Windows are explicitly unsigned with `--no-sign`; no signing identities or notarization credentials are available, and Tauri 2 supports unsigned bundles.
- Use the root `package.json` as authority because the user named `package.json` singularly and the root owns the monorepo.
- Keep releases manual-trigger-free: the version bump itself is the trigger.
- Use `gh` and `GITHUB_TOKEN`; no extra release service.

## Verification

- Run `pnpm audit --audit-level=high` (already clean locally).
- Run `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build`, `pnpm run build:gui`, `pnpm run test:gui`, `pnpm audit --audit-level=high`, `git diff --check`, and the new version script tests locally.
- Validate YAML syntax and workflow wiring by inspection; real GitHub release creation can only be verified after merge with a version bump.
