import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, openRegistry, resolveXdgPaths } from '@artinarey/core';

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

  console.error(`unknown command: ${command ?? ''}`);
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
