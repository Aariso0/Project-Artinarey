import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWrite, connectOpencodeAt, opencodeGlobalConfigPath, opencodeInstalled, resolveXdgPaths,
} from '@artinarey/core';

export type AutoConnectResult = {
  status: 'connected' | 'skipped';
  reason?: 'opencode_absent' | 'shim_missing' | 'unsupported_platform'
    | 'already_current' | 'invalid_config';
  file?: string;
};

type Marker = { version: string; file: string; command: string[] };

function readMarker(file: string): Marker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Marker>;
    if (typeof parsed.version === 'string'
      && typeof parsed.file === 'string'
      && Array.isArray(parsed.command)) return parsed as Marker;
  } catch {
    // Missing or unreadable marker means the hook has not run successfully.
  }
  return undefined;
}

/**
 * Release-only first-run hook. Writes the global OpenCode config once per app
 * version, never on a source checkout where the shim is not bundled.
 */
export function autoConnectOpencode(
  env: NodeJS.ProcessEnv,
  bundleDir: string,
  version: string,
  nodePath: string = process.execPath,
): AutoConnectResult {
  if (!opencodeInstalled(env)) return { status: 'skipped', reason: 'opencode_absent' };

  const shim = join(bundleDir, 'shim.mjs');
  if (!existsSync(shim)) return { status: 'skipped', reason: 'shim_missing' };

  const file = opencodeGlobalConfigPath(env);
  if (!file) return { status: 'skipped', reason: 'unsupported_platform' };

  const command = [nodePath, shim];
  const markerFile = join(resolveXdgPaths(env).configDir, 'opencode-autoconnect.json');
  const marker = readMarker(markerFile);
  if (marker?.version === version && marker.file === file
    && JSON.stringify(marker.command) === JSON.stringify(command)) {
    return { status: 'skipped', reason: 'already_current', file };
  }

  try {
    connectOpencodeAt(file, command);
  } catch {
    // A malformed user config must not stop the daemon from starting.
    return { status: 'skipped', reason: 'invalid_config', file };
  }
  atomicWrite(markerFile, `${JSON.stringify({ version, file, command }, null, 2)}\n`);
  return { status: 'connected', file };
}
