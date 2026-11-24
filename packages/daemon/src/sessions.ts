import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendSession, ArtinareyError, buildFirstPrompt, claimPersona, createApproval,
  endSession, getAutoApprove, isProcessAlive, newId, pendingApproval, readApprovals,
  readRoleCard, readSessions, readTasks, releasePersona, resolveApproval,
  resolveIdentity, riskyReasons, sessionLogFile, setAutoApprove,
  type Approval, type ApprovalKind, type ArtinareyErrorCode, type Identity,
  type Registry, type SessionSummary, type XdgPaths,
} from '@artinarey/core';

/**
 * The daemon is the only component that launches processes. The senior dev
 * requests a session through a tool; every spawn check (lease, worktree, cap,
 * pending work, approval) happens here, never in an agent. Supervisor state is
 * derived from the registry plus append-only files, so a daemon restart can
 * re-adopt live sessions and mark dead ones failed.
 */

export type SpawnRequest = {
  role?: string;
  persona_id?: string;
  task_id: string;
  vendor?: string;
  worktree_id?: string;
};

export type SpawnResult =
  | { ok: true; session: SessionSummary; vendorSessionId: string; message: string }
  | { ok: false; code: ArtinareyErrorCode; approvalId?: string; message: string };

export type PermissionRequest = {
  projectId: string;
  worktreeId: string;
  action?: string;
  resources?: string[];
  command?: string;
};

export type PermissionDecision = {
  effect: 'allow' | 'ask' | 'deny';
  message?: string;
  approvalId?: string;
};

/** The subset of OpencodeAdapter the supervisor needs; lets tests inject a fake. */
export type SessionAdapter = {
  ensureServe(): Promise<{ pid: number; port: number; password: string; startedAt: string }>;
  createSession(state: { pid: number; port: number; password: string; startedAt: string }, directory: string): Promise<string>;
  sendPrompt(state: { pid: number; port: number; password: string; startedAt: string }, sessionId: string, text: string, id?: string): Promise<void>;
  interrupt(state: { pid: number; port: number; password: string; startedAt: string }, sessionId: string): Promise<void>;
};

export type Notifier = (message: string) => void;
export type TimerApi = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type SupervisorOptions = {
  registry: Registry;
  paths: XdgPaths;
  adapter: SessionAdapter;
  rolesDir: string;
  spawnCap?: number;
  notifier?: Notifier;
  timers?: TimerApi;
};

const defaultNotifier: Notifier = (message) => {
  try {
    const child = spawn('/usr/bin/notify-send', ['Artinarey', message], {
      stdio: 'ignore', detached: true,
    });
    child.unref();
  } catch {
    // A missing desktop notifier must never block an agent or an approval.
  }
};

const defaultTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function fail(code: ArtinareyErrorCode, message: string, approvalId?: string): SpawnResult {
  return { ok: false, code, message, ...(approvalId ? { approvalId } : {}) };
}

export class SessionSupervisor {
  private readonly registry: Registry;
  private readonly paths: XdgPaths;
  private readonly adapter: SessionAdapter;
  private readonly rolesDir: string;
  private readonly spawnCap: number;
  private readonly notify: Notifier;
  private readonly timers: TimerApi;
  private readonly reminders = new Map<string, unknown[]>();

  constructor(options: SupervisorOptions) {
    this.registry = options.registry;
    this.paths = options.paths;
    this.adapter = options.adapter;
    this.rolesDir = options.rolesDir;
    this.spawnCap = options.spawnCap ?? 3;
    this.notify = options.notifier ?? defaultNotifier;
    this.timers = options.timers ?? defaultTimers;
  }

  private storeOf(projectId: string): string {
    const project = this.registry.projects.get(projectId);
    if (!project) throw new ArtinareyError('NOT_FOUND', `unknown project: ${projectId}`);
    return project.storeDir;
  }

  private summaryFile(projectId: string): string {
    return sessionLogFile(this.paths.cacheRoot, projectId);
  }

