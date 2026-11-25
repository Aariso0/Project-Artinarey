import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { atomicWrite } from './store.ts';

/** Tools the Artinarey shim exposes. Kept here so CLI and release hook agree. */
export const OPENCODE_TOOLS = [
  'check_in', 'claim_persona', 'inbox', 'read_mail',
  'send_mail', 'mark_done', 'report', 'worktrees',
  'task_update', 'request_scope', 'assign_task', 'request_session',
] as const;

export type OpenCodePermission = { action: string; resource: string; effect: string };
export type OpenCodeConfig = Record<string, unknown> & {
  mcp?: { servers?: Record<string, unknown> };
  permissions?: OpenCodePermission[];
};

/** Merge without clobbering unrelated config; safe to call on every launch. */
export function mergeOpencodeConfig(
  config: OpenCodeConfig,
  command: string[],
): OpenCodeConfig {
  const ours = new Set(OPENCODE_TOOLS.map((tool) => `artinarey_${tool}`));
  const existingRules = Array.isArray(config.permissions) ? config.permissions : [];
  return {
    ...config,
    mcp: {
      ...config.mcp,
      servers: {
        ...config.mcp?.servers,
        artinarey: { type: 'local', command, disabled: false },
      },
    },
    permissions: [
      ...existingRules.filter((rule) => rule && !ours.has(rule.action)),
      ...OPENCODE_TOOLS.map((tool) => ({
        action: `artinarey_${tool}`, resource: '*', effect: 'allow',
      })),
    ],
  };
}

/** Read, merge and atomically write an OpenCode config file. */
export function connectOpencodeAt(file: string, command: string[]): OpenCodeConfig {
  const exists = existsSync(file);
  // Global configs may hold credentials: never widen an existing file's mode,
  // and create new ones readable only by their owner.
  const mode = exists ? statSync(file).mode & 0o777 : 0o600;
  const config: OpenCodeConfig = exists
    ? JSON.parse(readFileSync(file, 'utf8')) as OpenCodeConfig
    : {};
  const merged = mergeOpencodeConfig(config, command);
  atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`, mode);
  return merged;
}

function absolute(value: string | undefined): string | undefined {
  return value && isAbsolute(value) ? value : undefined;
}

/** Where a released app should write the global OpenCode config. */
export function opencodeGlobalConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = absolute(env.HOME);
  const preferred = absolute(env.XDG_CONFIG_HOME)
    ? join(env.XDG_CONFIG_HOME as string, 'opencode', 'opencode.json')
    : home ? join(home, '.config', 'opencode', 'opencode.json') : undefined;
  if (!preferred) return undefined;

  const legacy = home ? join(home, '.opencode.json') : undefined;
  if (legacy && existsSync(legacy) && !existsSync(preferred)) return legacy;
  return preferred;
}

function existsOnPath(env: NodeJS.ProcessEnv): boolean {
  const names = process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const candidate = join(dir, name);
        if (statSync(candidate).isFile()) return true;
      } catch {
        // Not present in this PATH entry.
      }
    }
  }
  return false;
}

/** OpenCode is installed if its binary is reachable or it has a config dir. */
export function opencodeInstalled(env: NodeJS.ProcessEnv): boolean {
  if (existsOnPath(env)) return true;
  const home = absolute(env.HOME);
  const candidates = [
    absolute(env.XDG_CONFIG_HOME) && join(env.XDG_CONFIG_HOME as string, 'opencode'),
    home && join(home, '.config', 'opencode'),
    home && join(home, '.opencode.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.some((candidate) => existsSync(candidate));
}
