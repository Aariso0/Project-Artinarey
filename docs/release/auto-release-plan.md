# Auto-release from package version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make root `package.json` version `0.1.0` the release trigger: CI must pass, then a GitHub Release publishes native Tauri bundles for a new version.

**Architecture:** A small CommonJS utility reads and validates versions across root `package.json`, `apps/gui/package.json`, and the Tauri Cargo manifest. CI runs it plus the existing quality gates. A `workflow_run` release workflow waits for CI success on `main`, skips versions that already have a tag, builds bundles on Linux/macOS/Windows from the exact CI head SHA, then creates one GitHub Release with all artifacts.

**Tech Stack:** Node 26, pnpm 10.34.9, GitHub Actions, Tauri 2, Node `node:test`, GitHub CLI (`gh`).

**Spec:** `docs/release/auto-release-design.md`

## Global Constraints

- Root `package.json` is the release-version authority and starts at exactly `0.1.0`.
- `apps/gui/package.json` and `apps/gui/src-tauri/Cargo.toml` must agree with the root version.
- No npm publishing; all npm packages stay private.
- Release only when CI completed with `conclusion == success` on `main` from a push to this repository.
- Release only when `refs/tags/v<version>` does not exist.
- Check out `github.event.workflow_run.head_sha`; never release from a moving `main` ref.
- Use `GITHUB_TOKEN` only; no secrets or credentials in workflow files.
- Required local/CI gates: typecheck, lint, JS/TS tests, script tests, build, GUI build, Rust tests/build, dependency audit, whitespace check, version agreement.

## Review Focus

- A successful CI run on a feature branch must not publish — release workflow branch guard.
- A fork pull request whose branch is named `main` must not publish — workflow_run event and head-repository guards.
- A failed CI run must not publish — `workflow_run` conclusion guard.
- An existing `v<version>` tag must skip — tag check in `prepare`.
- Mismatched manifests must fail before any build/publish — `pnpm run version:check` in CI and release `prepare`.
- Invalid semver such as `1.2`, `v1.2.3`, or `1.2.3-beta` must fail — version utility tests.
- Release assets must include Linux `deb`, `rpm`, `appimage`, macOS unsigned `app`/`dmg`, and Windows unsigned `msi`/`nsis` — bundle-command checks in Task 3.

---

### Task 1: Version utility and tests

**Files:**
- Create: `.github/scripts/app-version.cjs`
- Create: `.github/scripts/app-version.test.cjs`

**Interfaces:**
- Consumes: Node built-ins `node:fs`, `node:os`, `node:path`, `node:test`, `node:assert/strict`, `node:child_process`.
- Produces:
  - `normalizeVersion(value: string): string` — accepts only `MAJOR.MINOR.PATCH`, throws on anything else.
  - `readAppVersion(root?: string): string`
  - `readManifestVersions(root?: string): { root: string; gui: string; cargo: string }`
  - `assertVersionsAgree(root?: string): void`
  - `compareVersions(a: string, b: string): -1 | 0 | 1`
  - `versionTag(version: string): string` — returns `v${version}`.
  - CLI: `node .github/scripts/app-version.cjs <read|agree|tag|compare A B>`; `read` and `tag` print one bare line, `agree`/`compare` exit non-zero on failure.

- [ ] **Step 1: Write failing tests in `.github/scripts/app-version.test.cjs`**

Use `node:test` and `node:assert/strict`. Build a temp fixture with `mkdtempSync(join(tmpdir(), 'artinarey-version-'))` containing `package.json` (`{"version":"0.1.0"}`), `apps/gui/package.json` (`{"version":"0.1.0"}`), and `apps/gui/src-tauri/Cargo.toml` with `version = "0.1.0"` under `[package]`. Remove it in `after()`.

Required tests and assertions:

```js
test('readAppVersion reads the canonical root version', () => {
  assert.equal(readAppVersion(fixture), '0.1.0');
});

test('normalizeVersion rejects non-semver values', () => {
  for (const value of ['1.2', 'v1.2.3', '1.2.3-beta', ' 1.2.3 ']) {
    assert.throws(() => normalizeVersion(value), /invalid version/);
  }
  assert.equal(normalizeVersion(' 1.2.3'), '1.2.3');
});

test('assertVersionsAgree passes only when all manifests match', () => {
  assert.doesNotThrow(() => assertVersionsAgree(fixture));
  writeFileSync(join(fixture, 'apps/gui/package.json'), '{"version":"0.1.2"}');
  assert.throws(() => assertVersionsAgree(fixture), /version mismatch/);
});

test('compareVersions orders numeric semver components', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});

test('versionTag formats the release tag', () => {
  assert.equal(versionTag('0.1.0'), 'v0.1.0');
});

test('CLI read and tag print one bare line', () => {
  const read = execFileSync(process.execPath, [script, 'read'], { cwd: fixture, encoding: 'utf8' });
  const tag = execFileSync(process.execPath, [script, 'tag'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(read, '0.1.0\n');
  assert.equal(tag, 'v0.1.0\n');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .github/scripts/app-version.test.cjs`
Expected: FAIL because `.github/scripts/app-version.cjs` does not exist.

- [ ] **Step 3: Implement `.github/scripts/app-version.cjs`**

Export the functions listed in Interfaces. `normalizeVersion` must trim leading whitespace only, require `/^\d+\.\d+\.\d+$/`, and throw `Error('invalid version: <value>')`. `readManifestVersions` reads root `package.json`, `apps/gui/package.json`, and the first `version = "..."` line under `[package]` in `apps/gui/src-tauri/Cargo.toml`. `assertVersionsAgree` must throw `Error('version mismatch: ...')` naming the disagreeing manifest. `compareVersions` splits on `.`, converts to numbers, and compares major/minor/patch in order. The CLI must print only the requested value on stdout and exit non-zero on thrown errors.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .github/scripts/app-version.test.cjs`
Expected: PASS with 6 tests.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/app-version.cjs .github/scripts/app-version.test.cjs
git commit -m "ci: add app version utility and tests"
```

### Task 2: Version fields and CI gates

**Files:**
- Modify: `package.json:1-12`
- Modify: `apps/gui/package.json:1-8`
- Modify: `.github/workflows/ci.yml:12-30`

**Interfaces:**
- Consumes: Task 1 CLI `read`, `agree`.
- Produces: `pnpm run version:check`, `pnpm run audit`, `pnpm run test:ci`, all used by CI and release workflow.

- [ ] **Step 1: Add versions and scripts**

In root `package.json`, add `"version": "0.1.0"` after `"name"`, and add scripts:

```json
"audit": "pnpm audit --audit-level=high",
"test:ci": "node --import tsx --test 'packages/*/src/*.test.ts' 'apps/gui/src/*.test.ts' && node --test .github/scripts/*.test.cjs",
"version:check": "node .github/scripts/app-version.cjs agree"
```

In `apps/gui/package.json`, add `"version": "0.1.0"` after `"name"`.

- [ ] **Step 2: Tighten `.github/workflows/ci.yml` node job**

Replace the `pnpm test` step with `pnpm run test:ci`. Add steps after `pnpm build`:

```yaml
      - run: pnpm run audit
      - run: pnpm run version:check
```