  /** Dead handles are failed once at startup; live ones keep their registry session. */
  adopt(): void {
    for (const project of this.registry.projects.list()) {
      const file = this.summaryFile(project.id);
      for (const session of readSessions(file)) {
        if (session.status !== 'running') continue;
        if (isProcessAlive(session.pid)) continue;
        endSession(file, session.id, 'failed');
        this.registry.sessions.end(session.id, new Date().toISOString());
      }
    }
  }

  sessions(projectId: string): SessionSummary[] {
    return readSessions(this.summaryFile(projectId));
  }

  liveCount(projectId: string): number {
    return this.registry.sessions.list(projectId).filter((session) => !session.endedAt).length;
  }

  approvals(projectId?: string): Approval[] {
    const projects = projectId
      ? this.registry.projects.list().filter((p) => p.id === projectId)
      : this.registry.projects.list();
    return projects.flatMap((p) => readApprovals(p.storeDir));
  }

  /** Approval decisions are user actions; the CLI is the only caller. */
  async approve(
    id: string,
    decision: 'approved' | 'rejected',
    by = 'user',
  ): Promise<{ approval: Approval; spawn?: SpawnResult }> {
    const approval = this.approvals().find((a) => a.id === id);
    if (!approval) throw new ArtinareyError('NOT_FOUND', `unknown approval: ${id}`);
    const resolved = resolveApproval(this.storeOf(approval.projectId), id, decision, by);
    for (const handle of this.reminders.get(id) ?? []) this.timers.clear(handle);
    this.reminders.delete(id);
    const result: { approval: Approval; spawn?: SpawnResult } = { approval: resolved };
    if (decision === 'approved' && resolved.kind === 'spawn_cap' && resolved.payload) {
      const caller = this.callerFromPayload(resolved);
      result.spawn = await this.requestSession(caller, resolved.payload as unknown as SpawnRequest,
        { approved: true });
    }
    return result;
  }

  private callerFromPayload(approval: Approval): Identity {
    const payload = approval.payload ?? {};
    const personaId = String(payload.caller_persona_id ?? '');
    const worktreeId = String(payload.caller_worktree_id ?? '');
    const persona = this.registry.personas.get(personaId);
    const worktree = this.registry.worktrees.list(approval.projectId)
      .find((wt) => wt.id === worktreeId);
    if (!persona || !worktree) {
      throw new ArtinareyError('NOT_FOUND', 'the approving session context no longer exists');
    }
    return {
      projectId: approval.projectId,
      worktreeId: worktree.id,
      markerDir: worktree.path,
      storeDir: this.storeOf(approval.projectId),
      personaId: persona.id,
      role: persona.role,
    };
  }

  toggle(worktreeId: string, enabled: boolean): void {
    let found = false;
    for (const project of this.registry.projects.list()) {
      if (this.registry.worktrees.list(project.id).some((wt) => wt.id === worktreeId)) {
        setAutoApprove(this.registry, worktreeId, enabled);
        found = true;
        break;
      }
    }
    if (!found) throw new ArtinareyError('NOT_FOUND', `unknown worktree: ${worktreeId}`);
  }

  isAutoApprove(worktreeId: string): boolean {
    return getAutoApprove(this.registry, worktreeId);
  }

  /** The shim/plugin hook asks the daemon for the decision and audit trail. */
  evaluatePermission(input: PermissionRequest): PermissionDecision {
    const worktree = this.registry.worktrees.list(input.projectId)
      .find((wt) => wt.id === input.worktreeId);
    if (!worktree) return { effect: 'deny', message: 'unknown worktree for this session' };
    const resources = input.resources ?? [];
    const outside = resources.filter((resource) => {
      const target = resource.startsWith('/') ? resource : join(worktree.path, resource);
      return !target.startsWith(`${worktree.path}/`) && target !== worktree.path;
    });
    const reasons = riskyReasons(input.command ?? '', worktree.path);
    if (outside.length > 0) reasons.push(`outside worktree: ${outside.join(', ')}`);
    if (reasons.length === 0) return { effect: 'allow' };
    if (this.isAutoApprove(worktree.id)
        && !reasons.some((reason) => reason.startsWith('outside worktree'))) {
      return { effect: 'allow' };
    }
    const storeDir = this.storeOf(input.projectId);
    const key = { projectId: input.projectId, kind: 'risky_call' as ApprovalKind,
      worktreeId: worktree.id };
    const existing = pendingApproval(storeDir, key);
    const approval = existing ?? createApproval(storeDir, {
      ...key,
      id: newId(),
      summary: `${worktree.path}: ${reasons.join('; ')}`,
    });
    if (!existing) this.schedule(approval.id, approval.summary);
    return {
      effect: 'ask',
      approvalId: approval.id,
      message: `Waiting for user approval ${approval.id}: ${reasons.join('; ')}`,
    };
  }

