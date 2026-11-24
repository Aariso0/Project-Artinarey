import { createParser } from 'eventsource-parser';
import { z } from 'zod';

/**
 * M8 wire profile. There is no provider name here on purpose: any
 * OpenAI-compatible endpoint works, and only the adapter process ever reads
 * the key. The daemon passes prompts and results over a local unix socket.
 */
export const MODEL_PROFILE = 'openai-compatible' as const;

export type AdapterConfig = {
  baseUrl: string;
  profile: typeof MODEL_PROFILE;
  model: string;
  key: string | null;
};

const configSchema = z.object({
  baseUrl: z.string().trim().min(1),
  profile: z.literal(MODEL_PROFILE),
  model: z.string().trim().min(1),
  key: z.string().min(1).nullable(),
});

/** The adapter reads this from its own environment; the daemon never reads it. */
export const MODEL_KEY_ENV = 'ARTINAREY_MODEL_KEY';

/** Finite bound on a partial SSE line or multi-line event from an external provider. */
export const MAX_SSE_BUFFER_SIZE = 1024 * 1024;

export function parseAdapterConfig(env: Record<string, string | undefined>): AdapterConfig {
  const baseUrl = env.ARTINAREY_MODEL_BASE_URL?.trim() ?? '';
  let origin = '';
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('base URL must be http or https');
    }
    origin = parsed.toString();
  } catch {
    throw Object.assign(new Error('ARTINAREY_MODEL_BASE_URL must be an http(s) URL'), {
      code: 'ADAPTER_OFFLINE',
    });
  }
  const profile = env.ARTINAREY_MODEL_PROFILE?.trim() || MODEL_PROFILE;
  if (profile !== MODEL_PROFILE) {
    throw Object.assign(new Error(`unsupported wire profile: ${profile}`), {
      code: 'ADAPTER_OFFLINE',
    });
  }
  try {
    const config = configSchema.parse({
      baseUrl: origin,
      profile,
      model: env.ARTINAREY_MODEL_MODEL?.trim() || 'default',
      key: env[MODEL_KEY_ENV]?.trim() ? env[MODEL_KEY_ENV] : null,
    });
    // A bearer key must never be sent over cleartext, even to a loopback URL.
    if (config.key !== null && new URL(config.baseUrl).protocol !== 'https:') {
      throw new Error(`${MODEL_KEY_ENV} requires an https model base URL`);
    }
    return config as AdapterConfig;
  } catch (err) {
    throw Object.assign(new Error(`invalid model adapter config: ${String(err)}`), {
      code: 'ADAPTER_OFFLINE',
    });
  }
}

/** Status never carries the key or a provider name. */
export function publicAdapterConfig(config: AdapterConfig) {
  return {
    baseUrl: config.baseUrl,
    profile: config.profile,
    model: config.model,
    hasKey: config.key !== null,
  };
}

export type ModelPromptInput = {
  prompt: string;
  system?: string;
  maxTokens?: number;
};

const promptSchema = z.object({
  prompt: z.string().trim().min(1),
  system: z.string().trim().optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
});

export function parsePromptInput(value: unknown): ModelPromptInput {
  try {
    return promptSchema.parse(value) as ModelPromptInput;
  } catch (err) {
    throw Object.assign(new Error(`invalid prompt request: ${String(err)}`), {
      code: 'INVALID_INPUT',
    });
  }
}

/** OpenAI-compatible chat completion body. Key is added by the adapter only. */
export function completionBody(config: AdapterConfig, input: ModelPromptInput) {
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });
  return {
    model: config.model,
    stream: true,
    messages,
    ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
  };
}

export function completionUrl(baseUrl: string): string {
  return new URL('chat/completions', `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

export type CompletionRequest = {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'error' | 'follow';
    signal: AbortSignal;
  };
};

/** Only this adapter-side request ever attaches the key or chooses redirects. */
export function completionRequest(
  config: AdapterConfig,
  input: ModelPromptInput,
  signal: AbortSignal,
): CompletionRequest {
  return {
    url: completionUrl(config.baseUrl),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
      },
      body: JSON.stringify(completionBody(config, input)),
      // A keyed request must never be replayed at another URL by fetch.
      redirect: config.key ? 'error' : 'follow',
      signal,
    },
  };
}

/** Accumulates delta content from SSE frames; ignores keep-alives and `[DONE]`. */
export class CompletionCollector {
  private readonly parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_SIZE,
    onError: (error) => {
      if (error.type === 'max-buffer-size-exceeded') this.parseFailure = error.message;
    },
    onEvent: (event) => {
      if (event.data === '[DONE]') {
        this.done = true;
        return;
      }
      if (event.event === 'error') {
        this.streamError = event.data.slice(0, 300);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // A malformed frame is not authority; the stream can still recover.
        return;
      }
      const choice = (payload as { choices?: Array<{ delta?: { content?: unknown } }> })
        .choices?.[0];
      const content = choice?.delta?.content;
      if (typeof content === 'string') this.parts.push(content);
    },
  });
  private readonly parts: string[] = [];
  private done = false;
  private streamError: string | null = null;
  private parseFailure: string | null = null;

  feed(chunk: string): void {
    this.parser.feed(chunk);
    if (this.parseFailure) throw this.failure();
  }

  get finished(): boolean {
    return this.done;
  }

  private failure(): Error & { code: string } {
    return Object.assign(
      new Error(this.streamError ?? this.parseFailure ?? 'model stream failed'),
      { code: 'ADAPTER_OFFLINE' },
    );
  }

  result(): { text: string; done: boolean } {
    if (this.streamError || this.parseFailure) throw this.failure();
    if (!this.done) {
      throw Object.assign(new Error('model stream ended before [DONE]'), {
        code: 'ADAPTER_OFFLINE',
      });
    }
    return { text: this.parts.join(''), done: true };
  }
}

/** Reads an SSE response to completion, cancelling the reader on `[DONE]` or failure. */
export async function collectCompletion(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ text: string; done: boolean }> {
  if (!body) {
    throw Object.assign(new Error('model API returned no body'), { code: 'ADAPTER_OFFLINE' });
  }
  const collector = new CompletionCollector();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const cancel = async () => {
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      collector.feed(decoder.decode(value, { stream: true }));
      if (collector.finished) {
        await cancel();
        return collector.result();
      }
    }
    collector.feed(decoder.decode());
    return collector.result();
  } catch (err) {
    await cancel();
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/** Non-streaming fallback for compatible endpoints that answer a single JSON object. */
export function textFromCompletion(payload: unknown): string {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
