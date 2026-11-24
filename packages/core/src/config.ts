import { existsSync, readFileSync } from 'node:fs';
import { ArtinareyError } from './errors.ts';

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
  if (raw.spawnCap !== undefined && (!Number.isInteger(raw.spawnCap) || (raw.spawnCap as number) < 1)) {
    throw new ArtinareyError('INVALID_INPUT', 'spawnCap must be a positive integer');
  }
  if (raw.ui !== undefined && (typeof raw.ui !== 'object' || raw.ui === null || Array.isArray(raw.ui))) {
    throw new ArtinareyError('INVALID_INPUT', 'ui must be an object');
  }

  return {
    dataRoot: (raw.dataRoot as string | undefined) ?? DEFAULT_CONFIG.dataRoot,
    spawnCap: (raw.spawnCap as number | undefined) ?? DEFAULT_CONFIG.spawnCap,
    ui: (raw.ui as Record<string, unknown> | undefined) ?? {},
  };
}