  private schedule(id: string, summary: string): void {
    this.notify(`Approval needed: ${summary} (artinarey approve ${id})`);
    const handles = [5 * 60_000, 15 * 60_000].map((ms) => this.timers.set(() => {
      const stillPending = this.approvals().some((a) => a.id === id && a.status === 'pending');
      if (stillPending) this.notify(`Approval still waiting: ${id} — ${summary}`);
    }, ms));
    this.reminders.set(id, handles);
  }

  /** Escalate a blocked spawn to the user; agents cannot self-approve. */
  private blockingApproval(
    input: SpawnRequest,
    caller: Identity,
    kind: 'active_worktree' | 'pending_work',
    summary: string,
  ): SpawnResult {
    const storeDir = this.storeOf(caller.projectId);
    const key = { projectId: caller.projectId, kind, worktreeId: input.worktree_id ?? null };
    const existing = pendingApproval(storeDir, key);
    const approval = existing ?? createApproval(storeDir, {
      ...key,
      id: newId(),
      personaId: input.persona_id ?? input.role ?? null,
      summary,
      payload: { ...input, caller_persona_id: caller.personaId,
        caller_worktree_id: caller.worktreeId },
    });
    if (!existing) this.schedule(approval.id, summary);
    return fail('NEEDS_CONFIRMATION',
      `Only the user may approve this session (approval ${approval.id}): ${summary}`, approval.id);
  }

