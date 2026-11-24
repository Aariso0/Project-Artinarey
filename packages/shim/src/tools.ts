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

  return server;
}
