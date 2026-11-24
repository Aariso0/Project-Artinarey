import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendJournal,
  atomicWrite,
  recoverProject,
  withProjectLock,
  writeAllSync,
} from './store.ts';

function tempStore(): string {
  const dir = join(tmpdir(), `artinarey-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('atomicWrite writes the exact content with the requested mode and leaves no temps', () => {
  const dir = tempStore();
  const file = join(dir, 'mail.md');

  atomicWrite(file, 'first', 0o444);
  assert.equal(readFileSync(file, 'utf8'), 'first');
  assert.equal(statSync(file).mode & 0o777, 0o444);
  assert.deepEqual(readdirSync(dir), ['mail.md']);

  atomicWrite(file, 'second', 0o444);
  assert.equal(readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(readdirSync(dir), ['mail.md'], 'overwrite must not leave a temp file');
});

test('appendJournal appends one newline-terminated JSON line', () => {
  const file = join(tempStore(), 'events', 'audit.jsonl');

  appendJournal(file, { id: '1' });
  appendJournal(file, { id: '2' });

  assert.equal(readFileSync(file, 'utf8'), '{"id":"1"}\n{"id":"2"}\n');
});

test('recoverProject trims a torn line, keeps complete lines, and removes stray temps', () => {
  const dir = tempStore();
  const events = join(dir, 'events');
  mkdirSync(events);
  const journal = join(events, 'audit.jsonl');
  writeFileSync(journal, '{"id":"1"}\n{"id":"2"}\n{"id":"tor');
  writeFileSync(join(events, 'tasks.jsonl'), '{"task":"ok"}\n');
  writeFileSync(join(events, 'orphan.jsonl.tmp-abc'), 'half-written');

  const report = recoverProject(dir);

  assert.equal(report.trimmedLines, 1);
  assert.equal(readFileSync(journal, 'utf8'), '{"id":"1"}\n{"id":"2"}\n');
  assert.equal(readFileSync(join(events, 'tasks.jsonl'), 'utf8'), '{"task":"ok"}\n');
  assert.deepEqual(report.removedTemps, ['events/orphan.jsonl.tmp-abc']);
  assert.equal(existsSync(join(events, 'orphan.jsonl.tmp-abc')), false);
});

test('kill -9 mid-write leaves a torn line that startup recovery discards', async () => {
  const dir = tempStore();
  const events = join(dir, 'events');
  mkdirSync(events);
  const journal = join(events, 'audit.jsonl');
  const script = join(dir, 'writer.mjs');
  writeFileSync(script, [
    "import { openSync, writeSync } from 'node:fs';",
    'const fd = openSync(process.argv[2], "a");',
    'writeSync(fd, "{\\"id\\":\\"complete\\"}\\n");',
    'writeSync(fd, "{\\"id\\":\\"tor");',
    'process.stdout.write("READY\\n");',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const child = spawn(process.execPath, [script, journal], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('READY')) resolve();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => reject(new Error(`writer exited before READY: ${code} ${signal}`)));
  });
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL', `writer should be killed, got code=${code}`);

  assert.match(readFileSync(journal, 'utf8'), /\{\"id\":\"complete\"\}\n\{\"id\":\"tor$/);
  const report = recoverProject(dir);
  assert.equal(report.trimmedLines, 1);
  assert.equal(readFileSync(journal, 'utf8'), '{"id":"complete"}\n');
});

test('withProjectLock serialises callers for the same key', async () => {
  const order: number[] = [];
  let active = 0;
  let maxActive = 0;
  const run = (n: number) => withProjectLock('shared', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    order.push(n);
    active--;
  });

  await Promise.all([run(1), run(2), run(3), run(4)]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('withProjectLock allows different keys to proceed in parallel', async () => {
  let active = 0;
  let maxActive = 0;
  const run = (key: string) => withProjectLock(key, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  });

  await Promise.all([run('a'), run('b')]);
  assert.equal(maxActive, 2);
});

test('writeAllSync keeps writing until the whole buffer is committed', () => {
  const written: string[] = [];
  const shortWrite = (_fd: number, buffer: Buffer, offset: number, length: number): number => {
    const chunk = Math.min(2, length);
    written.push(buffer.subarray(offset, offset + chunk).toString());
    return chunk;
  };

  writeAllSync(0, 'abcdef', shortWrite);

  assert.deepEqual(written, ['ab', 'cd', 'ef']);
});

test('writeAllSync rejects a writer that makes no progress', () => {
  assert.throws(() => writeAllSync(0, 'x', () => 0), /no progress/i);
});

test('appendJournal repairs a torn tail before appending', () => {
  const file = join(tempStore(), 'events', 'audit.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"id":"1"}\n{"id":"tor');

  appendJournal(file, { id: '2' });

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line!)), [{ id: '1' }, { id: '2' }]);
});
