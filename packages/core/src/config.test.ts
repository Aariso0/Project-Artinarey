import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { loadConfig } from './config.ts';

function tempConfigFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'artinarey-config-'));
  const file = join(dir, 'config.json');
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

test('loadConfig returns defaults when the file is missing', () => {
  const cfg = loadConfig(tempConfigFile());

  assert.equal(cfg.dataRoot, '', 'empty override means use the XDG default');
  assert.equal(cfg.spawnCap, 3);
});

test('loadConfig merges a valid partial config over defaults', () => {
  const file = tempConfigFile(JSON.stringify({ dataRoot: '/mnt/big/artinarey' }));
  const cfg = loadConfig(file);

  assert.equal(cfg.dataRoot, '/mnt/big/artinarey');
  assert.equal(cfg.spawnCap, 3, 'unspecified fields keep their defaults');
});

test('loadConfig rejects invalid JSON with a typed error', () => {
  const file = tempConfigFile('{ this is not json');

  assert.throws(
    () => loadConfig(file),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'INVALID_INPUT',
  );
});
