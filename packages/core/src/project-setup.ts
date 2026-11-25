import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { ArtinareyError } from './errors.ts';
import { newId } from './ids.ts';
import { projectStore, resolveXdgPaths } from './paths.ts';
import { openRegistry } from './registry.ts';
import { findMarker, writeMarker } from './identity.ts';
import { installHooks } from './hooks.ts';
import { ensureExcludeBlock, globalIgnoreCoverage, listGitWorktrees, resolveRepo } from './worktree.ts';

export type ProjectSetupResult = {
  projectId: string;
  worktreeId: string;
  path: string;
  name: string;
  hooksNote: string;
  globalIgnore: string;
};

/** Registers an existing repository root and its main worktree. Idempotent. */
export function registerProjectAt(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectSetupResult {
  const requested = resolve(path);
  if (!existsSync(requested)) {
    throw new ArtinareyError('INVALID_INPUT', `path does not exist: ${requested}`);
  }
  const { root, commonDir } = resolveRepo(requested);
  ensureExcludeBlock(commonDir);
  const hooks = installHooks(root, commonDir);
  const coverage = globalIgnoreCoverage(root);
  const paths = resolveXdgPaths(env);
  const registry = openRegistry(paths.registryFile);
  try {
    let project = registry.projects.list().find((row) => row.repoCommonDir === commonDir);
    if (!project) {
      project = registry.projects.create({
        name: basename(root),
        repoCommonDir: commonDir,
        storeDir: projectStore(
          loadConfig(join(paths.configDir, 'config.json')).dataRoot || paths.dataRoot,
          newId(),
        ),
      });
      mkdirSync(project.storeDir, { recursive: true });
    }

    const marker = findMarker(root);
    const registered = registry.worktrees.list(project.id);
    const fromMarker = marker?.dir === root && marker.marker.project_id === project.id
      ? registered.find((row) => row.id === marker.marker.worktree_id && row.path === root)
      : undefined;
    const worktree = fromMarker ?? registered.find((row) => row.path === root);
    const worktreeId = worktree?.id ?? newId();
    const branch = listGitWorktrees(root).find((row) => row.path === root)?.branch ?? null;
    registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: root, branch });
    writeMarker(root, project.id, worktreeId);

    const globalIgnore = coverage.globalFile === null
      ? 'no global excludes file'
      : coverage.coversWorktrees
        ? `covers .worktrees/ via ${coverage.globalFile}`
        : `does not cover .worktrees/ (${coverage.globalFile})`;
    return {
      projectId: project.id,
      worktreeId,
      path: root,
      name: project.name,
      hooksNote: hooks.note,
      globalIgnore,
    };
  } finally {
    registry.close();
  }
}

function withoutCredentials(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/, '//***@');
}

/** Spawn Git without blocking the daemon's request loop while a clone runs. */
function runClone(url: string, destination: string, parent: string): Promise<void> {
  return new Promise((finished, failed) => {
    execFile('git', ['clone', '--', url, destination], {
      cwd: parent, encoding: 'utf8',
    }, (error) => {
      if (error) failed(error);
      else finished();
    });
  });
}

/** Clones into a new folder, then registers it like an existing repository. */
export async function cloneProjectInto(
  url: string,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ProjectSetupResult> {
  if (!url || typeof url !== 'string') {
    throw new ArtinareyError('INVALID_INPUT', 'clone needs a repository URL');
  }
  const destination = resolve(cwd, target);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new ArtinareyError('INVALID_INPUT', `target folder is not empty: ${destination}`);
  }
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  try {
    await runClone(url, destination, parent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ArtinareyError('INVALID_INPUT', `clone failed: ${withoutCredentials(message)}`);
  }
  return registerProjectAt(destination, env);
}
