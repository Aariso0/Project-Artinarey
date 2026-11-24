# Dependabot PR Completion Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post one deterministic, detailed `@Aariso0` notification on a Dependabot PR targeting `main` after the existing `CI` workflow succeeds for that PR's exact head SHA.

**Architecture:** A trusted `workflow_run` workflow reacts to the existing `CI` workflow's completion. It checks out only `main` to load a helper module (never Dependabot PR code), validates the PR author/base/head/event, then uses `GITHUB_TOKEN` APIs to read PR metadata, files, check runs, and comments before posting a comment with a hidden per-SHA dedupe marker.

**Tech Stack:** GitHub Actions `workflow_run`, `actions/checkout@v4`, `actions/github-script@v9`, CommonJS Node module, `node:test`, PyYAML for workflow syntax validation.

**Spec:** `docs/plans/2026-11-24-dependabot-completion-notifications-design.md`

## Global Constraints

- Default branch is `main`; PRs targeting any other branch are ignored.
- Existing CI is the source of truth: `.github/workflows/ci.yml`, name `CI`, job `node`, steps typecheck → lint → test. Do not modify it.
- Dependabot config: `.github/dependabot.yml`, ecosystems `github-actions` and `npm`, weekly. Do not modify it.
- Use only the built-in `GITHUB_TOKEN`. Workflow permissions are exactly `contents: read`, `checks: read`, `pull-requests: write`; no other permissions.
- Never check out, require, or execute Dependabot PR code in the privileged workflow. Checkout is `ref: main` with `persist-credentials: false`.
- No `pull_request_target` event anywhere in the new workflow.
- No paid AI API, external service, or network call except GitHub APIs.
- No approval, merge, rebase, label, or other modification of Dependabot PRs; the only write is creating one PR comment.
- Docs and plans live under `docs/plans/`. Do not create `docs/superpowers/`.
- Treat all GitHub-provided text as untrusted data; strip HTML, cap excerpt length, and never evaluate it.

## Review Focus

- Non-Dependabot author, non-`main` base, closed PR, or head SHA mismatch → no comment. Test: `main` validation skip cases in Task 2.
- CI failure/cancelled/skipped or non-`pull_request` workflow_run → no comment. Test: workflow gate plus `main` conclusion/event skip in Tasks 2–3.
- Duplicate `workflow_run` events or CI reruns for the same head SHA → exactly one comment. Test: existing-marker skip in Task 2 and concurrency declaration in Task 3.
- Dependabot pushes new commits to the same PR → new head SHA gets a new comment. Test: different-SHA marker acceptance in Task 2.
- Grouped/multi-dependency Dependabot bodies and odd version strings → correct dependency count/classification and no crash. Test: grouped-table parsing in Task 1.

---

### Task 1: Pure notification helpers

**Files:**
- Create: `.github/scripts/dependabot-completion-notify.cjs`
- Test: `.github/scripts/dependabot-completion-notify.test.cjs`

**Interfaces:**
- Consumes: plain PR metadata, PR body text, changed-file list, check-run list, workflow-run metadata.
- Produces:
  - `notificationMarker(sha: string): string`
  - `hasNotificationMarker(comments: Array<{ body?: string }>, sha: string): boolean`
  - `classifyUpdate(from: string, to: string): 'major' | 'minor' | 'patch' | 'unknown'`
  - `parseDependencyUpdates(input: { title: string; body: string }): Array<{ name: string; from: string; to: string; classification: 'major' | 'minor' | 'patch' | 'unknown' }>`
  - `buildComment(input: { pr: { title: string; number: number; html_url: string }; updates: ReturnType<typeof parseDependencyUpdates>; files: Array<{ filename: string; additions: number; deletions: number }>; checks: Array<{ name: string; conclusion: string | null }>; run: { html_url: string; head_sha: string }; description: string }): string`

- [ ] **Step 1: Write failing tests for marker helpers**

In `.github/scripts/dependabot-completion-notify.test.cjs`, add:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  notificationMarker,
  hasNotificationMarker,
} = require('./dependabot-completion-notify.cjs');

