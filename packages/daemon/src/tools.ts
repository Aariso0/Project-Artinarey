import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendJournal,
  ArtinareyError,
  atomicWrite,
  assertScopeAvailable,
  buildIndex,
  claimPersona,
  claimShared,
  createTask,
  DEFAULT_PERSONA,
  fail,
  newId,
  normalizePath,
  ok,
  queryMail,
  readPersona,
  readTasks,
  releaseShared,
  releasePersona,
  releaseWorktreeForce,
  resolveIdentity,
  rollbackFailedClaim,
  roster,
  sendMail,
  updateTask,
  type ArtinareyErrorCode,
  type TaskStatus,
  type Identity,
  type IndexedMail,
  type PersonaState,
  type Registry,
  type ToolReply,
  type XdgPaths,
} from '@artinarey/core';
import type { RpcRequest, RpcResponse } from './server.ts';
import type { SessionSupervisor } from './sessions.ts';

export const TOOL_METHODS = new Set([
  'attach', 'release_force', 'check_in', 'claim_persona', 'inbox',
  'read_mail', 'send_mail', 'mark_done', 'report', 'worktrees',
  'task_update', 'request_scope', 'assign_task', 'request_session',
]);

export function isToolMethod(method: string): boolean {
  return TOOL_METHODS.has(method);
}

type ClaimedBinding = {
  personaId: string;
  storeDir: string;
  worktreeId: string;
  /** Audit line of the claim that gave this connection ownership. */
  claimLine?: number;
};

export type RpcContext = {
  registry: Registry;
  paths: XdgPaths;
  cwd?: string;
  pid?: number;
  identity?: Identity;
  /** Every binding this connection acquired and still owns. */
  claimedBindings?: ClaimedBinding[];
  /** Installed by the daemon so a force release reaches other connections. */
  invalidateWorktree?: (worktreeId: string) => void;
  /** The only component allowed to spawn processes or resolve approvals. */
  supervisor?: SessionSupervisor;
};

function toolOk(id: string, reply: ToolReply): RpcResponse {
  return { id, ok: true, result: reply };
}

function toolFail(id: string, code: ArtinareyErrorCode, message: string): RpcResponse {
  return { id, ok: false, error: { code, message: fail(code, message).text } };
}

/** A committed task survives a later mail/index failure; expose its id for retry. */
export type TaskFailureResponse = {
  id: string;
  ok: false;
  error: { code: ArtinareyErrorCode; message: string; taskId: string };
};

function taskFail(
  id: string, code: ArtinareyErrorCode, message: string, taskId: string,
): TaskFailureResponse {
  const hint = code === 'INDEX_ERROR'
    ? `task ${taskId} is committed; retry assign_task with task_id to rebuild the index`
    : `task ${taskId} is committed; retry assign_task with task_id to finish the notification`;
  const text = fail(code, `${message} (${hint})`).text;
  return { id, ok: false, error: { code, message: text, taskId } };
}

function indexFile(ctx: RpcContext, projectId: string): string {
  return join(ctx.paths.cacheRoot, projectId, 'index.sqlite');
}

function auditFile(storeDir: string): string {
  return join(storeDir, 'events', 'audit.jsonl');
}

function paramsOf(request: RpcRequest): Record<string, unknown> {
  return request.params && typeof request.params === 'object'
    ? request.params as Record<string, unknown>
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function knownRoles(ctx: RpcContext, projectId: string): string[] {
  return [...ctx.registry.personas.list(projectId).map((p) => p.role), 'user'];
}

function auditEvents(storeDir: string): Array<{ event: Record<string, unknown>; line: number }> {
  const file = auditFile(storeDir);
  if (!existsSync(file)) return [];
  const events: Array<{ event: Record<string, unknown>; line: number }> = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push({ event: JSON.parse(line) as Record<string, unknown>, line: index });
    } catch {
      // ignore a torn line; the writer recovers it at startup
    }
  });
  return events;
}

