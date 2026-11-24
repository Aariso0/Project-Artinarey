import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendJournal,
  ArtinareyError,
  atomicWrite,
  buildIndex,
  claimPersona,
  fail,
  ok,
  queryMail,
  readPersona,
  releasePersona,
  releaseWorktreeForce,
  resolveIdentity,
  roster,
  sendMail,
  type ArtinareyErrorCode,
  type Identity,
  type IndexedMail,
  type Registry,
  type ToolReply,
  type XdgPaths,
} from '@artinarey/core';
import type { RpcRequest, RpcResponse } from './server.ts';

export const TOOL_METHODS = new Set([
  'attach', 'release_force', 'check_in', 'claim_persona', 'inbox',
  'read_mail', 'send_mail', 'mark_done', 'report', 'worktrees',
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
};

function toolOk(id: string, reply: ToolReply): RpcResponse {
  return { id, ok: true, result: reply };
}

function toolFail(id: string, code: ArtinareyErrorCode, message: string): RpcResponse {
  return { id, ok: false, error: { code, message: fail(code, message).text } };
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

function receiptExists(storeDir: string, mailId: string, role: string): boolean {
  const root = join(storeDir, 'mail');
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).some((entry) => {
    if (!String(entry).endsWith('.md')) return false;
    const text = readFileSync(join(root, String(entry)), 'utf8');
    return /^kind: receipt$/m.test(text)
      && text.includes(`in_reply_to: ${mailId}`)
      && text.includes(`from: ${role}`);
  });
}

function rosterText(entries: ReturnType<typeof roster>): string {
  if (entries.length === 0) return 'Roster is empty. Ask the user which role to start as.';
  return `Roster:\n${entries.map((e) => {
    const home = e.homeWorktreeId ? e.homeWorktreeId.slice(0, 8) : 'none';
    const task = e.lastTask ? ` — ${e.lastTask}` : '';
    return `- ${e.personaId.slice(0, 8)} ${e.role} (${e.name}) ${e.state} home:${home}${task}`;
  }).join('\n')}`;
}

/** Forget a worktree's identity and cleanup ownership, on this context or all of them. */
export function invalidateWorktree(ctx: RpcContext, worktreeId: string): void {
  if (ctx.claimedBindings) {
    ctx.claimedBindings = ctx.claimedBindings.filter((binding) => binding.worktreeId !== worktreeId);
  }
  if (ctx.identity?.worktreeId === worktreeId) delete ctx.identity;
}

function requireIdentity(
  id: string,
  ctx: RpcContext,
): { identity: Identity } | { response: RpcResponse } {
  if (!ctx.identity?.personaId || !ctx.identity.role) {
    return {
      response: toolFail(id, 'INVALID_INPUT', 'call attach and claim_persona before this tool'),
    };
  }
  const bound = ctx.registry.bindings.forWorktree(ctx.identity.worktreeId);
  if (bound?.id !== ctx.identity.personaId) {
    invalidateWorktree(ctx, ctx.identity.worktreeId);
    return { response: toolFail(id, 'NO_PROJECT', 'binding was released; call attach again') };
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
    const alreadyBound = ctx.registry.bindings.forWorktree(ctx.identity.worktreeId)?.id;
    const result = claimPersona(ctx.registry, ctx.identity.storeDir, ctx.identity, {
      personaId: str(params.persona_id),
      newRole: str(params.new_role),
      name: str(params.name),
      confirmMove: params.confirm_move === true,
      rehome: params.rehome === true,
    });
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
    if (!receiptExists(identity.storeDir, mailId, identity.role!)) {
      try {
        await sendMail(identity.storeDir, {
          from: identity.role!,
          to: [mail.from],
          cc: mail.from === 'senior-dev' || mail.from === 'user' ? [] : ['senior-dev'],
          subject: `Re: ${mail.subject}`,
          kind: 'receipt',
          action: 'done',
          in_reply_to: mailId,
          body: note,
        }, {
          knownPersonas: knownRoles(ctx, identity.projectId),
          role: identity.role!,
          sharedTasks: [],
        });
      } catch (err) {
        return toolFail(id, 'MAIL_REJECTED', (err as Error).message);
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
    return toolOk(id, ok(`Marked ${mailId} done and mailed a receipt.`, unread(ctx, identity), 'inbox'));
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

  return toolFail(id, 'NOT_FOUND', `unknown method: ${request.method}`);
}

/** A disconnected shim releases every persona this connection bound. */
export function releaseConnection(ctx: RpcContext): void {
  const bindings = ctx.claimedBindings ?? [];
  delete ctx.claimedBindings;
  for (const binding of bindings) {
    const bound = ctx.registry.bindings.forWorktree(binding.worktreeId);
    if (bound?.id !== binding.personaId) continue;
    // A later claim of the same persona is a new binding instance, not ours to release.
    if (binding.claimLine !== undefined
        && claimLine(binding.storeDir, binding.personaId) !== binding.claimLine) continue;
    try {
      releasePersona(ctx.registry, binding.storeDir, binding.personaId);
    } catch (err) {
      console.error(`persona release failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}
