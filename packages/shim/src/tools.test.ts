import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { TOOL_NAMES, createShimServer, type ToolInvoker } from './tools.ts';

const noop: ToolInvoker = async () => ({ text: 'ok', isError: false });

test('the shim registers the M2 tools plus the M4 lease tools and M5 request_session', () => {
  assert.deepEqual(TOOL_NAMES, [
    'check_in', 'claim_persona', 'inbox', 'read_mail',
    'send_mail', 'mark_done', 'report', 'worktrees',
    'task_update', 'request_scope', 'assign_task', 'request_session',
  ]);

  const server = createShimServer(noop);
  assert.ok(server instanceof McpServer);
});

test('the shim exposes no leftover M0 probe tool', () => {
  assert.equal((TOOL_NAMES as readonly string[]).includes('whoami'), false);
});
