const assert = require('node:assert/strict');
const test = require('node:test');
const {
  notificationMarker,
  hasNotificationMarker,
} = require('./dependabot-completion-notify.cjs');
const { parseDependencyUpdates } = require('./dependabot-completion-notify.cjs');
const { buildComment } = require('./dependabot-completion-notify.cjs');
const { main } = require('./dependabot-completion-notify.cjs');

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

test('main skips a non-pull_request CI run', async () => {
  const h = harness({ run: { event: 'push' } });
  await main(h);
  assert.equal(h.calls.comments, 0);
});

test('main skips a CI run from another repository', async () => {
  const h = harness({ run: { head_repository: { id: 999 } } });
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