function readIds(storeDir: string, personaRole: string): Set<string> {
  const ids = new Set<string>();
  for (const { event } of auditEvents(storeDir)) {
    if (event.type === 'mail_read' && event.persona === personaRole && typeof event.id === 'string') {
      ids.add(event.id);
    }
  }
  return ids;
}

function claimLine(storeDir: string, personaId: string): number | undefined {
  let line: number | undefined;
  for (const entry of auditEvents(storeDir)) {
    if (entry.event.type === 'persona_claimed' && entry.event.persona_id === personaId) {
      line = entry.line;
    }
  }
  return line;
}

function hasTaskDone(storeDir: string, personaRole: string, mailId: string): boolean {
  return auditEvents(storeDir).some(({ event }) => event.type === 'task_done'
    && event.persona === personaRole && event.id === mailId);
}

function addressedTo(mail: IndexedMail, role: string): boolean {
  return mail.to.includes(role) || (mail.cc?.includes(role) ?? false);
}

function countUnread(mails: IndexedMail[], seen: Set<string>, role: string): number {
  return mails.filter((mail) => addressedTo(mail, role)
    && mail.from !== role && !seen.has(mail.id)).length;
}

function unread(ctx: RpcContext, identity: Identity): number {
  if (!identity.role) return 0;
  const mails = queryMail(indexFile(ctx, identity.projectId));
  return countUnread(mails, readIds(identity.storeDir, identity.role), identity.role);
}

/** Read only top-level frontmatter scalars, honouring serializeMail's JSON quoting. */
function frontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines[0] !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end < 0) return {};
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const split = line.indexOf(':');
    if (split < 0) continue;
    const key = line.slice(0, split);
    const raw = line.slice(split + 1).trim();
    if (raw.startsWith('"')) {
      try {
        fields[key] = JSON.parse(raw) as string;
        continue;
      } catch {
        // Fall through and keep the literal, so a torn line cannot match a receipt.
      }
    }
    fields[key] = raw;
  }
  return fields;
}

function receiptExists(storeDir: string, mailId: string, role: string): boolean {
  const root = join(storeDir, 'mail');
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).some((entry) => {
    if (!String(entry).endsWith('.md')) return false;
    const fields = frontmatter(readFileSync(join(root, String(entry)), 'utf8'));
    return fields.kind === 'receipt' && fields.in_reply_to === mailId && fields.from === role;
  });
}

/** The assignment notification carries the task id so recovery cannot duplicate it. */
function taskMailExists(storeDir: string, taskId: string): boolean {
  const root = join(storeDir, 'mail');
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).some((entry) => {
    if (!String(entry).endsWith('.md')) return false;
    const fields = frontmatter(readFileSync(join(root, String(entry)), 'utf8'));
    return fields.kind === 'task' && fields.in_reply_to === taskId;
  });
}

/** The worktree a persona was bound to before this claim, for rollback. */
function boundWorktree(
  ctx: RpcContext, personaId: string,
): { id: string; path: string } | undefined {
  for (const project of ctx.registry.projects.list()) {
    for (const worktree of ctx.registry.worktrees.list(project.id)) {
      if (ctx.registry.bindings.forWorktree(worktree.id)?.id === personaId) {
        return { id: worktree.id, path: worktree.path };
      }
    }
  }
  return undefined;
}

function rosterText(entries: ReturnType<typeof roster>): string {
  if (entries.length === 0) return 'Roster is empty. Ask the user which role to start as.';
  return `Roster:\n${entries.map((e) => {
    const home = e.homeWorktreeId ? e.homeWorktreeId.slice(0, 8) : 'none';
    const task = e.lastTask ? ` — ${e.lastTask}` : '';
    return `- ${e.personaId.slice(0, 8)} ${e.role} (${e.name}) ${e.state} home:${home}${task}`;
  }).join('\n')}`;
}

