import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { newId } from './ids.ts';
import { appendJournal, atomicWrite, withProjectLock } from './store.ts';

export type MailKind =
  | 'task'
  | 'question'
  | 'status'
  | 'decision'
  | 'blocker'
  | 'receipt'
  | 'note';

const MAIL_KINDS: readonly MailKind[] = [
  'task', 'question', 'status', 'decision', 'blocker', 'receipt', 'note',
];

export type MailInput = {
  id?: string;
  thread?: string;
  in_reply_to?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  kind: MailKind;
  action: string;
  eta?: string;
  worktree?: string;
  body: string;
};

export type MailRecord = Required<MailInput> & { created_at: string };

export type MailContext = {
  knownPersonas: string[];
  role: string;
  /** Tasks both sender and recipient are assigned to (M2 supplies these). */
  sharedTasks?: string[];
  now?: Date;
};

export type ValidationResult =
  | { ok: true; value: Required<MailInput> }
  | { ok: false; reason: string };

const BODY_LIMIT = 8 * 1024;
const SENIOR_DEV = 'senior-dev';
const USER = 'user';
const WILDCARDS = new Set(['*', 'all', '@all', 'everyone', '@everyone']);

// A tripwire, not a scanner: catch obvious pasted credentials and key blocks.
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)\s*=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/m,
];

function reject(reason: string): ValidationResult {
  return { ok: false, reason };
}

export function validateMail(input: MailInput, ctx: MailContext): ValidationResult {
  for (const field of ['from', 'subject', 'action', 'body'] as const) {
    if (!input[field] || input[field]!.trim() === '') return reject(`${field} is required`);
  }
  if (!input.kind || !MAIL_KINDS.includes(input.kind)) return reject('kind is required and must be a known mail kind');
  if (!Array.isArray(input.to) || input.to.length === 0) return reject('to requires at least one recipient (no broadcast)');
  if (input.to.some((r) => WILDCARDS.has(r.toLowerCase()))) return reject('wildcard recipients are not allowed');
  if ((input.cc ?? []).some((r) => WILDCARDS.has(r.toLowerCase()))) {
    return reject('wildcard recipients are not allowed');
  }

  if (Buffer.byteLength(input.body, 'utf8') > BODY_LIMIT) return reject('body exceeds the 8 KB limit');

  const searchable = `${input.subject}\n${input.action}\n${input.body}`;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(searchable))) {
    return reject('body appears to contain a secret; remove it and link to a secure location');
  }

  const recipients = [...input.to, ...(input.cc ?? [])];
  for (const recipient of recipients) {
    if (recipient !== USER && !ctx.knownPersonas.includes(recipient)) {
      return reject(`unknown recipient: ${recipient}`);
    }
  }

  // Settled rule: everyone may mail the senior dev and the user; the senior dev
  // may mail anyone; others need a shared task or a senior-dev cc.
  if (ctx.role !== SENIOR_DEV) {
    const shared = (ctx.sharedTasks?.length ?? 0) > 0 || (input.cc ?? []).includes(SENIOR_DEV);
    for (const recipient of recipients) {
      if (recipient === SENIOR_DEV || recipient === USER || shared) continue;
      return reject(`role ${ctx.role} may not mail ${recipient} without a shared task or senior-dev cc`);
    }
  }

  const id = input.id ?? newId();
  return {
    ok: true,
    value: {
      id,
      thread: input.thread ?? id,
      in_reply_to: input.in_reply_to ?? '',
      from: input.from,
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      kind: input.kind,
      action: input.action,
      eta: input.eta ?? '',
      worktree: input.worktree ?? '',
      body: input.body,
    },
  };
}

function yamlScalar(value: string): string {
  if (value === '') return '""';
  if (/:\s|[\n\r]|^[\s#&*!|>'"%@`{}\[\],?-]|\s$|^(true|false|null|~)$/i.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Markdown with YAML frontmatter, shaped exactly as plan.md §5. */
export function serializeMail(record: MailRecord): string {
  const lines: string[] = ['---', `id: ${yamlScalar(record.id)}`, `thread: ${yamlScalar(record.thread)}`];
  if (record.in_reply_to) lines.push(`in_reply_to: ${yamlScalar(record.in_reply_to)}`);
  lines.push(
    `from: ${yamlScalar(record.from)}`,
    `to: [${record.to.map(yamlScalar).join(', ')}]`,
    `cc: [${record.cc.map(yamlScalar).join(', ')}]`,
    `subject: ${yamlScalar(record.subject)}`,
    `kind: ${yamlScalar(record.kind)}`,
    `action: ${yamlScalar(record.action)}`,
  );
  if (record.eta) lines.push(`eta: ${yamlScalar(record.eta)}`);
  if (record.worktree) lines.push(`worktree: ${yamlScalar(record.worktree)}`);
  lines.push(`created_at: ${yamlScalar(record.created_at)}`, '---', record.body, '');
  return lines.join('\n');
}

/** Sole-writer entry point: validate, then atomically write mail and audit line. */
export async function sendMail(
  storeDir: string,
  input: MailInput,
  ctx: MailContext,
): Promise<MailRecord> {
  return withProjectLock(storeDir, async () => {
    const result = validateMail(input, ctx);
    if (!result.ok) throw new ArtinareyError('MAIL_REJECTED', result.reason);

    const createdAt = (ctx.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const record: MailRecord = { ...result.value, created_at: createdAt };
    const file = join(
      storeDir,
      'mail',
      createdAt.slice(0, 4),
      createdAt.slice(5, 7),
      `${record.id}.md`,
    );

    if (existsSync(file)) {
      throw new ArtinareyError('MAIL_REJECTED', `mail id already exists: ${record.id}`);
    }
    atomicWrite(file, serializeMail(record), 0o444);
    try {
      appendJournal(join(storeDir, 'events', 'audit.jsonl'), {
        type: 'mail_sent',
        id: record.id,
        thread: record.thread,
        from: record.from,
        to: record.to,
        created_at: record.created_at,
      });
    } catch {
      // The mail file is already committed: a retry would duplicate the message.
      throw new ArtinareyError(
        'MAIL_PARTIAL',
        `mail ${record.id} is committed but the audit append failed; do not resend`,
        record.id,
      );
    }
    return record;
  });
}
