import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { TOOL_NAMES, createShimServer, type ToolInvoker } from './tools.ts';

const noop: ToolInvoker = async () => ({ text: 'ok', isError: false });

test('the shim registers exactly the eight M2 tools', () => {
  assert.deepEqual(TOOL_NAMES, [
    'check_in', 'claim_persona', 'inbox', 'read_mail',
    'send_mail', 'mark_done', 'report', 'worktrees',
  ]);

  const server = createShimServer(noop);
  assert.ok(server instanceof McpServer);
});

test('the shim exposes no leftover M0 probe tool', () => {
  assert.equal((TOOL_NAMES as readonly string[]).includes('whoami'), false);
});
