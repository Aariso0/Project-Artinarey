import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('workspace declares the three M1 packages', () => {
  for (const [path, name] of [
    ['packages/core/package.json', '@artinarey/core'],
    ['packages/daemon/package.json', '@artinarey/daemon'],
    ['packages/cli/package.json', '@artinarey/cli'],
  ] as const) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    assert.equal(manifest.name, name);
  }
});
