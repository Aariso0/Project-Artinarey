import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
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

test('buildIndex stores frontmatter cc and queryMail matches cc recipients', async () => {
  const store = tempDir('artinarey-index-store');
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  const record = await sendMail(store, {
    from: 'dev-a', to: ['senior-dev'], cc: ['dev-b', 'senior-dev'],
    subject: 'cc mail', kind: 'status', action: 'review', body: 'body',
  }, {
    knownPersonas: ['dev-a', 'senior-dev', 'dev-b'],
    role: 'dev-a',
    now: new Date('2026-11-23T10:15:00Z'),
  });

  buildIndex(indexFile, store);

  const mails = queryMail(indexFile);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0]?.cc, ['dev-b', 'senior-dev']);
  assert.deepEqual(queryMail(indexFile, { recipient: 'dev-b' }).map((m) => m.id), [record.id]);
  assert.deepEqual(queryMail(indexFile, { recipient: 'senior-dev' }).map((m) => m.id), [record.id]);
});

test('buildIndex migrates an existing index that has no cc_json column', async () => {
  const store = tempDir('artinarey-index-store');
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  await sendMail(store, {
    from: 'dev-a', to: ['senior-dev'], cc: ['dev-b', 'senior-dev'],
    subject: 'legacy', kind: 'status', action: 'review', body: 'body',
  }, {
    knownPersonas: ['dev-a', 'senior-dev', 'dev-b'],
    role: 'dev-a',
    now: new Date('2026-11-23T10:15:00Z'),
  });
  const legacy = new Database(indexFile);
  legacy.exec(`CREATE TABLE mail (
    id TEXT PRIMARY KEY, thread TEXT NOT NULL, from_id TEXT NOT NULL,
    to_json TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL, file TEXT NOT NULL
  )`);
  legacy.close();

  buildIndex(indexFile, store);

  const raw = new Database(indexFile, { readonly: true });
  const columns = raw.pragma('table_info(mail)') as Array<{ name: string }>;
  assert.equal(columns.some((c) => c.name === 'cc_json'), true);
  raw.close();
  assert.deepEqual(queryMail(indexFile)[0]?.cc, ['dev-b', 'senior-dev']);
});

test('queryMail reads a populated legacy mail table without cc_json', () => {
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  const legacy = new Database(indexFile);
  legacy.exec(`CREATE TABLE mail (
    id TEXT PRIMARY KEY, thread TEXT NOT NULL, from_id TEXT NOT NULL,
    to_json TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL, file TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO mail
    (id, thread, from_id, to_json, subject, kind, created_at, file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-id', 'legacy-thread', 'dev-a', '["senior-dev"]', 'legacy subject', 'status',
    '2026-11-23T10:15:00Z', '/store/mail/2026/11/legacy-id.md',
  );
  legacy.close();

  // No buildIndex: the derived index may still be in its pre-cc_json shape.
  assert.deepEqual(queryMail(indexFile), [{
    id: 'legacy-id', thread: 'legacy-thread', from: 'dev-a',
    to: ['senior-dev'], cc: [], subject: 'legacy subject', kind: 'status',
    createdAt: '2026-11-23T10:15:00Z', file: '/store/mail/2026/11/legacy-id.md',
  }]);
  assert.deepEqual(queryMail(indexFile, { recipient: 'senior-dev' }).map((m) => m.id),
    ['legacy-id']);
});

test('a read failure mid-rebuild rolls back the whole index rebuild', async () => {
  const store = tempDir('artinarey-index-store');
  const ids = await seedThree(store);
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  buildIndex(indexFile, store);

  // Turn the first mail file into a directory: it passes the file filter but fails
  // on read before any replacement row is inserted.
  const first = join(store, 'mail', '2026', '11', `${[...ids].sort()[0]}.md`);
  unlinkSync(first);
  mkdirSync(first);
  assert.throws(() => buildIndex(indexFile, store));

  assert.deepEqual(queryMail(indexFile).map((m) => m.id), [...ids].sort());
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

test('buildIndex preserves commas inside quoted frontmatter recipients', () => {
  const store = tempDir('artinarey-index-store');
  const indexFile = join(tempDir('artinarey-index-cache'), 'index.sqlite');
  const id = newId();
  const file = join(store, 'mail', '2026', '11', `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    '---',
    `id: ${id}`,
    `thread: ${id}`,
    'from: dev-a',
    'to: ["dev,a"]',
    'cc: []',
    'subject: comma role',
    'kind: status',
    'created_at: 2026-11-23T10:15:00Z',
    '---',
    'body',
    '',
  ].join('\n'));

  buildIndex(indexFile, store);

  assert.deepEqual(queryMail(indexFile)[0]?.to, ['dev,a']);
  assert.deepEqual(queryMail(indexFile, { recipient: 'dev,a' }).map((m) => m.id), [id]);
});