  async requestSession(
    caller: Identity,
    input: SpawnRequest,
    options: { approved?: boolean } = {},
  ): Promise<SpawnResult> {
    if (caller.role !== 'senior-dev') {
      return fail('FORBIDDEN_ROLE', 'only the senior dev may request sessions');
    }
    const storeDir = this.storeOf(caller.projectId);
    const task = readTasks(storeDir).find((t) => t.id === input.task_id);
    if (!task) return fail('NOT_FOUND', `no task with id ${input.task_id}`);
    if (task.status === 'done' || task.scope.length === 0) {
      return fail('INVALID_INPUT', 'task has no active lease');
    }
    const worktrees = this.registry.worktrees.list(caller.projectId);
    const worktree = (input.worktree_id
      ? worktrees.find((wt) => wt.id === input.worktree_id)
      : worktrees.find((wt) => wt.id === task.worktreeId)
        ?? worktrees.find((wt) => wt.branch === task.branch)
        ?? worktrees.find((wt) => wt.id === caller.worktreeId));
    if (!worktree) return fail('NOT_FOUND', 'task has no registered worktree');

    const personas = this.registry.personas.list(caller.projectId);
    const persona = (input.persona_id
      ? personas.find((p) => p.id === input.persona_id)
      : personas.find((p) => p.role === input.role));
    if (!persona) return fail('NOT_FOUND', `unknown persona: ${input.persona_id ?? input.role}`);

    const bound = this.registry.bindings.forWorktree(worktree.id);
    if (bound && bound.id !== persona.id) {
      return this.blockingApproval(input, caller, 'active_worktree',
        `${worktree.path} is active as ${bound.role}; stop or release it first`);
    }
    const pending = readTasks(storeDir).some((t) => t.worktreeId === worktree.id
      && t.status !== 'done' && t.assignee !== persona.role);
    if (pending) {
      return this.blockingApproval(input, caller, 'pending_work',
        `${worktree.path} has pending work for another persona`);
    }
    const liveElsewhere = this.registry.sessions.list(caller.projectId)
      .some((session) => !session.endedAt && session.personaId === persona.id);
    if (liveElsewhere) return fail('DIRECTORY_BUSY', `${persona.role} already has a live session`);

    if (!options.approved && this.liveCount(caller.projectId) >= this.spawnCap) {
      const store = this.storeOf(caller.projectId);
      const existing = pendingApproval(store, { projectId: caller.projectId, kind: 'spawn_cap' });
      const approval = existing ?? createApproval(store, {
        id: newId(), projectId: caller.projectId, kind: 'spawn_cap',
        worktreeId: worktree.id, personaId: persona.id,
        summary: `Spawn cap ${this.spawnCap} reached; ${persona.role} waits for user approval`,
        payload: { ...input, caller_persona_id: caller.personaId,
          caller_worktree_id: caller.worktreeId },
      });
      if (!existing) this.schedule(approval.id, approval.summary);
      return fail('CAP_REACHED',
        `Spawn cap ${this.spawnCap} reached (token consumption rises with parallel sessions). Approval ${approval.id} is pending.`,
        approval.id);
    }

    const target = resolveIdentity(this.registry, worktree.path);
    if (!target.ok) return fail(target.code, target.message);
    // The senior dev is exempt from the home-worktree confirmation (plan.md §6).
    const claim = claimPersona(this.registry, storeDir, target.identity, {
      personaId: persona.id, confirmMove: true,
    });
    if (!claim.ok) return fail(claim.code, claim.message);

    let sessionId: string | undefined;
    try {
      const serve = await this.adapter.ensureServe();
      const vendorSessionId = await this.adapter.createSession(serve, worktree.path);
      sessionId = this.registry.sessions.append({
        projectId: caller.projectId,
        worktreeId: worktree.id,
        personaId: persona.id,
        vendor: input.vendor ?? 'opencode',
        startedAt: new Date().toISOString(),
        createdBinding: !bound,
      });
      const logFile = join(this.paths.cacheRoot, 'logs', `${sessionId}.log`);
      mkdirSync(join(this.paths.cacheRoot, 'logs'), { recursive: true });
      const handoffFile = join(storeDir, 'personas', persona.id, 'handoff.md');
      const prompt = buildFirstPrompt({
        role: persona.role,
        roleCard: readRoleCard(this.rolesDir, persona.role),
        handoff: existsSync(handoffFile) ? readFileSync(handoffFile, 'utf8').trim() : '',
        task: { id: task.id, title: task.title, scope: task.scope, body: '' },
      });
      const summary: SessionSummary = {
        id: sessionId,
        projectId: caller.projectId,
        worktreeId: worktree.id,
        personaId: persona.id,
        vendor: input.vendor ?? 'opencode',
        vendorSessionId,
        pid: serve.pid,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'running',
        logFile,
      };
      appendSession(this.summaryFile(caller.projectId), summary);
      appendFileSync(logFile, `> first prompt (session ${vendorSessionId})\n${prompt}\n`);
      await this.adapter.sendPrompt(serve, vendorSessionId, prompt, `${sessionId}-first`);
      this.registry.personas.setVendor(persona.id, summary.vendor, vendorSessionId);
      return {
        ok: true,
        session: summary,
        vendorSessionId,
        message: `Started ${persona.role} in ${worktree.path} (session ${vendorSessionId}).`,
      };
    } catch (err) {
      if (sessionId) this.registry.sessions.end(sessionId, new Date().toISOString());
      if (!bound) {
        try { releasePersona(this.registry, storeDir, persona.id); } catch { /* best effort */ }
      }
      return fail('STORE_OFFLINE', `spawn failed: ${(err as Error).message ?? String(err)}`);
    }
  }

  stopSession(id: string): boolean {
    const summaries = this.registry.projects.list()
      .flatMap((project) => readSessions(this.summaryFile(project.id)));
    const session = summaries.find((s) => s.id === id && s.status === 'running');
    if (!session) return false;
    endSession(this.summaryFile(session.projectId), id, 'stopped');
    this.registry.sessions.end(id, new Date().toISOString());
    return true;
  }
}
