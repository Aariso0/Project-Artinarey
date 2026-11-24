const assert = require('node:assert/strict');
const test = require('node:test');
const {
  notificationMarker,
  hasNotificationMarker,
} = require('./dependabot-completion-notify.cjs');
const { parseDependencyUpdates } = require('./dependabot-completion-notify.cjs');
const { buildComment } = require('./dependabot-completion-notify.cjs');

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