test('notification marker is keyed by head SHA', () => {
  assert.equal(
    notificationMarker('abc123'),
    '<!-- dependabot-ci-success:abc123 -->',
  );
});

test('hasNotificationMarker matches only the same SHA', () => {
  const comments = [{ body: 'old\n<!-- dependabot-ci-success:abc123 -->' }];
  assert.equal(hasNotificationMarker(comments, 'abc123'), true);
  assert.equal(hasNotificationMarker(comments, 'def456'), false);
  assert.equal(hasNotificationMarker([{ body: null }], 'abc123'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Implement marker helpers and version classification**

In `.github/scripts/dependabot-completion-notify.cjs`, export `notificationMarker`, `hasNotificationMarker`, and `classifyUpdate`. Normalize versions by stripping leading `v`, `^`, `~`, whitespace, and taking leading numeric components split on `.`/`-`/`+`. Compare major, then minor, then patch; return `unknown` when a comparison is impossible.

- [ ] **Step 4: Write failing tests for `parseDependencyUpdates`**

Add to the same test file:

```js
const { parseDependencyUpdates } = require('./dependabot-completion-notify.cjs');

test('parses a single GitHub Actions update', () => {
  const updates = parseDependencyUpdates({
    title: 'chore(deps): bump actions/checkout from 4 to 7',
    body: 'Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 7.',
  });
  assert.deepEqual(updates, [{
    name: 'actions/checkout', from: '4', to: '7', classification: 'major',
  }]);
});

test('parses a grouped Dependabot table with explicit types', () => {
  const body = [
    'Bumps the npm group with 3 updates:',
    '| Package | From | To | Type |',
    '| --- | --- | --- | --- |',
    '| [axios](https://github.com/axios/axios) | `1.2.3` | `1.3.0` | minor |',
    '| [left-pad](https://github.com/stevemao/left-pad) | `1.3.0` | `1.3.1` | patch |',
    '| [typescript](https://github.com/microsoft/TypeScript) | `5.0.0` | `6.0.0` | major |',
  ].join('\n');
  const updates = parseDependencyUpdates({
    title: 'chore(deps): bump the npm group with 3 updates',
    body,
  });
  assert.deepEqual(updates.map((u) => u.classification), ['minor', 'patch', 'major']);
  assert.deepEqual(updates.map((u) => u.name), ['axios', 'left-pad', 'typescript']);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: FAIL because `parseDependencyUpdates` is not exported.

- [ ] **Step 6: Implement `parseDependencyUpdates`**

In `.github/scripts/dependabot-completion-notify.cjs`, parse in this order: (1) Dependabot markdown table rows with `Package`, `From`, `To`, `Type` columns; (2) `Bumps [name](url) from old to new.`; (3) title fallback `bump <name> from <old> to <new>`. Prefer a table `Type` cell when it is `patch`, `minor`, or `major`; otherwise call `classifyUpdate`. Deduplicate by `name` and preserve first-seen order.

- [ ] **Step 7: Write failing test for `buildComment`**

Add:

```js
const { buildComment } = require('./dependabot-completion-notify.cjs');

test('buildComment includes every required section and the dedupe marker', () => {
  const body = buildComment({
    pr: {
      title: 'chore(deps): bump actions/checkout from 4 to 7',
      number: 4,
      html_url: 'https://github.com/Aariso0/Project-Artinarey/pull/4',
    },
    updates: [{ name: 'actions/checkout', from: '4', to: '7', classification: 'major' }],
    files: [{ filename: '.github/workflows/ci.yml', additions: 1, deletions: 1 }],
    checks: [{ name: 'node', conclusion: 'success' }],
    run: { html_url: 'https://github.com/Aariso0/Project-Artinarey/actions/runs/1', head_sha: 'abc123' },
    description: 'Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 7.\n<h2>v7.0.0</h2>\n<details><p>hidden</p></details>',
  });
  assert.match(body, /<!-- dependabot-ci-success:abc123 -->/);
  assert.match(body, /@Aariso0/);
  assert.match(body, /\*\*Dependabot Update Completed\*\*/);
  assert.match(body, /actions\/checkout/);
  assert.match(body, /\| 4 \| 7 \| major \|/);
  assert.match(body, /\.github\/workflows\/ci\.yml/);
  assert.match(body, /node.*success/s);
  assert.match(body, /### Summary/);
  assert.doesNotMatch(body, /hidden/);
  assert.ok(body.length < 5000, 'comment must stay readable');
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: FAIL because `buildComment` is not exported.

- [ ] **Step 9: Implement `buildComment`**

In `.github/scripts/dependabot-completion-notify.cjs`, build a Markdown comment with exactly these sections: hidden marker, `@Aariso0`, `**Dependabot Update Completed**`, PR title/number/link, dependency table, dependency count and classification roll-up, changed files with `+/-`, CI status and check list, a trimmed sanitized `### From Dependabot` excerpt with changelog URLs, and a concise `### Summary`. Strip `<details>...</details>` blocks and tags from the description; cap the excerpt at 1200 characters and include at most 3 URLs.

- [ ] **Step 10: Run all Task 1 tests**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add .github/scripts/dependabot-completion-notify.cjs .github/scripts/dependabot-completion-notify.test.cjs
git commit -m "feat(actions): add deterministic Dependabot notification helpers"
```

---

### Task 2: Orchestration, validation, and dedupe

**Files:**
- Modify: `.github/scripts/dependabot-completion-notify.cjs`
- Test: `.github/scripts/dependabot-completion-notify.test.cjs`

**Interfaces:**
- Consumes: exports from Task 1.
- Produces: `async function main({ github, context, core }): Promise<void>` exported from the same module.

- [ ] **Step 1: Write failing tests for skip conditions and successful post**

Add a mock harness to the test file. The mock `github` must expose `paginate`, `rest.pulls.get`, `rest.pulls.list`, `rest.pulls.listFiles`, `rest.issues.listComments`, `rest.issues.createComment`, and `rest.checks.listForSuite`. `context` must expose `repo` and `payload.workflow_run`.

```js
const { main } = require('./dependabot-completion-notify.cjs');

function harness(overrides = {}) {
  const run = {
    conclusion: 'success',
    event: 'pull_request',
    head_sha: 'abc123',
    head_branch: 'dependabot/github_actions/actions-checkout-7',
    head_repository: { id: 123 },
    check_suite_id: 99,
    html_url: 'https://github.com/Aariso0/Project-Artinarey/actions/runs/1',
    pull_requests: [{ number: 4, head: { sha: 'abc123' }, base: { ref: 'main' } }],
    ...overrides.run,
  };
  const pr = {
    number: 4,
    state: 'open',
    title: 'chore(deps): bump actions/checkout from 4 to 7',
    html_url: 'https://github.com/Aariso0/Project-Artinarey/pull/4',
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main' },
    head: { sha: 'abc123' },
    body: 'Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 7.',
    ...overrides.pr,
  };
  const calls = { comments: 0, bodies: [], infos: [] };
  const github = {
    paginate: async (fn, params) => {
      const result = await fn(params);
      return Array.isArray(result) ? result : result.data;
    },
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        list: async () => ({ data: [] }),
        listFiles: async () => ({ data: [{ filename: '.github/workflows/ci.yml', additions: 1, deletions: 1 }] }),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async ({ body }) => { calls.comments++; calls.bodies.push(body); },
      },
      checks: {
        listForSuite: async () => ({ data: [{ name: 'node', conclusion: 'success' }] }),
      },
    },
  };
  const context = {
    repo: { owner: 'Aariso0', repo: 'Project-Artinarey' },
    payload: { repository: { id: 123 }, workflow_run: run },
  };
  const core = {
    info: (msg) => calls.infos.push(msg),
    warning: () => {},
    setFailed: (msg) => { throw new Error(msg); },
  };
  return { github, context, core, calls, pr };
}

test('main posts one comment for a valid successful Dependabot PR', async () => {
  const h = harness();
  await main(h);
  assert.equal(h.calls.comments, 1);
  assert.match(h.calls.bodies[0], /@Aariso0/);
  assert.match(h.calls.bodies[0], /<!-- dependabot-ci-success:abc123 -->/);
});

test('main skips a failed CI conclusion', async () => {
  const h = harness({ run: { conclusion: 'failure' } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips non-Dependabot authors', async () => {
  const h = harness({ pr: { user: { login: 'human' } } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips a PR whose base is not main', async () => {
  const h = harness({ pr: { base: { ref: 'release' } } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips a closed PR', async () => {
  const h = harness({ pr: { state: 'closed' } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips a head SHA mismatch', async () => {
  const h = harness({ run: { head_sha: 'newsha' }, pr: { head: { sha: 'oldsha' } } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips when a comment already contains the same SHA marker', async () => {
  const h = harness();
  h.github.rest.issues.listComments = async () => ({
    data: [{ body: '<!-- dependabot-ci-success:abc123 -->' }],
  });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main posts again for a new head SHA on the same PR', async () => {
  const h = harness();
  h.github.rest.issues.listComments = async () => ({
    data: [{ body: '<!-- dependabot-ci-success:oldsha -->' }],
  });
  await main(h);
  assert.equal(h.calls.comments, 1);
});

test('main falls back to pulls.list when workflow_run.pull_requests is empty', async () => {
  const h = harness({ run: { pull_requests: [] } });
  h.github.rest.pulls.list = async () => ({
    data: [{ number: 4, head: { sha: 'abc123' }, base: { ref: 'main' } }],
  });
  await main(h);
  assert.equal(h.calls.comments, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: FAIL because `main` is not exported.

- [ ] **Step 3: Implement `main`**

In `.github/scripts/dependabot-completion-notify.cjs`, implement `main` in this order: read `context.payload.workflow_run`; skip unless `conclusion === 'success'` and `event === 'pull_request'`; skip if `head_repository.id` is present and differs from `context.payload.repository.id`; resolve the PR from `workflow_run.pull_requests` filtered by matching head SHA and base `main`, falling back to `github.paginate(github.rest.pulls.list, { head: `${owner}:${run.head_branch}`, state: 'open' })` filtered by head SHA; fetch full PR via `pulls.get`; skip unless `user.login === 'dependabot[bot]'`, `base.ref === 'main'`, `state === 'open'`, and `head.sha === run.head_sha`; skip if `hasNotificationMarker(await github.paginate(github.rest.issues.listComments, ...), run.head_sha)`; otherwise merge file and check lists, call `parseDependencyUpdates` and `buildComment`, then `issues.createComment` once. Use `core.info` for every skip and success path; never call `core.setFailed` for a skip.

- [ ] **Step 4: Run all tests**

Run: `node --test .github/scripts/dependabot-completion-notify.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/dependabot-completion-notify.cjs .github/scripts/dependabot-completion-notify.test.cjs
git commit -m "feat(actions): validate and dedupe Dependabot notifications"
```

---

### Task 3: Workflow wiring

**Files:**
- Create: `.github/workflows/dependabot-completion-notify.yml`

**Interfaces:**
- Consumes: `.github/scripts/dependabot-completion-notify.cjs` from Task 2.
- Produces: a GitHub Actions workflow that calls `main`.

- [ ] **Step 1: Write a failing workflow contract check**

Create no new test file. Add the check inline in the verification step below; first run it against the missing workflow to confirm failure.

- [ ] **Step 2: Run the contract check to verify it fails**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/dependabot-completion-notify.yml')
assert p.exists(), 'workflow file missing'
PY
```

Expected: FAIL with `workflow file missing`.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/dependabot-completion-notify.yml` with:

```yaml
name: Dependabot completion notification

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

permissions:
  contents: read
  checks: read
  pull-requests: write

concurrency:
  group: dependabot-notify-${{ github.event.workflow_run.head_sha }}
  cancel-in-progress: false

jobs:
  notify:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - name: Check out trusted base ref for helper module
        uses: actions/checkout@v4
        with:
          ref: main
          persist-credentials: false
      - name: Notify Dependabot PR
        uses: actions/github-script@v9
        with:
          script: |
            const { main } = require('./.github/scripts/dependabot-completion-notify.cjs')
            await main({ github, context, core })
```

- [ ] **Step 4: Validate YAML syntax and contract**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import yaml
p = Path('.github/workflows/dependabot-completion-notify.yml')
data = yaml.safe_load(p.read_text())
assert data[True]['workflow_run']['workflows'] == ['CI']
assert data[True]['workflow_run']['types'] == ['completed']
assert data['permissions'] == {'contents': 'read', 'checks': 'read', 'pull-requests': 'write'}
assert 'pull_request_target' not in p.read_text()
assert "${{ github.event.workflow_run.conclusion == 'success' }}" in p.read_text()
assert 'dependabot-notify-${{ github.event.workflow_run.head_sha }}' in p.read_text()
assert 'ref: main' in p.read_text()
assert 'persist-credentials: false' in p.read_text()
assert "const { main } = require('./.github/scripts/dependabot-completion-notify.cjs')" in p.read_text()
assert 'await main({ github, context, core })' in p.read_text()
print('workflow contract OK')
PY
```

Expected: prints `workflow contract OK`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/dependabot-completion-notify.yml
git commit -m "feat(actions): notify on successful Dependabot CI runs"
```

---

### Task 4: Documentation, README badge fix, and final verification

**Files:**
- Create: `docs/dependabot-completion-notifications.md`
- Modify: `README.md:11`

**Interfaces:**
- Consumes: behavior implemented in Tasks 1–3.
- Produces: operator documentation and a working status badge.

- [ ] **Step 1: Write documentation**

Create `docs/dependabot-completion-notifications.md` covering:
- trigger: `CI` workflow `completed` with `conclusion: success`, `event: pull_request`;
- author/base validation: `dependabot[bot]`, base `main`, head SHA match, same repository, open PR;
- permissions: `contents: read`, `checks: read`, `pull-requests: write`, why each is needed, and that no secrets beyond `GITHUB_TOKEN` are used;
- security: no PR code checked out or executed; checkout is `ref: main`; no `pull_request_target`;
- dedupe: hidden marker per head SHA, new SHA posts again, failed/cancelled runs post nothing;
- manual test procedure: open one Dependabot PR, let CI pass, confirm one comment; re-run CI and confirm no duplicate; push a new commit to the Dependabot branch and confirm a new comment;
- manual settings: `main` has no branch protection, so configure a required `CI / node` status check if desired; no changes made to branch protection.

- [ ] **Step 2: Fix the malformed README status badge**

`README.md:11` currently uses `status-M0-M3%20implemented`, where the literal hyphen splits the Shields.io badge into too many segments and renders `404 | badge not found`. Change it to:

```markdown
![status](https://img.shields.io/badge/status-M0--M3%20implemented-2ea043?labelColor=0d1117)
```

- [ ] **Step 3: Verify the badge renders**

Run:

```bash
curl -sS 'https://img.shields.io/badge/status-M0--M3%20implemented-2ea043?labelColor=0d1117' | rg -q 'M0-M3 implemented' && echo 'README badge OK'
```

Expected: prints `README badge OK`.

- [ ] **Step 4: Run final checks**

Run:

```bash
node --test .github/scripts/dependabot-completion-notify.test.cjs
python3 -c "import yaml, pathlib; yaml.safe_load(pathlib.Path('.github/workflows/dependabot-completion-notify.yml').read_text())"
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all commands pass; application tests remain 229/229.

- [ ] **Step 5: Commit**

```bash
git add docs/dependabot-completion-notifications.md README.md
git commit -m "docs: document Dependabot completion notifications and fix status badge"
```
