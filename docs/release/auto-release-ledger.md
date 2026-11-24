# Auto-release execution ledger

Plan: `docs/release/auto-release-plan.md`
Design: `docs/release/auto-release-design.md`
Execution mode: subagent-driven (fresh implementer and reviewer per implementation task, then whole-branch review).

## Starting worktree state

The M7/M8 implementation is already present as uncommitted work across many application files. The auto-release work must not sweep those changes into its commits. Plan task commit steps are therefore **ruled out**: implementers must edit only their assigned files and must not run `git add` or `git commit`. Verification and final handoff remain unchanged.

Plan location was changed from `docs/superpowers/...` to `docs/release/...` at the user's request; no `superpower*` directory is used.

## Pre-flight conflict scan

### Shared files and interfaces

| Tasks | Producer → consumer | Finding / ruling |
|---|---|---|
| Task 1 → Task 2 | `.github/scripts/app-version.cjs` CLI → `version:check` script | Consistent. Task 2 must not run until Task 1's `agree` CLI passes. |
| Task 1 → Task 5 | script tests → full gate set | Consistent. `test:ci` includes `.github/scripts/*.test.cjs`. |
| Task 2 → Task 3 | `version:check`, `read`, `tag` scripts → release workflow | Consistent. Release `prepare` must run `version:check` before deciding to build. |
| Task 2 → Task 4 | version `0.1.0` → README release docs | Consistent. README must name the same version. |
| Task 2 → Task 5 | CI gates → final verification | Consistent. All new scripts must exist before final verification. |
| Task 3 → Task 4 | release behavior → README release section | Consistent. README must describe exactly the implemented triggers, formats, and unsigned platforms. |
| Task 3 → Task 5 | release workflow → syntax/guard greps | Consistent after ruling R2 and R3 below. |
| Task 4 → Task 5 | README stale-claim grep → final verification | Consistent, but Task 4 must also fix stale claims outside the four listed line ranges because its interface says README must match shipped state. |

### Task self-consistency

| Task | Finding / ruling |
|---|---|
| Task 1 | Tests, exported functions, and CLI commands agree. Fixture mutation in `assertVersionsAgree` does not affect later CLI tests because only the GUI manifest changes. |
| Task 2 | Scripts and CI steps agree. Commit step conflicts with pre-existing uncommitted M7/M8 work — see ruling R1. |
| Task 3 | Original `git ls-remote` check was not safe for a private repo with `persist-credentials: false` — see ruling R2. Original raw `bundle/**` upload would attach a macOS `.app` directory as nested files — see ruling R3. |
| Task 4 | Four listed line ranges are too narrow for “README matches shipped state”; implementer must also fix stale M7/later claims elsewhere — see ruling R4. |
| Task 5 | Gate set is complete. Real GitHub Release creation cannot be exercised locally; final report must say so explicitly. |

## Rulings

- **R1 — no commits during auto-release tasks.** Existing M7/M8 work is uncommitted. Implementers must not stage or commit. This overrides every task's commit step.
- **R2 — authenticated tag check.** Replace `git ls-remote --exit-code --tags origin` with `gh api --silent "/repos/${GITHUB_REPOSITORY}/git/ref/tags/${TAG}"` and set `GH_TOKEN` on `prepare`. Plan and verification grep updated.
- **R3 — stage only release files.** Build artifacts must be copied into a flat `release-assets/` directory. macOS `.app` directories must be zipped before upload. Plan updated.
- **R4 — README scope.** Task 4 must remove every stale M7/later, planned, M6-only, and 7-of-9 claim it finds, not just the four listed ranges.
- **R5 — unsigned builds.** Tauri 2 supports `--no-sign`; no signing identities are available, so macOS and Windows bundles are intentionally unsigned. No further user question is needed.
- **R6 — exact tag target.** `gh release create` must pass `--target "$COMMIT"` where `COMMIT` is `github.event.workflow_run.head_sha`. Without it, a new tag can point at a newer `main` commit than the artifacts. Plan and verification grep updated after Task 3 implementer flagged the risk.
- **R7 — final review package.** The standard `review-package` script requires a non-empty commit range. R1 forbids commits, so the final reviewer receives a generated working-tree diff of only the auto-release files plus the plan and ledger paths, written under `/tmp/opencode`, not a new `superpower*` directory.
- **R8 — privacy fix.** The original Task 5 step in the plan named a private validation script. That line was removed from `docs/release/auto-release-plan.md` before final review; the repository privacy command then reported clean. No private path reference remains in `docs/release`, `README.md`, or `.github`.
- **R9 — release serialization.** Add workflow-level `concurrency: group: release` with `cancel-in-progress: false` so two successful CI runs carrying the same version cannot both pass the tag check and build before either creates the tag.
- **R10 — tag-check errors.** The authenticated tag lookup must distinguish HTTP 200 (tag exists) and HTTP 404 (tag absent) from auth, rate-limit, and transient API failures. Non-404 failures must fail `prepare`, not schedule builds.
- **R11 — linked run doc.** Fix `docs/running-and-testing.md` to say M7/M8 desktop window and add `test:ci`, `audit`, and `version:check` to its test gates. This is outside Task 4's original file scope but README links to it.
- **R12 — direct coverage without count churn.** Add direct assertions for `readManifestVersions` and `compare` CLI behavior inside the existing six tests, and restore the fixture after the mismatch test. Do not change the expected test count.
- **Deferred after final review.** Cargo TOML variants (`[package] # comment`, single-quoted versions), a semantically effective `git diff --check`, and Cargo build caching in release bundles are not required for the first `0.1.0` release. The whitespace step is explicitly mandated by the plan; caching is an optimization.