/** Forget a worktree's persona and cleanup ownership, keeping its attachment. */
export function invalidateWorktree(ctx: RpcContext, worktreeId: string): void {
  if (ctx.claimedBindings) {
    ctx.claimedBindings = ctx.claimedBindings.filter((binding) => binding.worktreeId !== worktreeId);
  }
  if (ctx.identity?.worktreeId === worktreeId) {
    // Replace rather than mutate: the daemon shares identity with other contexts.
    ctx.identity = {
      projectId: ctx.identity.projectId,
      worktreeId: ctx.identity.worktreeId,
      markerDir: ctx.identity.markerDir,
      storeDir: ctx.identity.storeDir,
    };
  }
}

function requireIdentity(
  id: string,
  ctx: RpcContext,
): { identity: Identity } | { response: RpcResponse } {
  if (!ctx.identity) {
    return { response: toolFail(id, 'NO_PROJECT', 'call attach before this tool') };
  }
  if (!ctx.identity.personaId || !ctx.identity.role) {
    return {
      response: toolFail(id, 'INVALID_INPUT', 'call claim_persona before this tool'),
    };
  }
  const bound = ctx.registry.bindings.forWorktree(ctx.identity.worktreeId);
  if (bound?.id !== ctx.identity.personaId) {
    invalidateWorktree(ctx, ctx.identity.worktreeId);
    return { response: toolFail(id, 'NO_PROJECT', 'binding was released; call claim_persona') };
  }
  return { identity: ctx.identity };
}

function storeDirForWorktree(ctx: RpcContext, worktreeId: string): string | undefined {
  for (const project of ctx.registry.projects.list()) {
    if (ctx.registry.worktrees.list(project.id).some((wt) => wt.id === worktreeId)) {
      return project.storeDir;
    }
  }
  return undefined;
}

