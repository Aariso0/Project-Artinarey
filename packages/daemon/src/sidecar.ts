import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveXdgPaths } from '@artinarey/core';
import { startDaemon, stopDaemon } from './index.ts';
import { autoConnectOpencode } from './opencode-autoconnect.ts';

/**
 * Bundled entrypoint. The GUI spawns this with its own Node runtime when no
 * daemon is reachable, so a compiled release does not need Node on the host.
 */
const paths = resolveXdgPaths(process.env);
let stopping = false;

/** A manifest beside this entry means we are the release sidecar, not source. */
function releaseBundle(): { dir: string; version: string } | undefined {
  const dir = dirname(fileURLToPath(import.meta.url));
  const manifest = join(dir, 'manifest.json');
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { appVersion?: unknown };
    if (typeof parsed.appVersion === 'string') return { dir, version: parsed.appVersion };
  } catch {
    // A broken manifest must not stop the daemon.
  }
  return undefined;
}

const bundle = releaseBundle();
if (bundle && process.env.ARTINAREY_AUTO_CONNECT_OPENCODE !== '0') {
  try {
    const result = autoConnectOpencode(process.env, bundle.dir, bundle.version);
    if (result.status === 'connected') {
      process.stderr.write(`artinarey connected OpenCode at ${result.file}\n`);
    }
  } catch {
    // Auto-connect is best-effort and never blocks daemon startup.
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await stopDaemon(paths);
  } catch {
    // A daemon that never became reachable has nothing to shut down.
  }
  process.exit(0);
}

process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

startDaemon(paths)
  .then(() => process.stderr.write('artinarey daemon ready\n'))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`artinarey daemon failed: ${message}\n`);
    process.exit(1);
  });
