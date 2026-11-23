import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from './report.ts';

test('whoami report carries cwd, argv and env names', () => {
  const report = buildReport();
  assert.match(report.cwd, /^\//, 'cwd must be an absolute path');
  assert.ok(report.argv.length >= 2, 'argv must be present');
  assert.ok(report.envNames.includes('PATH'), 'env var names must be collected');
});
