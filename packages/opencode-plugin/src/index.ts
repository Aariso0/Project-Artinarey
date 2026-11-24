import { isAbsolute, relative } from 'node:path';
import {
  callDaemon,
} from '@artinarey/daemon';
import {
  findMarker, openRegistry, readTasks, resolveXdgPaths, riskyReasons, uncoveredFiles,
  type XdgPaths,
} from '@artinarey/core';

const WRITE_ACTIONS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
/** OpenCode V2 reports shell commands under the `shell` action. */
const SHELL_ACTIONS = new Set(['shell', 'bash']);

type Evaluation = {
  /** OpenCode's permission hook data identifies the caller with `sessionID`. */
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: 'allow' | 'ask' | 'deny';
  message?: string;
};

type PluginContext = {
  readonly location: { readonly directory: string };
  permission: {
    hook(name: 'evaluate', callback: (event: Evaluation) => void | Promise<void>): Promise<unknown>;
  };
};

export type DaemonCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}>;

export type EvaluateDeps = {
  call: DaemonCall;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

type MarkerInfo = { projectId: string; worktreeId: string };

function leaseDenial(dir: string, marker: MarkerInfo, event: Evaluation): string | undefined {
  if (!WRITE_ACTIONS.has(event.action) || event.effect === 'deny') return undefined;
  let storeDir: string | undefined;
  try {
    const registry = openRegistry(resolveXdgPaths().registryFile);
    try {
      storeDir = registry.projects.get(marker.projectId)?.storeDir;
    } finally {
      registry.close();
    }
  } catch {
    return undefined; // the daemon/CLI still enforce the lease
  }
  if (!storeDir) return undefined;

  const tasks = readTasks(storeDir)
    .filter((task) => task.worktreeId === marker.worktreeId && task.status !== 'done');
  if (tasks.length === 0) return undefined;
  const paths = event.resources
    .map((resource) => (isAbsolute(resource) ? relative(dir, resource) : resource))
    .filter((path) => path !== '' && !path.startsWith('..'));
  if (paths.length === 0) return undefined;
  const outside = uncoveredFiles(tasks, paths);
  return outside.length > 0 ? `Outside active lease: ${outside.join(', ')}` : undefined;
}

function riskyReasonsFor(event: Evaluation, dir: string): string[] {
  if (SHELL_ACTIONS.has(event.action)) {
    return event.resources
      .flatMap((command) => riskyReasons(command, dir))
      .filter((reason, index, all) => all.indexOf(reason) === index);
  }
  if (event.action === 'external_directory') {
    return event.resources.map((resource) => `outside worktree: ${resource}`);
  }
  return [];
}

/**
 * Ask the daemon once, then wait on the Artinarey approval. The daemon owns all
 * approval state and notifications; the plugin only mirrors the decision into
 * OpenCode's permission system. A blocked tool call stays blocked until the user
 * runs `artinarey approve <id>` from the CLI, with no timeout auto-fail.
 */
export async function evaluateRiskyCall(
  event: Evaluation,
  marker: MarkerInfo,
  dir: string,
  deps: EvaluateDeps,
): Promise<void> {
  const reasons = riskyReasonsFor(event, dir);
  if (reasons.length === 0) return;
  const decision = await deps.call('evaluate_permission', {
    projectId: marker.projectId,
    worktreeId: marker.worktreeId,
    sessionId: event.sessionID,
    action: event.action,
    resources: [...event.resources],
    command: event.resources.join(' '),
  });
  if (!decision.ok) {
    // The daemon still owns the rule; never silently allow inside its hook.
    event.effect = 'deny';
    event.message = `Artinarey could not check this risky call: ${decision.error?.message ?? 'daemon offline'}`;
    return;
  }
  const result = decision.result as { effect: 'allow' | 'ask' | 'deny'; message?: string; approvalId?: string };
  if (result.effect !== 'ask') {
    if (result.effect === 'deny') {
      event.effect = 'deny';
      event.message = result.message ?? 'Denied by Artinarey';
    }
    return;
  }
  event.effect = 'ask';
  event.message = result.message ?? 'Waiting for user approval';
  const approvalId = result.approvalId;
  if (!approvalId) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? 1000;
  // Indefinite by design (plan.md §9): only the user resolves a pending approval.
  for (;;) {
    await sleep(pollMs);
    const status = await deps.call('approval_status', { id: approvalId });
    if (!status.ok) continue;
    const state = (status.result as { status: string }).status;
    if (state === 'approved') {
      event.effect = 'allow';
      event.message = `Approved ${approvalId}`;
      return;
    }
    if (state === 'rejected') {
      event.effect = 'deny';
      event.message = `Rejected ${approvalId}`;
      return;
    }
  }
}

/**
 * Checkpoint 1 of plan.md §8: deny edits to files outside the active worktree
 * lease, and (M5) gate risky shell calls through the daemon's approval flow.
 * Hooks run only for allow/ask; an explicit configured deny is already final.
 * OpenCode's `Plugin.define` is an identity helper, so the default export is a
 * plain `{ id, setup }` object and needs no SDK package.
 */
export default {
  id: 'artinarey.lease-guard',
  async setup(ctx: PluginContext) {
    await ctx.permission.hook('evaluate', async (event) => {
      if (event.effect === 'deny') return;
      const dir = ctx.location.directory;
      const markerFound = findMarker(dir);
      if (!markerFound || markerFound.dir !== dir) return;
      const marker: MarkerInfo = {
        projectId: markerFound.marker.project_id,
        worktreeId: markerFound.marker.worktree_id,
      };

      const outside = leaseDenial(dir, marker, event);
      if (outside) {
        event.effect = 'deny';
        event.message = outside;
        return;
      }

      const paths = resolveXdgPaths();
      await evaluateRiskyCall(event, marker, dir, {
        call: (method, params) => callDaemon(paths, method, params),
      });
    });
  },
};

/** Re-exported so a host can inject a different XDG root in one place. */
export function pluginPaths(env: NodeJS.ProcessEnv = process.env): XdgPaths {
  return resolveXdgPaths(env);
}
