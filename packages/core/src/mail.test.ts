import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { isUlid, newId } from './ids.ts';
import {
  sendMail,
  serializeMail,
  validateMail,
  type MailContext,
  type MailInput,
} from './mail.ts';
import { recoverProject } from './store.ts';

const ctx: MailContext = {
  knownPersonas: ['dev-a', 'dev-b', 'senior-dev'],
  role: 'dev-a',
  now: new Date('2026-11-23T10:15:00Z'),
};

const base: MailInput = {
  from: 'dev-a',
  to: ['senior-dev'],
  subject: 'Login endpoint done',
  kind: 'status',
  action: 'Review branch artinarey/auth-api, 2 min',
  body: 'ACTION: Review.\n\nDone: endpoint.',
};

function rejectionReason(input: MailInput, context: MailContext = ctx): string {
  const result = validateMail(input, context);
  assert.equal(result.ok, false, 'expected validation to reject this mail');
  return result.ok ? '' : result.reason;
}

function tempStore(): string {
  const dir = join(tmpdir(), `artinarey-mail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('validateMail names each missing required field', () => {
  assert.match(rejectionReason({ ...base, subject: '' }), /subject/);
  assert.match(rejectionReason({ ...base, action: '' }), /action/);
  assert.match(rejectionReason({ ...base, body: '' }), /body/);
  assert.match(rejectionReason({ ...base, kind: undefined as never }), /kind/);
});

test('validateMail rejects a body over 8 KB', () => {
  assert.match(rejectionReason({ ...base, body: 'x'.repeat(8193) }), /8 KB|8192/);
});

test('validateMail rejects secret-shaped lines', () => {
  assert.match(rejectionReason({ ...base, body: 'API_KEY=abc123' }), /secret/i);
  assert.match(rejectionReason({ ...base, body: '-----BEGIN RSA PRIVATE KEY-----' }), /secret/i);
});

test('validateMail rejects unknown recipients and all broadcast forms', () => {
  assert.match(rejectionReason({ ...base, to: ['ghost'] }), /ghost/);
  assert.match(rejectionReason({ ...base, to: [] }), /broadcast|recipient/i);
  for (const to of [['*'], ['all'], ['@all']]) {
    assert.match(rejectionReason({ ...base, to }), /broadcast|wildcard/i);
  }
});

test('validateMail applies the settled role rules', () => {
  // everyone may mail the senior dev and the user
  assert.equal(validateMail({ ...base, to: ['user'] }, ctx).ok, true);
  // other personas may not mail a peer without a shared task or a senior-dev cc
  assert.match(rejectionReason({ ...base, to: ['dev-b'] }, ctx), /dev-b/);
  assert.equal(validateMail({ ...base, to: ['dev-b'], cc: ['senior-dev'] }, ctx).ok, true);
  // the restriction covers cc recipients too; the senior-dev cc exception still applies
  assert.match(rejectionReason({ ...base, to: ['senior-dev'], cc: ['dev-b'] }, ctx), /dev-b/);
  assert.equal(
    validateMail({ ...base, to: ['senior-dev'], cc: ['dev-b', 'senior-dev'] }, ctx).ok,
    true,
  );
  // the senior dev may mail anyone
  assert.equal(
    validateMail({ ...base, to: ['dev-b'] }, { ...ctx, role: 'senior-dev' }).ok,
    true,
  );
});

test('validateMail defaults thread to id and fills optional fields', () => {
  const result = validateMail(base, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isUlid(result.value.id), true);
  assert.equal(result.value.thread, result.value.id);
  assert.deepEqual(result.value.cc, []);
  assert.equal(result.value.in_reply_to, '');
});

test('serializeMail emits the plan.md frontmatter shape with a UTC timestamp', () => {
  const result = validateMail({ ...base, eta: '2 min', worktree: 'auth-api' }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const text = serializeMail({ ...result.value, created_at: '2026-11-23T10:15:00Z' });
  const lines = text.split('\n');

  assert.equal(lines[0], '---');
  assert.match(lines[1]!, /^id: [0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(lines[2], `thread: ${lines[1]!.slice(4)}`);
  assert.match(text, /^from: dev-a$/m);
  assert.match(text, /^to: \[senior-dev\]$/m);
  assert.match(text, /^cc: \[\]$/m);
  assert.match(text, /^kind: status$/m);
  assert.match(text, /^eta: 2 min$/m);
  assert.match(text, /^worktree: auth-api$/m);
  assert.match(text, /^created_at: 2026-11-23T10:15:00Z$/m);
  assert.match(text, /\n---\nACTION: Review\./);
});

test('sendMail throws a typed MAIL_REJECTED error for invalid input', async () => {
  await assert.rejects(
    () => sendMail(tempStore(), { ...base, subject: '' }, ctx),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'MAIL_REJECTED',
  );
});

test('sendMail refuses an id that is already committed without replacing the mail file', async () => {
  const dir = tempStore();
  const id = newId();
  const input = { ...base, id, subject: 'first' };

  const first = await sendMail(dir, input, ctx);
  assert.equal(first.id, id);
  await assert.rejects(
    () => sendMail(dir, { ...input, subject: 'duplicate' }, ctx),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'MAIL_REJECTED',
  );

  const file = join(dir, 'mail', '2026', '11', `${id}.md`);
  assert.match(readFileSync(file, 'utf8'), /subject: first/);
  assert.equal(readdirSync(join(dir, 'mail'), { recursive: true }).filter(
    (p) => String(p).endsWith('.md'),
  ).length, 1);
});

test('sendMail refuses an explicit id already committed in another month', async () => {
  const dir = tempStore();
  const id = newId();
  await sendMail(dir, { ...base, id, subject: 'original' }, ctx);

  const otherMonth: MailContext = { ...ctx, now: new Date('2025-04-02T09:00:00Z') };
  await assert.rejects(
    () => sendMail(dir, { ...base, id, subject: 'cross-month duplicate' }, otherMonth),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'MAIL_REJECTED',
  );

  const files = readdirSync(join(dir, 'mail'), { recursive: true })
    .filter((p) => String(p).endsWith('.md'));
  assert.equal(files.length, 1, 'no mail file was added in the second month');
  assert.match(readFileSync(join(dir, 'mail', '2026', '11', `${id}.md`), 'utf8'),
    /subject: original/);
});

test('sendMail reports a committed id when only the audit append fails', async () => {
  const dir = tempStore();
  mkdirSync(join(dir, 'events', 'audit.jsonl'), { recursive: true });
  const id = newId();

  await assert.rejects(
    () => sendMail(dir, { ...base, id }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof ArtinareyError, 'expected a typed error');
      assert.equal(err.code, 'MAIL_PARTIAL');
      assert.equal(err.mailId, id);
      assert.match(err.message, /do not resend/i);
      assert.match(err.message, new RegExp(id));
      return true;
    },
  );

  // The mail is durable: callers must not resend the same message.
  const files = readdirSync(join(dir, 'mail'), { recursive: true })
    .filter((p) => String(p).endsWith('.md'));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(dir, 'mail', '2026', '11', `${id}.md`), 'utf8'), /id: /);
});

test('50 concurrent sendMail calls give unique ids, 50 immutable files, and 50 audit lines', async () => {
  const dir = tempStore();
  const context: MailContext = {
    knownPersonas: ['dev-a', 'senior-dev'],
    role: 'dev-a',
    now: new Date('2026-11-23T10:15:00Z'),
  };

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      sendMail(dir, { ...base, subject: `mail ${i}`, body: `message ${i}` }, context)),
  );

  const ids = results.map((r) => r.id);
  assert.equal(new Set(ids).size, 50, 'every mail must have a unique id');

  const files = readdirSync(dir, { recursive: true })
    .filter((p) => String(p).endsWith('.md'))
    .map((p) => join(dir, String(p)));
  assert.equal(files.length, 50, 'no mail may be lost under concurrency');
  for (const file of files) {
    assert.equal(statSync(file).mode & 0o777, 0o444, `${file} must be immutable`);
  }

  const lines = readFileSync(join(dir, 'events', 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 50);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line!));
  assert.equal(recoverProject(dir).trimmedLines, 0, 'no torn audit lines');
  assert.deepEqual(recoverProject(dir).removedTemps, []);
});

test('validateMail rejects explicit ids that are not ULIDs', () => {
  assert.match(rejectionReason({ ...base, id: 'alias/../E' }), /ULID/i);
  assert.match(rejectionReason({ ...base, id: '../outside' }), /ULID/i);
  assert.equal(validateMail({ ...base, id: newId() }, ctx).ok, true);
});

test('sendMail does not overwrite an existing file through a path-alias id', async () => {
  const dir = tempStore();
  const id = newId();
  await sendMail(dir, { ...base, id, subject: 'original' }, ctx);

  await assert.rejects(
    () => sendMail(dir, { ...base, id: `alias/../${id}`, subject: 'replacement' }, ctx),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'MAIL_REJECTED',
  );

  const file = join(dir, 'mail', '2026', '11', `${id}.md`);
  assert.match(readFileSync(file, 'utf8'), /subject: original/);
});

test('serializeMail quotes values containing a YAML comment marker', () => {
  const result = validateMail({ ...base, subject: 'Review #42' }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const text = serializeMail({ ...result.value, created_at: '2026-11-23T10:15:00Z' });
  assert.match(text, /^subject: "Review #42"$/m);
});