/** Tool dispatch. Identity comes only from the attached connection, never from tool args. */
export async function dispatchTool(request: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  const params = paramsOf(request);
  const id = request.id;

  if (request.method === 'attach') {
    const cwd = str(params.cwd);
    const pid = int(params.pid);
    if (!cwd || !pid) return toolFail(id, 'INVALID_INPUT', 'attach needs cwd and pid');
    try {
      process.kill(pid, 0);
    } catch {
      return toolFail(id, 'NO_PROJECT', 'the agent session process is gone; restart the agent');
    }
    const resolved = resolveIdentity(ctx.registry, cwd);
    if (!resolved.ok) return toolFail(id, resolved.code, resolved.message);
    ctx.cwd = cwd;
    ctx.pid = pid;
    ctx.identity = resolved.identity;
    const people = roster(ctx.registry, resolved.identity.storeDir, resolved.identity.projectId);
    return {
      id,
      ok: true,
      result: {
        project: resolved.identity.projectId,
        worktree: resolved.identity.worktreeId,
        persona: resolved.identity.personaId ?? null,
        role: resolved.identity.role ?? null,
        roster: people,
        unread: unread(ctx, resolved.identity),
      },
    };
  }

  if (request.method === 'release_force') {
    const worktreeId = str(params.worktreeId);
    if (!worktreeId) return toolFail(id, 'INVALID_INPUT', 'release_force needs worktreeId');
    const storeDir = storeDirForWorktree(ctx, worktreeId);
    if (!storeDir) return toolFail(id, 'NOT_FOUND', `unknown worktree: ${worktreeId}`);
    const released = releaseWorktreeForce(ctx.registry, storeDir, worktreeId);
    if (released) {
      ctx.invalidateWorktree?.(worktreeId);
      invalidateWorktree(ctx, worktreeId);
    }
    return { id, ok: true, result: { released } };
  }

  if (request.method === 'check_in') {
    if (!ctx.identity) return toolFail(id, 'NO_PROJECT', 'call attach before check_in');
    const identity = ctx.identity;
    const people = roster(ctx.registry, identity.storeDir, identity.projectId);
    const count = unread(ctx, identity);
    const who = identity.role
      ? `You are ${identity.role} in worktree ${identity.worktreeId}.`
      : `Worktree ${identity.worktreeId} has no bound persona.`;
    return toolOk(
      id,
      ok(`${who}\n${rosterText(people)}`, count, identity.role ? 'inbox' : 'claim_persona'),
    );
  }

  if (request.method === 'claim_persona') {
    if (!ctx.identity) return toolFail(id, 'NO_PROJECT', 'call attach before claim_persona');
    const identity = ctx.identity;
    const requestedId = str(params.persona_id);
    const newRole = str(params.new_role);
    const name = str(params.name);
    const alreadyBound = ctx.registry.bindings.forWorktree(identity.worktreeId)?.id;
    const peopleBefore = new Set(ctx.registry.personas.list(identity.projectId).map((p) => p.id));
    const stateBefore: PersonaState = requestedId
      ? readPersona(identity.storeDir, requestedId)
      : { ...DEFAULT_PERSONA, role: newRole ?? '', name: name ?? newRole ?? '' };
    const originalWorktree = requestedId ? boundWorktree(ctx, requestedId) : undefined;
    let result;
    try {
      result = claimPersona(ctx.registry, identity.storeDir, identity, {
        personaId: requestedId,
        newRole,
        name,
        confirmMove: params.confirm_move === true,
        rehome: params.rehome === true,
      });
    } catch (err) {
      // claimPersona commits binding/lock/persona state before its audit append.
      // Undo that partial claim before the daemon can record connection ownership.
      const createdId = ctx.registry.personas.list(identity.projectId)
        .find((persona) => !peopleBefore.has(persona.id) && persona.role === newRole)?.id;
      try {
        rollbackFailedClaim(ctx.registry, identity, requestedId ?? createdId,
          alreadyBound, stateBefore, originalWorktree, Boolean(createdId));
      } catch (rollbackErr) {
        console.error(`claim rollback failed: ${(rollbackErr as Error).message ?? String(rollbackErr)}`);
      }
      const e = err as { code?: ArtinareyErrorCode; message?: string };
      return toolFail(id, e.code ?? 'INVALID_INPUT', e.message ?? 'claim failed');
    }
    if (!result.ok) return toolFail(id, result.code, result.message);
    ctx.identity = result.identity;
    const bindings = ctx.claimedBindings ?? [];
    const owned = bindings.find((b) => b.worktreeId === result.identity.worktreeId
      && b.personaId === result.personaId);
    if (owned) {
      // A repeat claim by this connection appends a new audit line: refresh it so
      // releaseConnection still recognises the binding as ours.
      owned.claimLine = claimLine(result.identity.storeDir, result.personaId);
    } else if (!alreadyBound) {
      // A repeat claim of another owner's binding must not transfer ownership.
      bindings.push({
        personaId: result.personaId,
        storeDir: result.identity.storeDir,
        worktreeId: result.identity.worktreeId,
        claimLine: claimLine(result.identity.storeDir, result.personaId),
      });
    }
    ctx.claimedBindings = bindings;
    const who = readPersona(result.identity.storeDir, result.personaId);
    return toolOk(
      id,
      ok(`Bound ${who.role} (${who.name}) to this directory.`, unread(ctx, ctx.identity), 'inbox'),
    );
  }

  if (request.method === 'inbox') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const limit = int(params.limit) ?? 5;
    const mails = queryMail(indexFile(ctx, identity.projectId));
    const seen = readIds(identity.storeDir, identity.role!);
    const addressed = mails.filter((mail) => addressedTo(mail, identity.role!));
    const includeRead = params.include_read === true;
    const list = (includeRead ? addressed
      : addressed.filter((m) => m.from !== identity.role && !seen.has(m.id)))
      .slice(-limit)
      .reverse();
    const body = list.length === 0
      ? 'Inbox is empty.'
      : list.map((m) => `- ${m.id} from ${m.from}: ${m.subject}`).join('\n');
    return toolOk(id, ok(body, countUnread(addressed, seen, identity.role!),
      list.length ? 'read_mail' : 'check_in'));
  }

  if (request.method === 'read_mail') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const mailId = str(params.id);
    if (!mailId) return toolFail(id, 'INVALID_INPUT', 'read_mail needs an id');
    const match = queryMail(indexFile(ctx, identity.projectId))
      .find((m) => m.id === mailId && (addressedTo(m, identity.role!) || m.from === identity.role));
    if (!match) return toolFail(id, 'NOT_FOUND', `no mail with id ${mailId} for your persona`);
    const text = readFileSync(match.file, 'utf8');
    appendJournal(auditFile(identity.storeDir), {
      type: 'mail_read', id: match.id, persona: identity.role, created_at: new Date().toISOString(),
    });
    return toolOk(id, ok(text, unread(ctx, identity), 'inbox'));
  }

  if (request.method === 'send_mail') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const to = Array.isArray(params.to) ? params.to.filter((v): v is string => typeof v === 'string') : [];
    const cc = Array.isArray(params.cc) ? params.cc.filter((v): v is string => typeof v === 'string') : [];
    const subject = str(params.subject);
    const kind = str(params.kind);
    const action = str(params.action);
    const body = str(params.body);
    if (!subject || !kind || !action || !body) {
      return toolFail(id, 'INVALID_INPUT', 'send_mail needs to, subject, kind, action and body');
    }
    let record;
    try {
      record = await sendMail(identity.storeDir, {
        from: identity.role!, to, cc, subject,
        kind: kind as Parameters<typeof sendMail>[1]['kind'],
        action, eta: str(params.eta), body,
        in_reply_to: str(params.in_reply_to), worktree: identity.worktreeId,
      }, {
        knownPersonas: knownRoles(ctx, identity.projectId),
        role: identity.role!,
        sharedTasks: [],
      });
    } catch (err) {
      if (err instanceof ArtinareyError && err.code === 'MAIL_PARTIAL') {
        // The mail file is committed: make it visible before returning the partial failure.
        try {
          buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
        } catch {
          // Best effort only: an index failure must not replace the original error.
        }
        const message = err.mailId && !err.message.includes(err.mailId)
          ? `${err.message} (mail ${err.mailId})`
          : err.message;
        return toolFail(id, err.code, message);
      }
      const e = err as { code?: ArtinareyErrorCode; message?: string };
      return toolFail(id, e.code ?? 'MAIL_REJECTED', e.message ?? 'mail rejected');
    }
    try {
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
    } catch (err) {
      // The mail is already committed: report its id and ask for a reindex, never a resend.
      let count = 0;
      try { count = unread(ctx, identity); } catch { /* the index is unavailable */ }
      return toolOk(id, ok(`Sent ${record.id} to ${to.join(', ')}.\nIndex update failed: ${(err as Error).message}`,
        count, 'run artinarey reindex'));
    }
    return toolOk(
      id,
      ok(`Sent ${record.id} to ${to.join(', ')}.`, unread(ctx, identity), 'inbox'),
    );
  }

  if (request.method === 'mark_done') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const mailId = str(params.id);
    const note = str(params.note);
    if (!mailId || !note) return toolFail(id, 'INVALID_INPUT', 'mark_done needs id and note');
    const mail = queryMail(indexFile(ctx, identity.projectId))
      .find((m) => m.id === mailId && addressedTo(m, identity.role!));
    if (!mail) return toolFail(id, 'NOT_FOUND', `no mail with id ${mailId} assigned to you`);
    const roles = knownRoles(ctx, identity.projectId);
    let receiptStatus = 'mailed a receipt';
    if (!receiptExists(identity.storeDir, mailId, identity.role!)) {
      const senderKnown = roles.includes(mail.from);
      const seniorRegistered = roles.includes('senior-dev');
      const needsSeniorCc = mail.from !== 'senior-dev' && mail.from !== 'user';
      if (!senderKnown) {
        // Completion is durable even if the original sender's persona was removed.
        receiptStatus = `no receipt sent because ${mail.from} is no longer registered`;
      } else if (needsSeniorCc && !seniorRegistered) {
        // A receipt to another persona needs a senior-dev cc, but that role is absent.
        receiptStatus = 'no receipt sent because senior-dev is not registered in this project';
      } else {
        try {
          await sendMail(identity.storeDir, {
            from: identity.role!,
            to: [mail.from],
            cc: seniorRegistered && needsSeniorCc ? ['senior-dev'] : [],
            subject: `Re: ${mail.subject}`,
            kind: 'receipt',
            action: 'done',
            in_reply_to: mailId,
            body: note,
          }, {
            knownPersonas: roles,
            role: identity.role!,
            sharedTasks: [],
          });
        } catch (err) {
          return toolFail(id, 'MAIL_REJECTED', (err as Error).message);
        }
      }
    }
    // Retry-safe mail, but the index is derived: rebuild it even when the receipt
    // was committed by an earlier call whose index build failed.
    try {
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
    } catch (err) {
      return toolFail(id, 'INDEX_ERROR', (err as Error).message);
    }
    // The receipt is committed first; retries must not duplicate the completion event.
    if (!hasTaskDone(identity.storeDir, identity.role!, mailId)) {
      appendJournal(auditFile(identity.storeDir), {
        type: 'task_done', id: mailId, persona: identity.role, note,
        created_at: new Date().toISOString(),
      });
    }
    return toolOk(id, ok(`Marked ${mailId} done and ${receiptStatus}.`, unread(ctx, identity), 'inbox'));
  }

  if (request.method === 'report') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const now = str(params.now);
    if (!now) return toolFail(id, 'INVALID_INPUT', 'report needs now, done, next and blocked');
    const file = join(identity.storeDir, 'personas', identity.personaId!, 'status.md');
    atomicWrite(file, [
      `# now: ${now}`, '', '## done', String(params.done ?? ''), '',
      '## next', String(params.next ?? ''), '', '## blocked', String(params.blocked ?? ''), '',
    ].join('\n'));
    return toolOk(id, ok('Status updated.', unread(ctx, identity), 'inbox'));
  }

  if (request.method === 'worktrees') {
    if (!ctx.identity) return toolFail(id, 'NO_PROJECT', 'call attach before worktrees');
    const { identity } = ctx;
    const current = identity.worktreeId;
    const lines = ctx.registry.worktrees.list(identity.projectId).map((wt) => {
      const bound = ctx.registry.bindings.forWorktree(wt.id);
      return `- ${wt.id === current ? '* ' : '  '}${wt.path} (${wt.branch ?? 'detached'})${bound ? ` ← ${bound.role}` : ''}`;
    });
    return toolOk(id, ok(lines.join('\n') || 'No worktrees registered.', unread(ctx, identity), 'check_in'));
  }

  if (request.method === 'assign_task') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    if (identity.role !== 'senior-dev') {
      return toolFail(id, 'FORBIDDEN_ROLE', 'only the senior dev may assign tasks');
    }
    const assignee = str(params.persona_id);
    const title = str(params.title);
    const body = str(params.body);
    const scopeInput = Array.isArray(params.scope)
      ? params.scope.filter((v): v is string => typeof v === 'string') : [];
    if (!assignee || !title || !body || scopeInput.length === 0) {
      return toolFail(id, 'INVALID_INPUT', 'assign_task needs persona_id, title, scope[] and body');
    }
    const persona = ctx.registry.personas.list(identity.projectId).find((p) => p.id === assignee);
    if (!persona) return toolFail(id, 'NOT_FOUND', `unknown persona: ${assignee}`);
    // Validate every entry up front: an empty store has no scope comparisons, so
    // an unnormalised scope could otherwise be persisted before claimShared rejects it.
    let scope: string[];
    try {
      scope = scopeInput.map(normalizePath);
    } catch (err) {
      const e = err as { code?: ArtinareyErrorCode; message?: string };
      return toolFail(id, e.code ?? 'INVALID_INPUT', e.message ?? 'invalid scope path');
    }
    const recoveryId = str(params.task_id);
    let taskId = recoveryId;
    if (recoveryId) {
      // A committed task is reused verbatim: never recreate its lease or audit line.
      const committed = readTasks(identity.storeDir).find((t) => t.id === recoveryId);
      if (!committed) return toolFail(id, 'NOT_FOUND', `no task with id ${recoveryId}`);
      if (committed.assignee !== persona.role) {
        return toolFail(id, 'FORBIDDEN_ROLE', 'the committed task belongs to another persona');
      }
      let committedScope: string[];
      try {
        committedScope = committed.scope.map(normalizePath);
      } catch (err) {
        const e = err as { code?: ArtinareyErrorCode; message?: string };
        return toolFail(id, e.code ?? 'INVALID_INPUT', e.message ?? 'invalid committed scope');
      }
      if (committedScope.length !== scope.length
          || scope.some((path) => !committedScope.includes(path))) {
        return toolFail(id, 'INVALID_INPUT', 'scope must match the committed task');
      }
    } else {
      try {
        assertScopeAvailable(identity.storeDir, scope);
      } catch (err) {
        const e = err as { code?: ArtinareyErrorCode; message?: string };
        return toolFail(id, e.code ?? 'LEASE_OVERLAP', e.message ?? 'scope overlaps a lease');
      }
      taskId = newId();
      const worktree = ctx.registry.worktrees.list(identity.projectId)
        .find((wt) => ctx.registry.bindings.forWorktree(wt.id)?.id === assignee);
      createTask(identity.storeDir, {
        id: taskId, projectId: identity.projectId, title, scope, assignee: persona.role,
        status: 'in_progress', worktreeId: worktree?.id ?? null,
        branch: worktree?.branch ?? null, createdAt: new Date().toISOString(),
      });
      claimShared(identity.storeDir, taskId, scope);
    }
    if (!taskMailExists(identity.storeDir, taskId!)) {
      try {
        await sendMail(identity.storeDir, {
          from: identity.role!, to: [persona.role], subject: `Task: ${title}`,
          kind: 'task', action: body, body, in_reply_to: taskId,
        }, { knownPersonas: knownRoles(ctx, identity.projectId), role: identity.role!, sharedTasks: [] });
      } catch (err) {
        const e = err as { code?: ArtinareyErrorCode; message?: string };
        const code = e.code === 'MAIL_PARTIAL' ? 'MAIL_PARTIAL' : 'MAIL_REJECTED';
        return taskFail(id, code, e.message ?? 'mail rejected', taskId!);
      }
    }
    try {
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
    } catch (err) {
      return taskFail(id, 'INDEX_ERROR', (err as Error).message, taskId!);
    }
    return toolOk(id, ok(`Assigned ${taskId} to ${persona.role}.`, unread(ctx, identity), 'inbox'));
  }

  if (request.method === 'request_scope') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const taskId = str(params.task_id);
    const reason = str(params.reason);
    const added = Array.isArray(params.paths)
      ? params.paths.filter((v): v is string => typeof v === 'string') : [];
    if (!taskId || !reason || added.length === 0) {
      return toolFail(id, 'INVALID_INPUT', 'request_scope needs task_id, paths[] and reason');
    }
    const task = readTasks(identity.storeDir).find((t) => t.id === taskId);
    if (!task) return toolFail(id, 'NOT_FOUND', `no task with id ${taskId}`);
    if (task.assignee !== identity.role) {
      return toolFail(id, 'FORBIDDEN_ROLE', 'only the assignee may request more scope');
    }
    try {
      assertScopeAvailable(identity.storeDir, [...task.scope, ...added], taskId);
    } catch (err) {
      const e = err as { code?: ArtinareyErrorCode; message?: string };
      return toolFail(id, e.code ?? 'LEASE_OVERLAP', e.message ?? 'scope overlaps a lease');
    }
    try {
      await sendMail(identity.storeDir, {
        from: identity.role!, to: ['senior-dev'], subject: `Scope request: ${task.title}`,
        kind: 'question', action: `approve scope for ${taskId}`,
        body: `Task ${taskId} requests: ${added.join(', ')}\nReason: ${reason}`,
        in_reply_to: taskId,
      }, { knownPersonas: knownRoles(ctx, identity.projectId), role: identity.role!, sharedTasks: [] });
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
    } catch (err) {
      return toolFail(id, 'MAIL_REJECTED', (err as Error).message);
    }
    return toolOk(id, ok(`Scope request for ${taskId} sent to the senior dev.`,
      unread(ctx, identity), 'inbox'));
  }

  if (request.method === 'request_session') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    if (!ctx.supervisor) {
      return toolFail(id, 'STORE_OFFLINE', 'session supervisor is unavailable');
    }
    const result = await ctx.supervisor.requestSession(identity, {
      role: str(params.role),
      persona_id: str(params.persona_id),
      task_id: str(params.task_id) ?? '',
      vendor: str(params.vendor),
      worktree_id: str(params.worktree_id),
    });
    if (!result.ok) {
      const suffix = result.approvalId ? ` (approval ${result.approvalId})` : '';
      return toolFail(id, result.code, `${result.message}${suffix}`);
    }
    return toolOk(id, ok(result.message, unread(ctx, identity), 'check_in'));
  }

  if (request.method === 'task_update') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const taskId = str(params.task_id);
    const status = str(params.status) as TaskStatus;
    const note = str(params.note);
    const allowed: TaskStatus[] = ['in_progress', 'blocked', 'ready_for_review', 'done'];
    if (!taskId || !allowed.includes(status)) {
      return toolFail(id, 'INVALID_INPUT', 'task_update needs task_id and a valid status');
    }
    const task = readTasks(identity.storeDir).find((t) => t.id === taskId);
    if (!task) return toolFail(id, 'NOT_FOUND', `no task with id ${taskId}`);
    if (task.assignee !== identity.role) {
      return toolFail(id, 'FORBIDDEN_ROLE', 'only the assignee may update a task');
    }
    if (task.status === 'done' && status !== 'done') {
      // Done released the lease; reactivation must win it back before status changes.
      try {
        assertScopeAvailable(identity.storeDir, task.scope, taskId);
        claimShared(identity.storeDir, taskId, task.scope);
      } catch (err) {
        const e = err as { code?: ArtinareyErrorCode; message?: string };
        return toolFail(id, e.code ?? 'LEASE_OVERLAP', e.message ?? 'scope overlaps a lease');
      }
    }
    updateTask(identity.storeDir, taskId, { status, note });
    if (status === 'done') releaseShared(identity.storeDir, taskId);
    return toolOk(id, ok(`Task ${taskId} is ${status}.`, unread(ctx, identity), 'inbox'));
  }

  return toolFail(id, 'NOT_FOUND', `unknown method: ${request.method}`);
}

/** A disconnected shim releases every persona this connection bound. */
export function releaseConnection(ctx: RpcContext): void {
  const bindings = ctx.claimedBindings ?? [];
  delete ctx.claimedBindings;
  for (const binding of bindings) {
    try {
      const bound = ctx.registry.bindings.forWorktree(binding.worktreeId);
      if (bound?.id !== binding.personaId) continue;
      // A later claim of the same persona is a new binding instance, not ours to release.
      if (binding.claimLine !== undefined
          && claimLine(binding.storeDir, binding.personaId) !== binding.claimLine) continue;
      releasePersona(ctx.registry, binding.storeDir, binding.personaId);
    } catch (err) {
      console.error(`persona release failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}
