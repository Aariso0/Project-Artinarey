import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  adoptWorktree, atomicWrite, branchChangedFiles, buildIndex, changedFiles, claimPersona,
  createWorktree, findMarker,
  listGitWorktrees, loadConfig, openRegistry, planWorktree, readPersona, readTasks,
  reconcileWorktrees, rehomePersona, releasePersona, removeWorktree, resolveIdentity, resolveRepo,
  resolveXdgPaths, roster, rollbackFailedClaim, saveConfig, uncoveredFiles,
  cloneProjectInto, registerProjectAt,
} from '@artinarey/core';
import { callDaemon, daemonStatus, startDaemon, stopDaemon } from '@artinarey/daemon';

const MCP_TOOLS = [
  'check_in', 'claim_persona', 'inbox', 'read_mail',
  'send_mail', 'mark_done', 'report', 'worktrees',
  'task_update', 'request_scope', 'assign_task', 'request_session',
] as const;

const VENDOR_COMMANDS: Record<string, string> = { opencode: 'opencode' };
const RUN_USAGE =
  'usage: artinarey run <vendor> --persona <persona> [--confirm-move] [--rehome] [--yes]';

/**
 * Overlap policy: the claim stays bound while any other live session for this
 * persona+worktree remains; only the last run releases it. An unended session
 * older than this window is treated as stale so a crashed run cannot pin a claim
 * forever. 24h is deliberately conservative.
 */
const ACTIVE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function shimCommand(): string[] {
  const require = createRequire(import.meta.url);
  return [
    process.execPath,
    '--import',
    require.resolve('tsx/esm'),
    join(rootDir(), 'packages', 'shim', 'src', 'index.ts'),
  ];
}

