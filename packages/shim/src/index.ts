import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveXdgPaths } from '@artinarey/core';
import { createDaemonClient } from './daemon-client.ts';
import { createShimServer } from './tools.ts';

export * from './tools.ts';
export * from './daemon-client.ts';

/** One stdio server per agent session; the daemon holds all state. */
serveStdio(() => {
  const client = createDaemonClient({
    paths: resolveXdgPaths(),
    cwd: process.cwd(),
    pid: process.pid,
  });
  const server = createShimServer((method, params) => client.invoke(method, params));
  server.server.onclose = () => client.close();
  return server;
});
