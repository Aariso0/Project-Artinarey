import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendJournal,
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

export type RpcContext = {
  registry: Registry;
  paths: XdgPaths;
  cwd?: string;
  pid?: number;
  identity?: Identity;
  /** Only bindings acquired by this connection are released when it disconnects. */
  claimedPersonaId?: string;
  claimedStoreDir?: string;
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

function readIds(storeDir: string, personaRole: string): Set<string> {
  const file = auditFile(storeDir);
  if (!existsSync(file)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'mail_read' && event.persona === personaRole && typeof event.id === 'string') {
        ids.add(event.id);
      }
    } catch {
      // ignore a torn line; the writer recovers it at startup
    }
  }
  return ids;
}

function unread(ctx: RpcContext, identity: Identity): number {
  if (!identity.role) return 0;
  const addressed = queryMail(indexFile(ctx, identity.projectId), { recipient: identity.role });
  const seen = readIds(identity.storeDir, identity.role);
  return addressed.filter((mail) => mail.from !== identity.role && !seen.has(mail.id)).length;
}

function rosterText(entries: ReturnType<typeof roster>): string {
  if (entries.length === 0) return 'Roster is empty. Ask the user which role to start as.';
  return `Roster:\n${entries.map((e) => {
    const home = e.homeWorktreeId ? e.homeWorktreeId.slice(0, 8) : 'none';
    const task = e.lastTask ? ` — ${e.lastTask}` : '';
    return `- ${e.personaId.slice(0, 8)} ${e.role} (${e.name}) ${e.state} home:${home}${task}`;
  }).join('\n')}`;
}

function requireIdentity(
  id: string,
  ctx: RpcContext,
): { identity: Identity } | { response: RpcResponse } {
  if (!ctx.identity?.personaId || !ctx.identity.role) {
    return {
      response: toolFail(id, 'INVALID_INPUT', 'call check_in and claim_persona before this tool'),
    };
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
    if (released && ctx.claimedPersonaId && ctx.identity?.worktreeId === worktreeId) {
      delete ctx.claimedPersonaId;
      delete ctx.claimedStoreDir;
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
    const result = claimPersona(ctx.registry, ctx.identity.storeDir, ctx.identity, {
      personaId: str(params.persona_id),
      newRole: str(params.new_role),
      name: str(params.name),
      confirmMove: params.confirm_move === true,
      rehome: params.rehome === true,
    });
    if (!result.ok) return toolFail(id, result.code, result.message);
    ctx.identity = result.identity;
    ctx.claimedPersonaId = result.personaId;
    ctx.claimedStoreDir = result.identity.storeDir;
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
    const all = queryMail(indexFile(ctx, identity.projectId), { recipient: identity.role });
    const seen = readIds(identity.storeDir, identity.role!);
    const includeRead = params.include_read === true;
    const list = (includeRead ? all : all.filter((m) => m.from !== identity.role && !seen.has(m.id)))
      .slice(-limit)
      .reverse();
    const body = list.length === 0
      ? 'Inbox is empty.'
      : list.map((m) => `- ${m.id.slice(0, 8)} from ${m.from}: ${m.subject}`).join('\n');
    return toolOk(id, ok(body, unread(ctx, identity), list.length ? 'read_mail' : 'check_in'));
  }

  if (request.method === 'read_mail') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const mailId = str(params.id);
    if (!mailId) return toolFail(id, 'INVALID_INPUT', 'read_mail needs an id');
    const match = queryMail(indexFile(ctx, identity.projectId))
      .find((m) => m.id === mailId && (m.to.includes(identity.role!) || m.from === identity.role));
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
    try {
      const record = await sendMail(identity.storeDir, {
        from: identity.role!, to, cc, subject,
        kind: kind as Parameters<typeof sendMail>[1]['kind'],
        action, eta: str(params.eta), body,
        in_reply_to: str(params.in_reply_to), worktree: identity.worktreeId,
      }, {
        knownPersonas: knownRoles(ctx, identity.projectId),
        role: identity.role!,
        sharedTasks: [],
      });
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
      return toolOk(
        id,
        ok(`Sent ${record.id} to ${to.join(', ')}.`, unread(ctx, identity), 'inbox'),
      );
    } catch (err) {
      const e = err as { code?: ArtinareyErrorCode; message?: string };
      return toolFail(id, e.code ?? 'MAIL_REJECTED', e.message ?? 'mail rejected');
    }
  }

  if (request.method === 'mark_done') {
    const auth = requireIdentity(id, ctx);
    if ('response' in auth) return auth.response;
    const { identity } = auth;
    const mailId = str(params.id);
    const note = str(params.note);
    if (!mailId || !note) return toolFail(id, 'INVALID_INPUT', 'mark_done needs id and note');
    const mail = queryMail(indexFile(ctx, identity.projectId))
      .find((m) => m.id === mailId && m.to.includes(identity.role!));
    if (!mail) return toolFail(id, 'NOT_FOUND', `no mail with id ${mailId} assigned to you`);
    appendJournal(auditFile(identity.storeDir), {
      type: 'task_done', id: mailId, persona: identity.role, note,
      created_at: new Date().toISOString(),
    });
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
      buildIndex(indexFile(ctx, identity.projectId), identity.storeDir);
    } catch (err) {
      return toolFail(id, 'MAIL_REJECTED', (err as Error).message);
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

/** A disconnected shim releases only the persona that this connection bound. */
export function releaseConnection(ctx: RpcContext): void {
  if (!ctx.claimedPersonaId || !ctx.claimedStoreDir) return;
  const personaId = ctx.claimedPersonaId;
  const storeDir = ctx.claimedStoreDir;
  delete ctx.claimedPersonaId;
  delete ctx.claimedStoreDir;
  releasePersona(ctx.registry, storeDir, personaId);
}
