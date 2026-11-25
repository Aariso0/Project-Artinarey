import { resolveXdgPaths } from '@artinarey/core';
import { startDaemon, stopDaemon } from './index.ts';

/**
 * Bundled entrypoint. The GUI spawns this with its own Node runtime when no
 * daemon is reachable, so a compiled release does not need Node on the host.
 */
const paths = resolveXdgPaths(process.env);
let stopping = false;

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
