import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { appendJournal, atomicWrite } from './store.ts';
import type { Registry } from './registry.ts';

/**
 * M5 session, approval and containment helpers. All state is local: approvals
 * and auto-approve toggles live in the registry, session summaries and the
 * OpenCode serve handle live under the XDG cache/config roots. These are data,
 * never authority: the permission gate re-checks every path on use.
 */

export type ApprovalKind =
  | 'spawn_cap'
  | 'risky_call'
  | 'active_worktree'
  | 'pending_work'
  | 'scope_request';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type Approval = {
  id: string;
  projectId: string;
  kind: ApprovalKind;
  worktreeId: string | null;
  personaId: string | null;
  summary: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Identifies the exact reviewed action; absent on older records. */
  fingerprint?: string;
  /** Opaque resume data so an approved over-cap spawn can continue. */
  payload?: Record<string, unknown>;
};

export type ApprovalInput = Pick<Approval,
  'id' | 'projectId' | 'kind' | 'summary'> & Partial<Pick<Approval,
  'worktreeId' | 'personaId' | 'fingerprint' | 'payload'>>;

export type ApprovalFingerprintInput = {
  projectId: string;
  worktreeId: string | null;
  action?: string;
  resources?: readonly string[];
  command?: string;
  sessionId?: string;
};

/**
 * Stable digest of everything an operator is being asked to approve. Resource
 * order and duplicates do not matter; every other field does, including the
 * OpenCode session that made the call.
 */
export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  const resources = [...new Set(input.resources ?? [])].sort();
  const canonical = [
    input.projectId ?? '',
    input.worktreeId ?? '',
    input.action ?? '',
    resources,
    input.command ?? '',
    input.sessionId ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function approvalFile(storeDir: string): string {
  return join(storeDir, 'events', 'approvals.jsonl');
}

/** A torn last line is a partial append; skip it rather than invent an approval. */
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as T;
      if (value && typeof value === 'object') rows.push(value);
    } catch {
      // ignore a torn line
    }
  }
  return rows;
}

export function readApprovals(storeDir: string): Approval[] {
  return readJsonl<Approval>(approvalFile(storeDir));
}

/** Latest state per id wins; approvals are small and rewritten atomically on resolve. */
export function createApproval(storeDir: string, input: ApprovalInput): Approval {
  const approval: Approval = {
    ...input,
    worktreeId: input.worktreeId ?? null,
    personaId: input.personaId ?? null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
  appendJournal(approvalFile(storeDir), approval);
  return approval;
}

/**
 * Pending approval for this key, if one is already waiting on the user. A
 * fingerprint-scoped lookup never matches a legacy record without one.
 */
export function pendingApproval(
  storeDir: string,
  match: Pick<Approval, 'projectId' | 'kind'>
    & Partial<Pick<Approval, 'worktreeId' | 'fingerprint'>>,
): Approval | undefined {
  return readApprovals(storeDir).find((a) => a.status === 'pending'
    && a.projectId === match.projectId && a.kind === match.kind
    && (match.worktreeId === undefined || a.worktreeId === match.worktreeId)
    && (match.fingerprint === undefined || a.fingerprint === match.fingerprint));
}

export function resolveApproval(
  storeDir: string,
  id: string,
  decision: 'approved' | 'rejected',
  resolvedBy: string,
): Approval {
  const approvals = readApprovals(storeDir);
  const index = approvals.findIndex((a) => a.id === id);
  if (index < 0) throw new ArtinareyError('NOT_FOUND', `unknown approval: ${id}`);
  if (approvals[index]!.status !== 'pending') {
    throw new ArtinareyError('INVALID_INPUT', `approval ${id} is already ${approvals[index]!.status}`);
  }
  const updated: Approval = {
    ...approvals[index]!,
    status: decision,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  };
  approvals[index] = updated;
  atomicWrite(approvalFile(storeDir), `${approvals.map((a) => JSON.stringify(a)).join('\n')}\n`);
  appendJournal(join(storeDir, 'events', 'audit.jsonl'), {
    type: 'approval_resolved', approval_id: id, decision, resolved_by: resolvedBy,
  });
  return updated;
}

const AUTO_APPROVE_PREFIX = 'auto_approve:';

function autoApproveKey(worktreeId: string): string {
  return `${AUTO_APPROVE_PREFIX}${worktreeId}`;
}

/** OFF by default: an absent setting is never a silent allow. */
export function getAutoApprove(registry: Registry, worktreeId: string): boolean {
  return registry.settings.get(autoApproveKey(worktreeId)) === 'on';
}

/** User-only by policy; the daemon enforces that on the RPC path. */
export function setAutoApprove(registry: Registry, worktreeId: string, enabled: boolean): void {
  registry.settings.set(autoApproveKey(worktreeId), enabled ? 'on' : 'off');
}

export type ServeState = {
  pid: number;
  port: number;
  password: string;
  startedAt: string;
};

export function readServeState(file: string): ServeState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServeState>;
    if (!Number.isInteger(raw.pid) || !Number.isInteger(raw.port)
        || typeof raw.password !== 'string') return undefined;
    return raw as ServeState;
  } catch {
    return undefined;
  }
}

