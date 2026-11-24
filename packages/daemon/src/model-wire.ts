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

/** Accumulates delta content from SSE frames; ignores keep-alives and `[DONE]`. */
export class CompletionCollector {
  private readonly parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') {
        this.done = true;
        return;
      }
      if (event.event === 'error') {
        this.error = event.data.slice(0, 300);
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
  private error: string | null = null;

  feed(chunk: string): void {
    this.parser.feed(chunk);
  }

  get finished(): boolean {
    return this.done;
  }

  result(): { text: string; done: boolean } {
    if (this.error) {
      throw Object.assign(new Error(this.error), { code: 'ADAPTER_OFFLINE' });
    }
    return { text: this.parts.join(''), done: this.done };
  }
}

/** Non-streaming fallback for compatible endpoints that answer a single JSON object. */
export function textFromCompletion(payload: unknown): string {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
