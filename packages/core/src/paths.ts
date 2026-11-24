import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type XdgPaths = {
  configDir: string;
  registryFile: string;
  tokenFile: string;
  socketPath: string;
  dataRoot: string;
  cacheRoot: string;
};

/** XDG overrides must be absolute; relative values are ignored. */
function absoluteOverride(value: string | undefined): string | undefined {
  return value && isAbsolute(value) ? value : undefined;
}

export function resolveXdgPaths(env: NodeJS.ProcessEnv = process.env): XdgPaths {
  const home = absoluteOverride(env.HOME) ?? homedir();
  const configHome = absoluteOverride(env.XDG_CONFIG_HOME) ?? join(home, '.config');
  const dataHome = absoluteOverride(env.XDG_DATA_HOME) ?? join(home, '.local', 'share');
  const cacheHome = absoluteOverride(env.XDG_CACHE_HOME) ?? join(home, '.cache');
  const runtimeHome = absoluteOverride(env.XDG_RUNTIME_DIR)
    ?? join(tmpdir(), `artinarey-runtime-${process.getuid?.() ?? 'user'}`);
  const configDir = join(configHome, 'artinarey');

  return {
    configDir,
    registryFile: join(configDir, 'registry.sqlite'),
    tokenFile: join(configDir, 'token'),
    socketPath: join(runtimeHome, 'artinarey', 'daemon.sock'),
    dataRoot: join(dataHome, 'artinarey'),
    cacheRoot: join(cacheHome, 'artinarey'),
  };
}

/** A project's store is a single movable directory under the data root. */
export function projectStore(dataRoot: string, projectId: string): string {
  return join(dataRoot, projectId);
}
