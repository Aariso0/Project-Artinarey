import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from './ids.ts';
import { buildIndex, queryMail, type IndexedMail } from './index-builder.ts';
import { sendMail } from './mail.ts';

function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${newId()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function seedThree(store: string): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, subject] of ['one', 'two', 'three'].entries()) {
    const record = await sendMail(store, {
      from: 'dev-a',
      to: ['senior-dev'],
      subject,
      kind: 'status',
      action: `review ${subject}`,
      body: `body ${subject}`,
    }, {
      knownPersonas: ['dev-a', 'senior-dev'],
      role: 'dev-a',
      now: new Date(Date.UTC(2026, 10, 23, 10, i, 0)),
    });
    ids.push(record.id);
  }
  return ids;
}

test('buildIndex indexes mail files ordered by id and skips malformed files', async () => {
  const store = tempDir('artinarey-index-store');
  const ids = await seedThree(store);
  const bad = join(store, 'mail', '2026', '11', `${newId()}.md`);
  writeFileSync(bad, 'this is not a mail file');

  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  const report = buildIndex(indexFile, store);

  assert.equal(report.indexed, 3);
  assert.equal(report.skipped, 1);

  const mails = queryMail(indexFile);
  assert.deepEqual(mails.map((m: IndexedMail) => m.id), [...ids].sort());
  assert.deepEqual(mails[0]!.to, ['senior-dev']);
  assert.equal(mails[0]!.from, 'dev-a');
  assert.equal(mails[0]!.kind, 'status');
});

test('a deleted mail file disappears after rebuild; the files remain the source of truth', async () => {
  const store = tempDir('artinarey-index-store');
  const ids = await seedThree(store);
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');

  buildIndex(indexFile, store);
  assert.equal(queryMail(indexFile).length, 3);

  unlinkSync(join(store, 'mail', '2026', '11', `${ids[1]}.md`));
  const report = buildIndex(indexFile, store);

  assert.equal(report.indexed, 2);
  assert.equal(report.skipped, 0);
  assert.deepEqual(queryMail(indexFile).map((m) => m.id), [ids[0], ids[2]].sort());
});

test('queryMail filters by recipient and thread', async () => {
  const store = tempDir('artinarey-index-store');
  await seedThree(store);
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  buildIndex(indexFile, store);

  assert.equal(queryMail(indexFile, { recipient: 'senior-dev' }).length, 3);
  assert.equal(queryMail(indexFile, { recipient: 'nobody' }).length, 0);
  assert.equal(queryMail(indexFile, { limit: 2 }).length, 2);
});