/** The serve password is a secret: 0600, like the daemon token. */
export function writeServeState(file: string, state: ServeState): void {
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function serveStateFile(configDir: string): string {
  return join(configDir, 'opencode-serve.json');
}

export type SessionStatus = 'running' | 'done' | 'failed' | 'stopped';

export type SessionSummary = {
  id: string;
  projectId: string;
  worktreeId: string;
  personaId: string;
  vendor: string;
  vendorSessionId: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  logFile: string;
};

export function sessionLogFile(cacheRoot: string, projectId: string): string {
  return join(cacheRoot, projectId, 'sessions.jsonl');
}

export function readSessions(file: string): SessionSummary[] {
  return readJsonl<SessionSummary>(file);
}

export function appendSession(file: string, session: SessionSummary): void {
  appendJournal(file, session);
}

export function endSession(
  file: string, id: string, status: Exclude<SessionStatus, 'running'>,
  endedAt = new Date().toISOString(),
): void {
  const sessions = readSessions(file);
  const index = sessions.findIndex((s) => s.id === id);
  if (index < 0) return;
  sessions[index] = { ...sessions[index]!, status, endedAt };
  atomicWrite(file, `${sessions.map((s) => JSON.stringify(s)).join('\n')}\n`);
}

/** No pidfd in Node 26: a live pid plus a open socket is the settled fallback. */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const RISKY_COMMAND = /\b(curl|wget|nc|ncat|ssh|scp|sftp|rsync|git\s+push|git\s+fetch|git\s+pull|git\s+clone|git\s+config\s+--global|npm\s+publish|docker\s+push|kubectl)\b/i;

/**
 * Best-effort detector, not a sandbox (plan.md §13): a command is risky when it
 * names a network/global-git tool or a path outside the assigned worktree.
 * Shell variables, pipes into interpreters and relative escapes can evade it;
 * the README states this residual risk openly.
 */
export function riskyReasons(command: string, worktreeDir: string): string[] {
  const reasons: string[] = [];
  if (RISKY_COMMAND.test(command)) reasons.push('network or global git operation');
  const root = resolve(worktreeDir);
  const tokens = command.match(/[^\s"'`;|&<>]+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/,$/, '');
    if (!isAbsolute(token) && !token.includes('..')) continue;
    const target = resolve(root, token);
    if (target !== root && !target.startsWith(`${root}/`)) {
      reasons.push(`path outside worktree: ${token}`);
      break;
    }
  }
  return reasons;
}

export function roleCardFile(rolesDir: string, role: string): string {
  return join(rolesDir, `${role}.md`);
}

export function readRoleCard(rolesDir: string, role: string): string {
  const file = roleCardFile(rolesDir, role);
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

export type FirstPromptInput = {
  role: string;
  roleCard: string;
  handoff: string;
  task: { id: string; title: string; scope: string[]; body: string };
};

/** New sessions get the role card, handoff note and the lease, not old context. */
export function buildFirstPrompt(input: FirstPromptInput): string {
  const sections = [
    input.roleCard || `You are the ${input.role}.`,
    input.handoff ? `## Handoff from the previous persona\n${input.handoff}` : '',
    `## Task ${input.task.id}: ${input.task.title}\n${input.task.body}`,
    `## Scope (your lease)\n${input.task.scope.map((path) => `- ${path}`).join('\n')}`,
    'Call `check_in` first. Then work only inside your lease. Calls that reach outside it are detected and need user approval. Check `inbox` at task start and end.',
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** Detect a file mode without following symlinks, for the 0600 secret files. */
export function fileMode(file: string): number | undefined {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat ? stat.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}
