import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { buildReport } from './report.ts';

const server = new McpServer({ name: 'artinarey-m0', version: '0.0.0' });

server.registerTool(
  'whoami',
  {
    description: 'Report the shim process cwd, argv and environment variable names',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(buildReport(), null, 2) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
