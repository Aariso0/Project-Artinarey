import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { atomicWrite } from './store.ts';

export type Config = {
  /** Empty means "use the XDG data root". */
  dataRoot: string;
  /** Soft cap on concurrent agent sessions per project. */
  spawnCap: number;
  ui: Record<string, unknown>;
};

export const DEFAULT_CONFIG: Config = {
  dataRoot: '',
  spawnCap: 3,
  ui: {},
};

export function loadConfig(file: string): Config {
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, ui: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ArtinareyError('INVALID_INPUT', `Invalid JSON in config: ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArtinareyError('INVALID_INPUT', `Config must be a JSON object: ${file}`);
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.dataRoot !== undefined && typeof raw.dataRoot !== 'string') {
    throw new ArtinareyError('INVALID_INPUT', 'dataRoot must be a string');
  }
  if (raw.spawnCap !== undefined
      && (typeof raw.spawnCap !== 'number' || !Number.isInteger(raw.spawnCap) || raw.spawnCap < 1)) {
    throw new ArtinareyError('INVALID_INPUT', 'spawnCap must be a positive integer');
  }
  if (raw.ui !== undefined
      && (typeof raw.ui !== 'object' || raw.ui === null || Array.isArray(raw.ui))) {
    throw new ArtinareyError('INVALID_INPUT', 'ui must be an object');
  }

  return {
    dataRoot: typeof raw.dataRoot === 'string' ? raw.dataRoot : DEFAULT_CONFIG.dataRoot,
    spawnCap: typeof raw.spawnCap === 'number' ? raw.spawnCap : DEFAULT_CONFIG.spawnCap,
    ui: (raw.ui ?? {}) as Record<string, unknown>,
  };
}

/**
 * Storage roots are daemon-validated: the webview may send a path, never the
 * authority to use one. An empty root means "back to the XDG default".
 */
export function saveConfig(file: string, patch: Partial<Pick<Config, 'dataRoot'>>): Config {
  const current = loadConfig(file);
  const dataRoot = patch.dataRoot === undefined ? current.dataRoot : patch.dataRoot.trim();
  if (dataRoot && !isAbsolute(dataRoot)) {
    throw new ArtinareyError('INVALID_INPUT', 'dataRoot must be an absolute path');
  }
  const next: Config = { ...current, dataRoot: dataRoot ? resolve(dataRoot) : '' };
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}
