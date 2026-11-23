import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cwd = process.argv[2];
if (!cwd) throw new Error('usage: stdio-client <absolute-cwd>');

const client = new Client({ name: 'm0-smoke', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/node_modules/.bin/tsx',
    '/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/src/index.ts',
  ],
  cwd,
});

await client.connect(transport);
console.log('tools:', (await client.listTools()).tools.map(t => t.name));
const result = await client.callTool({ name: 'whoami', arguments: {} });
console.log(JSON.stringify(result.content, null, 2));
await client.close();