function rootDir(): string {
  return process.env.ARTINAREY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

type OpenCodeConfig = Record<string, unknown> & {
  mcp?: { servers?: Record<string, unknown> };
  permissions?: Array<{ action: string; resource: string; effect: string }>;
};

type RegistryHandle = ReturnType<typeof openRegistry>;
type ClaimedPersona = Extract<ReturnType<typeof claimPersona>, { ok: true }>;
type Resolution = { id?: string; error?: string };

/** Exact id first, then a unique role. Personas are resolved inside the current project. */
function resolvePersona(registry: RegistryHandle, projectId: string, token: string): Resolution {
  const personas = registry.personas.list(projectId);
  const exact = personas.find((persona) => persona.id === token);
  if (exact) return { id: exact.id };
  const matches = personas.filter((persona) => persona.role === token);
  if (matches.length > 1) return { error: `ambiguous persona: ${token}` };
  return { id: matches[0]?.id };
}

function resolveWorktree(registry: RegistryHandle, token: string): Resolution {
  const matches = registry.projects.list()
    .flatMap((project) => registry.worktrees.list(project.id))
    .filter((worktree) => worktree.id === token || worktree.path === token
      || basename(worktree.path) === token || worktree.branch === token
      || worktree.branch === `artinarey/${token}`);
  if (matches.length > 1) return { error: `ambiguous worktree: ${token}` };
  return { id: matches[0]?.id };
}

/** Bindings have no by-persona lookup, so find the worktree this persona came from. */
function boundWorktree(
  registry: RegistryHandle, personaId: string,
): { id: string; path: string } | undefined {
  for (const project of registry.projects.list()) {
    for (const worktree of registry.worktrees.list(project.id)) {
      if (registry.bindings.forWorktree(worktree.id)?.id === personaId) {
        return { id: worktree.id, path: worktree.path };
      }
    }
  }
  return undefined;
}

/** Git is the authority on whether a registered worktree is still attached here. */
function isManagedWorktree(
  registry: RegistryHandle, projectId: string, worktreeId: string, markerDir: string,
): boolean {
  try {
    const { root } = resolveRepo(markerDir);
    return reconcileWorktrees(registry, projectId, listGitWorktrees(root))
      .some((row) => row.state === 'managed' && row.worktreeId === worktreeId);
  } catch {
    return false;
  }
}

async function confirmInTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((done) => prompt.question(question, done));
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

function connectOpencode(cwd: string): void {
  const file = join(cwd, 'opencode.json');
  const config: OpenCodeConfig = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')) as OpenCodeConfig
    : {};

  config.mcp = {
    ...config.mcp,
    servers: {
      ...config.mcp?.servers,
      artinarey: { type: 'local', command: shimCommand(), disabled: false },
    },
  };

  const ours = new Set(MCP_TOOLS.map((tool) => `artinarey_${tool}`));
  const kept = (config.permissions ?? []).filter((rule) => !ours.has(rule.action));
  config.permissions = [
    ...kept,
    ...MCP_TOOLS.map((tool) => ({ action: `artinarey_${tool}`, resource: '*', effect: 'allow' })),
  ];

  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  const [command, ...args] = argv;

  if (command === 'init') {
    try {
      const result = registerProjectAt(cwd, env);
      console.log(`hooks: ${result.hooksNote}`);
      console.log(`global ignore: ${result.globalIgnore}`);
      return 0;
    } catch (err) {
      console.error(`init failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'project' && args[0] === 'open') {
    const path = args[1];
    if (!path) {
      console.error('usage: artinarey project open <path>');
      return 2;
    }
    try {
      const result = registerProjectAt(path, env);
      console.log(`project ${result.name}: ${result.path}`);
      console.log(`hooks: ${result.hooksNote}`);
      console.log(`global ignore: ${result.globalIgnore}`);
      return 0;
    } catch (err) {
      console.error(`project open failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'project' && args[0] === 'clone') {
    const [url, target] = args.slice(1);
    if (!url || !target) {
      console.error('usage: artinarey project clone <url> <folder>');
      return 2;
    }
    try {
      const result = await cloneProjectInto(url, target, env, cwd);
      console.log(`project ${result.name}: ${result.path}`);
      console.log(`hooks: ${result.hooksNote}`);
      console.log(`global ignore: ${result.globalIgnore}`);
      return 0;
    } catch (err) {
      console.error(`project clone failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'worktree' && args[0] === 'new') {
    const name = args[1];
    const yes = args.includes('--yes');
    const baseIndex = args.indexOf('--base');
    const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
    if (!name || name.startsWith('--') ||
        (baseIndex !== -1 && (!base || base.startsWith('--')))) {
      console.error('usage: artinarey worktree new <name> [--base REF] [--yes]');
      return 2;
    }
    try {
      const { root, commonDir } = resolveRepo(cwd);
      const marker = findMarker(cwd);
      if (!marker) {
        console.error('no .artinarey.json found; run artinarey init');
        return 1;
      }
      const registry = openRegistry(resolveXdgPaths(env).registryFile);
      try {
        const project = registry.projects.get(marker.marker.project_id);
        if (!project) {
          console.error(`unknown project: ${marker.marker.project_id}`);
          return 1;
        }
        if (project.repoCommonDir !== commonDir) {
          console.error('marker project belongs to a different git repository');
          return 1;
        }
        const plan = planWorktree(registry, project.id, root, name, base);
        if (!yes) {
          console.log('C4: Artinarey will create the following in the new worktree:');
          console.log('  .artinarey.json');
          console.log(`  .env.artinarey with ARTINAREY_PORT_OFFSET=${plan.portOffset}`);
          for (const file of plan.copy) console.log(`  copy ${file} from ${root}`);
          console.log('Re-run with --yes to confirm.');
          return 2;
        }
        const worktree = createWorktree(registry, project.storeDir, plan);
        console.log(`created ${worktree.path} on ${worktree.branch} (port offset ${worktree.portOffset})`);
        return 0;
      } finally {
        registry.close();
      }
    } catch (err) {
      console.error(`worktree new failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'worktree' && args[0] === 'adopt') {
    const target = args[1];
    if (!target || target.startsWith('--')) {
      console.error('usage: artinarey worktree adopt <path>');
      return 2;
    }
    try {
      const marker = findMarker(cwd);
      if (!marker) {
        console.error('no .artinarey.json found; run artinarey init');
        return 1;
      }
      const registry = openRegistry(resolveXdgPaths(env).registryFile);
      try {
        const project = registry.projects.get(marker.marker.project_id);
        if (!project) {
          console.error(`unknown project: ${marker.marker.project_id}`);
          return 1;
        }
        const worktree = adoptWorktree(registry, project.storeDir, project.id, resolve(cwd, target));
        console.log(`adopted ${worktree.path} on ${worktree.branch ?? 'detached'} (${worktree.id})`);
        return 0;
      } finally {
        registry.close();
      }
    } catch (err) {
      console.error(`worktree adopt failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'worktree' && args[0] === 'remove') {
    const name = args[1];
    if (!name || name.startsWith('--')) {
      console.error('usage: artinarey worktree remove <name>');
      return 2;
    }
    try {
      const marker = findMarker(cwd);
      if (!marker) {
        console.error('no .artinarey.json found; run artinarey init');
        return 1;
      }
      const registry = openRegistry(resolveXdgPaths(env).registryFile);
      try {
        const project = registry.projects.get(marker.marker.project_id);
        if (!project) {
          console.error(`unknown project: ${marker.marker.project_id}`);
          return 1;
        }
        const rows = registry.worktrees.list(project.id);
        const row = rows.find((wt) => wt.id === name)
          ?? rows.find((wt) => basename(wt.path) === name)
          ?? rows.find((wt) => wt.branch === name || wt.branch === `artinarey/${name}`);
        if (!row) {
          console.error(`unknown worktree: ${name}`);
          return 1;
        }
        const removal = removeWorktree(registry, project.id, row.id);
        console.log(`removed ${row.path}`);
        if (!removal.auditWritten) {
          console.error(`warning: worktree removed but audit event was not written: ${removal.auditError ?? 'unknown error'}`);
        }
        return 0;
      } finally {
        registry.close();
      }
    } catch (err) {
      console.error(`worktree remove failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'worktree') {
    if (args[0] !== 'list') {
      console.error('usage: artinarey worktree new <name> [--base REF] [--yes] | adopt <path> | remove <name> | list');
      return 2;
    }
    try {
      const { root } = resolveRepo(cwd);
      const marker = findMarker(cwd);
      if (!marker) {
        console.error('no .artinarey.json found; run artinarey init');
        return 1;
      }
      const registry = openRegistry(resolveXdgPaths(env).registryFile);
      try {
        const project = registry.projects.get(marker.marker.project_id);
        if (!project) {
          console.error(`unknown project: ${marker.marker.project_id}`);
          return 1;
        }
        for (const row of reconcileWorktrees(registry, project.id, listGitWorktrees(root))) {
          const id = row.worktreeId ? ` ${row.worktreeId}` : '';
          const flag = row.flag ? ` ${row.flag}` : '';
          console.log(`${row.state} ${row.path} (${row.branch ?? 'detached'})${id}${flag}`);
        }
        return 0;
      } finally {
        registry.close();
      }
    } catch (err) {
      console.error(`worktree list failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'persona') {
    const subcommand = args[0];
    const usage = 'usage: artinarey persona list | rehome <persona> <worktree>';
    if ((subcommand !== 'list' && subcommand !== 'rehome')
        || (subcommand === 'rehome' && (args.length !== 3
          || args[1]?.startsWith('--') || args[2]?.startsWith('--')))) {
      console.error(usage);
      return 2;
    }
    try {
      const marker = findMarker(cwd);
      if (!marker) {
        console.error('no .artinarey.json found; run artinarey init');
        return 1;
      }
      const registry = openRegistry(resolveXdgPaths(env).registryFile);
      try {
        const project = registry.projects.get(marker.marker.project_id);
        if (!project) {
          console.error(`unknown project: ${marker.marker.project_id}`);
          return 1;
        }
        if (subcommand === 'list') {
          const paths = new Map(registry.projects.list()
            .flatMap((row) => registry.worktrees.list(row.id)
              .map((worktree): [string, string] => [worktree.id, worktree.path])));
          for (const entry of roster(registry, project.storeDir, project.id)) {
            const home = entry.homeWorktreeId
              ? `${entry.homeWorktreeId} ${paths.get(entry.homeWorktreeId) ?? ''}`.trim()
              : '-';
            console.log(`${entry.role} ${entry.name} ${home} ${entry.state}`);
          }
          return 0;
        }

        const persona = resolvePersona(registry, project.id, args[1] ?? '');
        const worktree = resolveWorktree(registry, args[2] ?? '');
        if (persona.error || worktree.error) {
          console.error(persona.error ?? worktree.error);
          return 1;
        }
        if (!persona.id) {
          console.error(`unknown persona: ${args[1]}`);
          return 1;
        }
        if (!worktree.id) {
          console.error(`unknown worktree: ${args[2]}`);
          return 1;
        }
        const result = rehomePersona(registry, project.storeDir, persona.id, worktree.id);
        if (!result.ok) {
          console.error(result.message);
          return 1;
        }
        console.log(`rehomed ${persona.id} to ${worktree.id}`);
        return 0;
      } finally {
        registry.close();
      }
    } catch (err) {
      console.error(`persona ${subcommand} failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'connect') {
    if (args[0] !== 'opencode') {
      console.error('usage: artinarey connect opencode');
      return 2;
    }
    try {
      connectOpencode(cwd);
      console.log('connected OpenCode to Artinarey');
      return 0;
    } catch (err) {
      console.error(`connect failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'run') {
    const vendor = args[0];
    const personaIndex = args.indexOf('--persona');
    const personaToken = personaIndex === -1 ? undefined : args[personaIndex + 1];
    const vendorCommand = env.ARTINAREY_TEST_VENDOR
      || (vendor ? VENDOR_COMMANDS[vendor] : undefined);
    if (!vendor || vendor.startsWith('--')) {
      console.error(RUN_USAGE);
      return 2;
    }
    if (!vendorCommand) {
      console.error(`unknown vendor: ${vendor}`);
      console.error(RUN_USAGE);
      return 2;
    }
    if (!personaToken || personaToken.startsWith('--')) {
      console.error('run requires --persona <persona>');
      console.error(RUN_USAGE);
      return 2;
    }

    const confirmMove = args.includes('--confirm-move') || args.includes('--yes');
    const rehome = args.includes('--rehome');
    let registry: RegistryHandle | undefined;
    let claimed: ClaimedPersona | undefined;
    let claimedWorktreeId: string | undefined;
    let createdBinding = false;
    let sessionId: string | undefined;
    try {
      registry = openRegistry(resolveXdgPaths(env).registryFile);
      const resolved = resolveIdentity(registry, cwd);
      if (!resolved.ok) {
        console.error(`${resolved.code}: ${resolved.message}`);
        return 1;
      }
      const identity = resolved.identity;
      if (!isManagedWorktree(registry, identity.projectId, identity.worktreeId, identity.markerDir)) {
        console.error('WORKTREE_UNMANAGED: worktree is not managed by git; run artinarey worktree list');
        return 1;
      }

      const resolvedPersona = resolvePersona(registry, identity.projectId, personaToken);
      if (resolvedPersona.error) {
        console.error(resolvedPersona.error);
        return 1;
      }
      if (!resolvedPersona.id) {
        console.error(`unknown persona: ${personaToken}`);
        return 1;
      }
      const personaId = resolvedPersona.id;
      const options = { personaId, confirmMove, rehome };
      const previousBinding = registry.bindings.forWorktree(identity.worktreeId)?.id;
      const originalWorktree = boundWorktree(registry, personaId);
      const previousState = readPersona(identity.storeDir, personaId);
      const db = registry;
      const tryClaim = (claimOptions: Parameters<typeof claimPersona>[3]) => {
        try {
          return claimPersona(db, identity.storeDir, identity, claimOptions);
        } catch (err) {
          rollbackFailedClaim(
            db, identity, personaId, previousBinding, previousState, originalWorktree, false,
          );
          throw err;
        }
      };
      let claim = tryClaim(options);
      if (!claim.ok && claim.code === 'NEEDS_CONFIRMATION') {
        console.log(`warning: ${claim.message}`);
        const accepted = !confirmMove && !rehome
          ? await confirmInTerminal('Bind this persona here anyway? [y/N] ')
          : false;
        if (!accepted) return 1;
        claim = tryClaim({ ...options, confirmMove: true });
      }
      if (!claim.ok) {
        console.error(`${claim.code}: ${claim.message}`);
        return 1;
      }
      claimed = claim;
      claimedWorktreeId = claim.identity.worktreeId;
      createdBinding = previousBinding !== claim.personaId;

      sessionId = registry.sessions.append({
        projectId: identity.projectId,
        worktreeId: identity.worktreeId,
        personaId: claim.personaId,
        vendor,
        startedAt: new Date().toISOString(),
        createdBinding,
      });
      const child = spawn(vendorCommand, [], {
        cwd: identity.markerDir, stdio: 'inherit', env,
      });
      return await new Promise<number>((done, fail) => {
        child.once('error', fail);
        child.once('exit', (code, signal) => done(signal ? 1 : code ?? 1));
      });
    } catch (err) {
      console.error(`run failed: ${(err as Error).message}`);
      return 1;
    } finally {
      if (registry) {
        try {
          if (claimed && claimedWorktreeId) {
            const record = claimed;
            const now = Date.now();
            const recent = registry.sessions.list(record.identity.projectId)
              .filter((session) => session.worktreeId === claimedWorktreeId
                && session.personaId === record.personaId
                && now - Date.parse(session.startedAt) <= ACTIVE_SESSION_TTL_MS);
            const otherActive = recent.some((session) => !session.endedAt && session.id !== sessionId);
            // A joining run may be the last to exit: release only if this run or a
            // sibling session created the binding, never a pre-existing one. The
            // local flag also covers a claim whose session insert failed.
            const createdByOverlap = createdBinding || recent.some((session) => session.createdBinding);
            if (!otherActive && createdByOverlap
                && registry.bindings.forWorktree(claimedWorktreeId)?.id === record.personaId) {
              try {
                releasePersona(registry, record.identity.storeDir, record.personaId);
              } catch (err) {
                // Cleanup is best-effort: never replace the vendor's exit code with ours.
                console.error(`run failed to release persona: ${(err as Error).message}`);
              }
            }
          }
          if (sessionId) registry.sessions.end(sessionId, new Date().toISOString());
        } finally {
          registry.close();
        }
      }
    }
  }

  if (command === 'release') {
    const worktreeId = args[0];
    if (!worktreeId || !args.includes('--force')) {
      console.error('usage: artinarey release <worktree> --force');
      return 2;
    }
    try {
      const response = await callDaemon(resolveXdgPaths(env), 'release_force', { worktreeId });
      if (!response.ok) {
        console.error(response.error.message);
        return 1;
      }
      const released = (response.result as { released: boolean }).released;
      console.log(released ? `released ${worktreeId}` : `nothing bound to ${worktreeId}`);
      return 0;
    } catch (err) {
      console.error(`release failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'lease-check') {
    try {
      const { root } = resolveRepo(cwd);
      const marker = findMarker(root);
      if (!marker) {
        console.error('lease-check failed: run artinarey init first');
        return 1;
      }
      const paths = resolveXdgPaths(env);
      const registry = openRegistry(paths.registryFile);
      const project = registry.projects.get(marker.marker.project_id);
      registry.close();
      if (!project) {
        console.error(`lease-check failed: unknown project ${marker.marker.project_id}`);
        return 1;
      }
      const files = changedFiles(root, args.includes('--staged'));
      const tasks = readTasks(project.storeDir)
        .filter((t) => t.worktreeId === marker.marker.worktree_id && t.status !== 'done');
      const outside = uncoveredFiles(tasks, files);
      if (outside.length > 0) {
        console.error(`lease-check: files outside your lease: ${outside.join(', ')}`);
        return 1;
      }
      console.log(`lease-check ok (${files.length} files checked)`);
      return 0;
    } catch (err) {
      console.error(`lease-check failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'verify') {
    const branch = args[0];
    if (!branch) {
      console.error('usage: artinarey verify <branch>');
      return 2;
    }
    try {
      const { root } = resolveRepo(cwd);
      const marker = findMarker(root);
      if (!marker) {
        console.error('verify failed: run artinarey init first');
        return 1;
      }
      const paths = resolveXdgPaths(env);
      const registry = openRegistry(paths.registryFile);
      const project = registry.projects.get(marker.marker.project_id);
      registry.close();
      if (!project) {
        console.error(`verify failed: unknown project ${marker.marker.project_id}`);
        return 1;
      }
      const files = branchChangedFiles(root, branch);
      const tasks = readTasks(project.storeDir)
        .filter((t) => t.branch === branch && t.status !== 'done');
      const outside = uncoveredFiles(tasks, files);
      if (outside.length > 0) {
        console.error(`verify ${branch}: files outside the lease: ${outside.join(', ')}`);
        return 1;
      }
      console.log(`verify ${branch} ok (${files.length} files checked)`);
      return 0;
    } catch (err) {
      console.error(`verify failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'approvals') {
    const paths = resolveXdgPaths(env);
    const projectId = args[0];
    try {
      const response = await callDaemon(paths, 'approvals', projectId ? { projectId } : {});
      if (!response.ok) {
        console.error(`approvals failed: ${response.error.message}`);
        return 1;
      }
      const approvals = (response.result as {
        approvals: Array<{ id: string; kind: string; summary: string; status: string }>;
      }).approvals;
      if (approvals.length === 0) {
        console.log('no approvals');
      } else {
        for (const approval of approvals) {
          console.log(`${approval.id}\t${approval.status}\t${approval.kind}\t${approval.summary}`);
        }
      }
      return 0;
    } catch (err) {
      console.error(`approvals failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'approve') {
    const id = args[0];
    const decision = args.includes('--reject') ? 'rejected' : 'approved';
    if (!id) {
      console.error('usage: artinarey approve <id> [--reject]');
      return 2;
    }
    const paths = resolveXdgPaths(env);
    try {
      // Approving can wait for a cold `opencode serve` start inside the supervisor.
      const response = await callDaemon(paths, 'approve', { id, decision, by: 'user' }, 30000);
      if (!response.ok) {
        console.error(`approve failed: ${response.error.message}`);
        return 1;
      }
      const result = response.result as { approval: { id: string; status: string }; spawn?: unknown };
      console.log(`${result.approval.id}: ${result.approval.status}`);
      if (result.spawn && typeof result.spawn === 'object' && 'message' in result.spawn) {
        console.log(String((result.spawn as { message: string }).message));
      }
      return 0;
    } catch (err) {
      console.error(`approve failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'auto-approve') {
    const [worktreeId, value] = args;
    if (!worktreeId || (value !== 'on' && value !== 'off')) {
      console.error('usage: artinarey auto-approve <worktree> <on|off>');
      return 2;
    }
    const paths = resolveXdgPaths(env);
    try {
      const response = await callDaemon(paths, 'auto_approve', {
        worktreeId, enabled: value === 'on',
      });
      if (!response.ok) {
        console.error(`auto-approve failed: ${response.error.message}`);
        return 1;
      }
      console.log(`auto-approve ${worktreeId}: ${value}`);
      return 0;
    } catch (err) {
      console.error(`auto-approve failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'sessions') {
    const projectId = args[0];
    if (!projectId) {
      console.error('usage: artinarey sessions <project>');
      return 2;
    }
    const paths = resolveXdgPaths(env);
    try {
      const response = await callDaemon(paths, 'sessions', { projectId });
      if (!response.ok) {
        console.error(`sessions failed: ${response.error.message}`);
        return 1;
      }
      const sessions = (response.result as {
        sessions: Array<{ id: string; personaId: string; status: string; vendorSessionId: string | null }>;
      }).sessions;
      if (sessions.length === 0) {
        console.log('no sessions');
      } else {
        for (const session of sessions) {
          console.log(`${session.id}\t${session.status}\t${session.personaId}\t${session.vendorSessionId ?? '-'}`);
        }
      }
      return 0;
    } catch (err) {
      console.error(`sessions failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'reindex') {
    const projectId = args[0];
    if (!projectId) {
      console.error('usage: artinarey reindex <project>');
      return 2;
    }
    const paths = resolveXdgPaths(env);
    const registry = openRegistry(paths.registryFile);
    const project = registry.projects.get(projectId);
    registry.close();
    if (!project) {
      console.error(`unknown project: ${projectId}`);
      return 1;
    }
    const report = buildIndex(join(paths.cacheRoot, projectId, 'index.sqlite'), project.storeDir);
    console.log(`indexed ${report.indexed} mail, skipped ${report.skipped}`);
    return 0;
  }

  if (command === 'storage') {
    const subcommand = args[0];
    const paths = resolveXdgPaths(env);
    const configFile = join(paths.configDir, 'config.json');
    if (subcommand === 'show') {
      console.log(loadConfig(configFile).dataRoot || paths.dataRoot);
      return 0;
    }
    if (subcommand === 'set') {
      const root = args[1];
      if (!root) {
        console.error('usage: artinarey storage set <absolute-path>');
        return 2;
      }
      try {
        const config = saveConfig(configFile, { dataRoot: root });
        console.log(config.dataRoot || paths.dataRoot);
        return 0;
      } catch (err) {
        console.error(`storage set failed: ${(err as Error).message}`);
        return 1;
      }
    }
    console.error('usage: artinarey storage show | set <absolute-path>');
    return 2;
  }

  if (command === 'daemon') {
    const subcommand = args[0];
    const paths = resolveXdgPaths(env);
    if (subcommand === 'start') {
      try {
        await startDaemon(paths);
        console.log('daemon started');
        return 0;
      } catch (err) {
        console.error(`daemon start failed: ${(err as Error).message}`);
        return 1;
      }
    }
    if (subcommand === 'status') {
      const status = await daemonStatus(paths);
      console.log(status ? JSON.stringify(status) : 'daemon not running');
      return 0;
    }
    if (subcommand === 'stop') {
      try {
        await stopDaemon(paths);
        console.log('daemon stopped');
        return 0;
      } catch (err) {
        console.error(`daemon stop failed: ${(err as Error).message}`);
        return 1;
      }
    }
    console.error('usage: artinarey daemon start|stop|status');
    return 2;
  }

  console.error(`unknown command: ${command ?? ''}`);
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