## Task state

| Task | Implementer | Reviewer | Status |
|---|---|---|---|
| 1 — version utility and tests | `ses_df0b66664ffeE1K7qAxj6KIg8p` | `ses_df0b5530effeR0Uh6xIq9NIwx4` | PASS; 2 deferred minors, no must-fix |
| 2 — version fields and CI gates | `ses_df0b472a3ffeCl7cyy9VjP1ctL` | `ses_df0b358faffed6FYJ9klQTPiCW` | PASS; 1 deferred minor in spec (`git diff --check` is a no-op on clean checkout) |
| 3 — GitHub Release workflow | `ses_df0b0033fffe1rGrU4ECqoPPw0` | `ses_df0aec00dffetwK53bAOVt5Uy6` (initial FAIL, re-review PASS) | PASS after one fixer `ses_df0adedfaffeJRc4gYfN0nH0Cy`; `--target` and portable `cp` verified |
| 4 — README current-state docs | `ses_df0ac4857ffe4qFGvPfC2Aabt9` (including follow-up fix) | `ses_df0aa557bffeP0Vt89LF5yGn5S` | PASS; one Should fix applied (CLI or window worktree create/adopt) |
| 5 — whole-branch verification | main session | `ses_df0a56ddcffe9rgOk055a1ILGW` (final), `ses_df09f96cfffefI6WPhOf7Zreda` (scoped re-review) | PASS; final review ready to merge, no Critical/Important issues; fixer `ses_df0a2187cffed5wgKu51st6Mq5` applied R9-R12; scoped re-review found no new breakage |

## Ledger notes

Add one short entry after each dispatch/result: agent session ID, verdict, and any deferred minor or parked issue.

- Task 1: implementer `ses_df0b66664ffeE1K7qAxj6KIg8p`; reviewer `ses_df0b5530effeR0Uh6xIq9NIwx4`; PASS. Deferred minors: `versionTag` hardens/normalizes its argument, and `readManifestVersions` has no direct unit test beyond the agreement test. Both are acceptable; no fix dispatched.
- Task 2: implementer `ses_df0b472a3ffeCl7cyy9VjP1ctL`; reviewer `ses_df0b358faffed6FYJ9klQTPiCW`; PASS. Deferred minor: CI `git diff --check` is a no-op on a clean checkout, but the plan requires it.
- Task 3: implementer `ses_df0b0033fffe1rGrU4ECqoPPw0`; reviewer `ses_df0aec00dffetwK53bAOVt5Uy6` returned FAIL for missing `--target` and BSD-incompatible `cp -t`. One fixer `ses_df0adedfaffeJRc4gYfN0nH0Cy` resolved both; reviewer re-check PASS. No deferred issues.
- Task 4: implementer `ses_df0ac4857ffe4qFGvPfC2Aabt9`; reviewer `ses_df0aa557bffeP0Vt89LF5yGn5S`; PASS after one Should-fix follow-up about worktree creation/adoption in the CLI or window.
- Task 5: final reviewer `ses_df0a56ddcffe9rgOk055a1ILGW` returned Ready to merge with no Critical or Important issues. One fixer `ses_df0a2187cffed5wgKu51st6Mq5` applied R9-R12; scoped re-reviewer `ses_df09f96cfffefI6WPhOf7Zreda` verdict: all findings addressed, no new Critical/Important breakage, no out-of-scope observations. Final affected-file verification passed: `test:ci`, `version:check`, workflow YAML parse, 11 release-guard greps, `git diff --check`, and privacy check.
