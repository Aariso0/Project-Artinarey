import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';
import {
  collectCompletion, completionRequest, parseAdapterConfig, parsePromptInput,
  publicAdapterConfig, textFromCompletion,
} from './model-wire.ts';

type AdapterReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

const requestSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['ping', 'prompt']),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Outbound model-API process. Spawned by the daemon, reached only over a 0600
 * unix socket. It is the only process that reads the key or calls fetch.
 */
export async function runAdapter(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = parseAdapterConfig(env);
  const socketPath = env.ARTINAREY_MODEL_SOCKET;
  if (!socketPath) throw new Error('ARTINAREY_MODEL_SOCKET is required');

  // Keep the key in this process's memory only; nothing spawned later inherits it.
  for (const name of Object.keys(env)) {
    if (name.startsWith('ARTINAREY_MODEL_')) delete env[name];
  }

  const server: Server = createServer();
  const sockets = new Set<Socket>();
  const shutdown = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    try { unlinkSync(socketPath); } catch { /* the socket is already gone */ }
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  async function callModel(input: ReturnType<typeof parsePromptInput>): Promise<unknown> {
    const { url, init } = completionRequest(config, input, AbortSignal.timeout(120_000));
    const response = await fetch(url, init);
    if (!response.ok) {
      throw Object.assign(new Error(`model API returned HTTP ${response.status}`), {
        code: 'ADAPTER_OFFLINE',
      });
    }
    if (!response.body) {
      throw Object.assign(new Error('model API returned no body'), { code: 'ADAPTER_OFFLINE' });
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const payload = await response.json() as unknown;
      return { text: textFromCompletion(payload), done: true };
    }
    return collectCompletion(response.body);
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let queued: Promise<void> = Promise.resolve();
    const send = (reply: AdapterReply) => socket.write(`${JSON.stringify(reply)}\n`);

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const pending = queued.then(async () => {
        let end = buffer.indexOf('\n');
        while (end !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          end = buffer.indexOf('\n');
          if (!line.trim()) continue;
          let id = 'invalid';
          try {
            const request = requestSchema.parse(JSON.parse(line));
            id = request.id;
            if (request.method === 'ping') {
              send({ id, ok: true, result: { running: true, ...publicAdapterConfig(config) } });
            } else {
              const input = parsePromptInput(request.params);
              const result = await callModel(input);
              send({ id, ok: true, result });
            }
          } catch (err) {
            const code = (err as { code?: string }).code
              ?? (err instanceof z.ZodError ? 'INVALID_INPUT' : 'ADAPTER_OFFLINE');
            send({ id, ok: false, error: { code, message: (err as Error).message ?? 'request failed' } });
          }
        }
      });
      queued = pending.catch(() => {});
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  process.stdout.write(`${JSON.stringify({ ready: true, socket: socketPath })}\n`);
}

void runAdapter().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
