import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, openRegistry, resolveXdgPaths } from '@artinarey/core';
import { daemonStatus, startDaemon, stopDaemon } from '@artinarey/daemon';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...args] = argv;

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
