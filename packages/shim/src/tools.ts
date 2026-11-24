import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export type ShimReply = { text: string; isError: boolean };
export type ToolInvoker = (
  method: string,
  params: Record<string, unknown>,
) => Promise<ShimReply>;

export const TOOL_NAMES = [
  'check_in', 'claim_persona', 'inbox', 'read_mail',
  'send_mail', 'mark_done', 'report', 'worktrees',
  'task_update', 'request_scope', 'assign_task', 'request_session',
] as const;

const mailKinds = [
  'task', 'question', 'status', 'decision', 'blocker', 'receipt', 'note',
] as const;

export function toMcp(reply: ShimReply) {
  return {
    content: [{ type: 'text' as const, text: reply.text }],
    isError: reply.isError,
  };
}

/** Register the M2 tools. All state lives in the daemon; this server is stateless. */
export function createShimServer(invoke: ToolInvoker): McpServer {
  const server = new McpServer(
    { name: 'artinarey', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('check_in', {
    description: 'Identify this directory, list the persona roster and show unread mail.',
    inputSchema: z.object({}),
  }, async () => toMcp(await invoke('check_in', {})));

  server.registerTool('claim_persona', {
    description: 'Bind a persona (existing or new role) to this directory.',
    inputSchema: z.object({
      persona_id: z.string().optional(),
      new_role: z.string().optional(),
      name: z.string().optional(),
      confirm_move: z.boolean().optional(),
      rehome: z.boolean().optional(),
    }).refine((v) => Boolean(v.persona_id || v.new_role), {
      message: 'provide persona_id or new_role',
    }),
  }, async (params) => toMcp(await invoke('claim_persona', params)));

  server.registerTool('inbox', {
    description: 'List mail for the bound persona.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional().default(5),
      include_read: z.boolean().optional().default(false),
    }),
  }, async (params) => toMcp(await invoke('inbox', params)));

  server.registerTool('read_mail', {
    description: 'Read one of your own mail items.',
    inputSchema: z.object({ id: z.string().min(1) }),
  }, async (params) => toMcp(await invoke('read_mail', params)));

  server.registerTool('send_mail', {
    description: 'Send mail to one or more personas. No broadcast or wildcard recipients.',
    inputSchema: z.object({
      to: z.array(z.string().min(1)).min(1),
      cc: z.array(z.string().min(1)).optional().default([]),
      subject: z.string().min(1),
      kind: z.enum(mailKinds),
      action: z.string().min(1),
      eta: z.string().optional(),
      body: z.string().min(1),
      in_reply_to: z.string().optional(),
    }),
  }, async (params) => toMcp(await invoke('send_mail', params)));

  server.registerTool('mark_done', {
    description: 'Record a done item and mail a receipt to the sender.',
    inputSchema: z.object({ id: z.string().min(1), note: z.string().min(1) }),
  }, async (params) => toMcp(await invoke('mark_done', params)));

  server.registerTool('report', {
    description: 'Overwrite your live status report.',
    inputSchema: z.object({
      now: z.string().min(1),
      done: z.string(),
      next: z.string(),
      blocked: z.string(),
    }),
  }, async (params) => toMcp(await invoke('report', params)));

  server.registerTool('worktrees', {
    description: 'List this project\'s worktrees read-only.',
    inputSchema: z.object({}),
  }, async () => toMcp(await invoke('worktrees', {})));

  server.registerTool('assign_task', {
    description: 'Senior dev only: create a task with a scope and mail the assignee.',
    inputSchema: z.object({
      persona_id: z.string().min(1),
      title: z.string().min(1),
      scope: z.array(z.string().min(1)).min(1),
      body: z.string().min(1),
    }),
  }, async (params) => toMcp(await invoke('assign_task', params)));

  server.registerTool('request_scope', {
    description: 'Ask the senior dev for more scope on your task (overlap is checked).',
    inputSchema: z.object({
      task_id: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
      reason: z.string().min(1),
    }),
  }, async (params) => toMcp(await invoke('request_scope', params)));

  server.registerTool('task_update', {
    description: 'Update the status of a task assigned to you.',
    inputSchema: z.object({
      task_id: z.string().min(1),
      status: z.enum(['in_progress', 'blocked', 'ready_for_review', 'done']),
      note: z.string(),
    }),
  }, async (params) => toMcp(await invoke('task_update', params)));

  server.registerTool('request_session', {
    description: 'Senior dev only: spawn a persona in a worktree for a leased task.',
    inputSchema: z.object({
      role: z.string().min(1).optional(),
      persona_id: z.string().min(1).optional(),
      task_id: z.string().min(1),
      vendor: z.string().min(1).optional(),
      worktree_id: z.string().min(1).optional(),
    }).refine((v) => Boolean(v.role || v.persona_id), {
      message: 'provide role or persona_id',
    }),
  }, async (params) => toMcp(await invoke('request_session', params)));

  return server;
}
