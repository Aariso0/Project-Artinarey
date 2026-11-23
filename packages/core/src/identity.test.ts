import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMarker, writeMarker } from './identity.ts';

function tempRoot(): string {
  const dir = join(tmpdir(), `artinarey-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('writeMarker writes an ids-only marker with exact JSON shape', () => {
  const dir = tempRoot();
  writeMarker(dir, '01PROJECT', '01WORKTREE');

  assert.equal(
    readFileSync(join(dir, '.artinarey.json'), 'utf8'),
    '{"schema":1,"project_id":"01PROJECT","worktree_id":"01WORKTREE"}',
  );
});

test('findMarker walks up from a nested directory', () => {
  const root = tempRoot();
  writeMarker(root, '01PROJECT', '01WORKTREE');
  const nested = join(root, 'src', 'deep');
  mkdirSync(nested, { recursive: true });

  const found = findMarker(nested);
  assert.equal(found?.dir, root);
  assert.deepEqual(found?.marker, { schema: 1, project_id: '01PROJECT', worktree_id: '01WORKTREE' });
});

test('findMarker returns undefined when no valid marker exists', () => {
  const root = tempRoot();
  assert.equal(findMarker(root), undefined);

  writeFileSync(join(root, '.artinarey.json'), 'not json');
  assert.equal(findMarker(root), undefined);
});