Also add a named whitespace step that runs `git diff --check "$base"...HEAD`, where `$base` is the pull request base SHA or the push `before` SHA (falling back to the pushed branch's base ref for a new branch). Set `fetch-depth: 0` on the checkout so that commit is available; a bare `git diff --check` on a clean checkout examines nothing. Keep the existing pnpm setup, Node 26 setup, typecheck, lint, build, and `build:gui` steps unchanged. Keep the Rust job unchanged.

- [ ] **Step 3: Verify version agreement and CI scripts locally**

Run: `pnpm run version:check`
Expected: exits 0.

Run: `pnpm run test:ci`
Expected: all JS/TS tests and all `.github/scripts/*.test.cjs` tests pass.

Run: `pnpm run audit`
Expected: `No known vulnerabilities found`.

- [ ] **Step 4: Commit**

```bash
git add package.json apps/gui/package.json .github/workflows/ci.yml
git commit -m "ci: enforce version agreement and quality gates"
```

### Task 3: GitHub Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: CI workflow name `CI`, Task 2 scripts `version:check`, version utility CLI.
- Produces: tag `v<version>`, GitHub Release titled `Artinarey <version>`, assets from `apps/gui/src-tauri/target/release/bundle/`.

- [ ] **Step 1: Write the workflow skeleton**

Set `name: Release` and:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
```

Top-level `permissions: contents: read`. Add workflow-level `concurrency: group: release` with `cancel-in-progress: false` and `queue: max` so same-version release runs are serialized and up to 100 runs can wait without a later run replacing an earlier pending one. Define jobs `prepare`, `bundles`, `publish` in that order.

- [ ] **Step 2: Implement `prepare`**

Guard with:

```yaml
if: >-
  github.event.workflow_run.conclusion == 'success' &&
  github.event.workflow_run.head_branch == 'main' &&
  github.event.workflow_run.event == 'push' &&
  github.event.workflow_run.head_repository.full_name == github.repository
```

Check out `ref: ${{ github.event.workflow_run.head_sha }}` with `persist-credentials: false`, set up pnpm/Node 26, install with `--frozen-lockfile`, run `pnpm run version:check`, and set outputs `version`, `tag`, `should_release`. Set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` on the job and use the authenticated GitHub API for the tag check so the workflow also works for a private repository with no persisted git credentials:

```bash
VERSION="$(node .github/scripts/app-version.cjs read)"
TAG="$(node .github/scripts/app-version.cjs tag)"
tag_response="$(gh api --include --silent "/repos/${GITHUB_REPOSITORY}/git/ref/tags/${TAG}" 2>&1 || true)"
status_line="$(printf '%s\n' "$tag_response" | grep -m1 -E '^HTTP/[0-9.]+ [0-9]{3}' || true)"
case "$status_line" in
  *" 200"*)
    echo "should_release=false" >> "$GITHUB_OUTPUT"
    ;;
  *" 404"*)
    echo "should_release=true" >> "$GITHUB_OUTPUT"
    ;;
  *)
    printf '%s\n' "$tag_response" >&2
    exit 1
    ;;
esac
echo "version=$VERSION" >> "$GITHUB_OUTPUT"
echo "tag=$TAG" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Implement `bundles` matrix**

`needs: prepare`, guarded by `needs.prepare.outputs.should_release == 'true'`. Matrix include: `ubuntu-latest`/`linux`, `macos-latest`/`macos`, `windows-latest`/`windows`. On each runner: check out the CI head SHA, set up pnpm/Node 26/Rust stable, install system Tauri dependencies only on Linux (same package list as `ci.yml`), run `pnpm run build:gui`, then build bundles from `apps/gui` with platform-specific flags:

| Platform | Command |
|---|---|
| Linux | `pnpm exec tauri build --bundles deb rpm appimage --ci` |
| macOS | `pnpm exec tauri build --bundles app dmg --no-sign --ci` |
| Windows | `pnpm exec tauri build --bundles msi nsis --no-sign --ci` |

Stage only releasable files in a flat `release-assets/` directory, then upload that directory as artifact `bundles-<platform>` with `actions/upload-artifact@v4`. On macOS, zip each `.app` bundle before staging it: GitHub Releases attach files, not directory trees, and uploading a raw `.app` directory would attach hundreds of nested resources as separate assets. macOS and Windows builds are unsigned because no signing identities or notarization credentials are available; that is a deliberate release constraint, not a CI failure.

- [ ] **Step 4: Implement `publish`**

`needs: [prepare, bundles]`, guarded by the same `should_release == 'true'`. Override job permissions to `contents: write`. Check out the CI head SHA, download all `bundles-*` artifacts with `actions/download-artifact@v4` into `bundles` using `merge-multiple: true`, then create one release:

```bash
mapfile -d '' assets < <(find bundles -type f -print0)
if [ "${#assets[@]}" -eq 0 ]; then
  echo "no release assets found" >&2
  exit 1
fi
gh release create "$TAG" "${assets[@]}" \
  --target "$COMMIT" \
  --title "Artinarey $VERSION" \
  --generate-notes
```

Set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `TAG`/`VERSION` from `needs.prepare.outputs`, and `COMMIT: ${{ github.event.workflow_run.head_sha }}`. `--target` is required so the tag points to the exact CI commit even if `main` advances before publish.

- [ ] **Step 5: Validate workflow syntax**

Run:

```bash
python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/release.yml
python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/ci.yml
grep -F "github.event.workflow_run.conclusion == 'success'" .github/workflows/release.yml
grep -F "github.event.workflow_run.head_branch == 'main'" .github/workflows/release.yml
grep -F 'gh api --silent' .github/workflows/release.yml
grep -F 'pnpm run version:check' .github/workflows/ci.yml
grep -F -- '--bundles deb rpm appimage --ci' .github/workflows/release.yml
grep -F -- '--bundles app dmg --no-sign --ci' .github/workflows/release.yml
grep -F -- '--bundles msi nsis --no-sign --ci' .github/workflows/release.yml
grep -F 'zip -qr' .github/workflows/release.yml
grep -F -- '--target "$COMMIT"' .github/workflows/release.yml
grep -F 'group: release' .github/workflows/release.yml
grep -F 'queue: max' .github/workflows/release.yml
grep -F "github.event.workflow_run.event == 'push'" .github/workflows/release.yml
grep -F 'github.event.workflow_run.head_repository.full_name == github.repository' .github/workflows/release.yml
grep -F 'status_line' .github/workflows/release.yml
```

Expected: all commands exit 0; the fourteen greps each print at least one matching line. These pin the failed-CI, non-main, push-only, same-repository, authenticated existing-tag check, manifest-agreement, bundle-format, macOS `.app` packaging, exact-commit tag, serialized/queued release, and tag-status guards without creating a real release locally.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish GitHub release on version change"
```

### Task 4: README current-state and run/release docs

**Files:**
- Modify: `README.md:11-18`, `README.md:22-36`, `README.md:143-166`, `README.md:166-220`

**Interfaces:**
- Consumes: Task 2 scripts, Task 3 release behaviour.
- Produces: README that matches the shipped app and does not call features planned.

- [ ] **Step 1: Update status and contents**

Change the status badge to `M0--M8%20implemented`. Replace the stale blockquote with one sentence covering M0–M8 implemented, two-agent mail verified, worktree lifecycle smoke-tested, full desktop window shipped, crash/offline Move, and the isolated model adapter. Add `Running the app` and `Releases` to Contents.

- [ ] **Step 2: Replace “Quick start (planned)” with real quick start**

Use actual commands:

```bash
pnpm install
node packages/cli/bin/artinarey init
node packages/cli/bin/artinarey daemon start
cd apps/gui
pnpm exec vite
# second terminal
pnpm exec tauri dev
```

Document optional adapter env vars (`ARTINAREY_MODEL_BASE_URL`, `ARTINAREY_MODEL_MODEL`, `ARTINAREY_MODEL_KEY`) and note the key stays in the adapter.

- [ ] **Step 3: Replace the M6 read-only window section**

Describe the M7/M8 window: Projects, Personas, Worktrees, Mail, Chat, Tasks, Sessions, Approvals, Pre-merge, Audit, Storage/Move, in-app dialogs, pitch-black UI, and webview-only `daemon_call`.

- [ ] **Step 4: Add Releases section**

State: root `package.json` version is canonical; current version `0.1.0`; pushing a new version to `main` after CI passes creates `v<version>` and attaches Linux `deb`/`rpm`/`appimage`, unsigned macOS `app`/`dmg`, and unsigned Windows `msi`/`nsis`; existing tags are skipped; no npm publish.

- [ ] **Step 5: Verify README has no stale claims**

Run:

```bash
grep -n -E 'M0--M6|Quick start \(planned\)|M6, read-only|M7/later' README.md
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: update README for M7/M8 and releases"
```

### Task 5: Whole-branch verification

**Files:**
- No source changes.

**Interfaces:**
- Consumes: all earlier tasks.

- [ ] **Step 1: Run full local gate set**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run test:ci
pnpm build
pnpm run build:gui
pnpm run test:gui
pnpm run audit
pnpm run version:check
git diff --check
```

Expected: every command exits 0; `pnpm test` reports 371 passing JS/TS tests, `pnpm run test:ci` also passes the 6 version tests, and `pnpm run test:gui` reports 19 passing Rust tests.

- [ ] **Step 2: Final handoff**

Report the exact commands run and their results. Do not claim a real GitHub Release was verified locally; say the first release is created by pushing version `0.1.0` to `main` after CI passes.
