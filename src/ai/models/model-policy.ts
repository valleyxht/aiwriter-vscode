import { SdkChatModel } from './sdk-chat-model';
import { SdkEmbeddings } from './sdk-embeddings';
import { randomUUID } from 'node:crypto';
import { currentRequestTelemetry } from '../runtime/request-telemetry';

export const MODEL_POLICY = {
  chatConcurrency: 2,
  embeddingConcurrency: 2,
  maxRetries: 2,
  baseRetryDelayMs: 500,
  maxRetryDelayMs: 30_000,
  chatTimeoutMs: 300_000,
  toolChatTimeoutMs: 120_000,
  parserTimeoutMs: 60_000,
  embeddingTimeoutMs: 120_000,
} as const;

export interface ChatModelOptions {
  apiKey: string;
  baseUrl?: string;
  /** Optional transport injection for local protocol tests. */
  fetch?: typeof globalThis.fetch;
  model: string;
  temperature: number;
  /** Omit to let the provider/model choose its native completion limit. */
  maxTokens?: number;
  streaming: boolean;
  timeoutMs?: number;
  /** Keep provider defaults unless a caller explicitly needs a non-reasoning retry. */
  reasoningMode?: 'default' | 'disabled';
}

export interface EmbeddingModelOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

export interface RetryOptions {
  operation: string;
  signal?: AbortSignal;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

export interface ModelErrorClassification {
  retryable: boolean;
  status?: number;
  code?: string;
  reason: string;
  retryAfterMs?: number;
}

class AsyncSemaphore {
  private _active = 0;
  private readonly _waiters: Array<{
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly _limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }

    if (this._active < this._limit) {
      this._active++;
      return Promise.resolve(this._createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject } as {
        signal?: AbortSignal;
        onAbort?: () => void;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
      };
      waiter.onAbort = () => {
        const index = this._waiters.indexOf(waiter);
        if (index >= 0) {
          this._waiters.splice(index, 1);
        }
        reject(createAbortError(signal));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this._waiters.push(waiter);
    });
  }

  get active(): number {
    return this._active;
  }

  get pending(): number {
    return this._waiters.length;
  }

  private _createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this._active = Math.max(0, this._active - 1);
      this._drain();
    };
  }

  private _drain(): void {
    while (this._active < this._limit && this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(createAbortError(waiter.signal));
        continue;
      }
      this._active++;
      waiter.resolve(this._createRelease());
    }
  }
}

const chatSemaphore = new AsyncSemaphore(MODEL_POLICY.chatConcurrency);
const embeddingSemaphore = new AsyncSemaphore(MODEL_POLICY.embeddingConcurrency);

export function cleanBaseUrl(url: string): string {
  if (!url) {
    return '';
  }
  let cleaned = url.trim();
  cleaned = cleaned.replace(/^[\'"`]|[\'"`]$/g, '');
  cleaned = cleaned.replace(/[,;\s]+$/g, '');
  cleaned = cleaned.replace(/\/+$/, '');
  // Users often paste the full resource URL from provider documentation,
  // while OpenAI-compatible SDKs expect a base URL and append the resource.
  cleaned = cleaned.replace(/\/(?:chat\/completions|embeddings)(?:[/?#].*)?$/, '');
  if (cleaned && !cleaned.startsWith('http')) {
    cleaned = `https://${cleaned}`;
  }
  return cleaned;
}

export function createChatModel(options: ChatModelOptions): SdkChatModel {
  return new SdkChatModel({ ...options,
    baseUrl: cleanBaseUrl(options.baseUrl || '') || undefined,
    timeoutMs: options.timeoutMs ?? MODEL_POLICY.chatTimeoutMs,
  });
}

export function createEmbeddingModel(options: EmbeddingModelOptions): SdkEmbeddings {
  return new SdkEmbeddings({ ...options, baseUrl: cleanBaseUrl(options.baseUrl || '') || undefined,
    timeoutMs: options.timeoutMs ?? MODEL_POLICY.embeddingTimeoutMs });
}

export function createModelRunConfig(
  operation: string,
  requestId?: string,
  signal?: AbortSignal
): { signal?: AbortSignal; metadata: Record<string, string>; tags: string[] } {
  return {
    signal,
    metadata: {
      component: 'aiwriter',
      operation,
      ...(requestId ? { requestId } : {}),
    },
    tags: ['aiwriter', operation],
  };
}

export function classifyModelError(error: unknown): ModelErrorClassification {
  const value = error as any;
  const name = String(value?.name || '');
  const message = String(value?.message || value || '');
  const code = value?.code || value?.cause?.code || value?.error?.code;
  const statusValue = value?.status ?? value?.statusCode ?? value?.response?.status ?? value?.cause?.status;
  const status = statusValue === undefined ? undefined : Number(statusValue);
  // SDKs can wrap a body/stream transport failure in an HTTP-200 API error.
  // Classify its actual cause, rather than treating 200 as a terminal failure.
  if (status !== undefined && status >= 200 && status < 300 && value?.cause && value.cause !== error) {
    return classifyModelError(value.cause);
  }


  if (name === 'AbortError' || message.startsWith('AbortError') || message.includes('请求已取消')) {
    return { retryable: false, status, code, reason: 'aborted' };
  }
  if (code === 'insufficient_quota' || message.includes('insufficient_quota')) {
    return { retryable: false, status, code, reason: 'insufficient_quota' };
  }
  if (status !== undefined) {
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(status);
    return {
      retryable,
      status,
      code,
      reason: retryable ? `http_${status}` : `non_retryable_http_${status}`,
      retryAfterMs: retryable ? readRetryAfterMs(value) : undefined,
    };
  }

  const retryableCodes = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENOTFOUND',
  ]);
  const retryableMessage = /network|socket hang up|fetch failed|connection reset|temporarily unavailable|timed? out|timeout/i.test(message);
  if (retryableCodes.has(String(code)) || retryableMessage) {
    return { retryable: true, code, reason: code ? `network_${code}` : 'network_error' };
  }
  return { retryable: false, status, code, reason: 'unclassified' };
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? MODEL_POLICY.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? MODEL_POLICY.baseRetryDelayMs;
  const maxDelayMs = options.maxDelayMs ?? MODEL_POLICY.maxRetryDelayMs;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      const classification = classifyModelError(error);
      if (!classification.retryable || attempt >= maxRetries) {
        throw error;
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jittered = Math.max(0, Math.round(exponential * (0.75 + random() * 0.5)));
      const delayMs = Math.min(maxDelayMs, classification.retryAfterMs ?? jittered);
      console.warn(
        `[ModelPolicy] ${options.operation} failed (${classification.reason}); retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`
      );
      await delay(delayMs, options.signal);
    }
  }
}

export async function executeChatModelCall<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const release = await chatSemaphore.acquire(options.signal);
  const ledger = currentRequestTelemetry();
  const logicalCallId = randomUUID();
  try {
    return await executeWithRetry(async () => {
      const attempt = ledger?.begin(options.operation, 'chat', logicalCallId);
      try {
        const result = await operation();
        if (attempt) { await ledger!.finish(attempt, result); }
        return result;
      } catch (error) {
        if (attempt) { await ledger!.finish(attempt, undefined, classifyModelError(error).reason); }
        throw error;
      }
    }, options);
  } finally {
    release();
  }
}

export async function executeEmbeddingCall<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const release = await embeddingSemaphore.acquire(options.signal);
  const ledger = currentRequestTelemetry();
  const logicalCallId = randomUUID();
  try {
    return await executeWithRetry(async () => {
      const attempt = ledger?.begin(options.operation, 'embedding', logicalCallId);
      try {
        const result = await operation();
        if (attempt) { await ledger!.finish(attempt, result); }
        return result;
      } catch (error) {
        if (attempt) { await ledger!.finish(attempt, undefined, classifyModelError(error).reason); }
        throw error;
      }
    }, options);
  } finally {
    release();
  }
}

export async function openChatModelStream<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<{ stream: T; release: () => void }> {
  const release = await chatSemaphore.acquire(options.signal);
  const ledger = currentRequestTelemetry();
  const logicalCallId = randomUUID();
  try {
    let attempt: ReturnType<NonNullable<typeof ledger>['begin']> | undefined;
    const stream = await executeWithRetry(async () => {
      attempt = ledger?.begin(options.operation, 'chat', logicalCallId);
      try { return await operation(); }
      catch (error) {
        if (attempt) { await ledger!.finish(attempt, undefined, classifyModelError(error).reason); }
        throw error;
      }
    }, options);
    if (!ledger || !attempt || !(stream as any)?.[Symbol.asyncIterator]) {
      return { stream, release };
    }
    const activeAttempt = attempt;
    async function* observedStream() {
      let lastUsage: unknown;
      let completed = false;
      let failure = 'aborted';
      try {
        for await (const chunk of stream as any) {
          // Provider chunks generally contain cumulative usage snapshots.
          // Keep the last snapshot; adding them would double count the call.
          if (chunk.usage_metadata) { lastUsage = chunk.usage_metadata; }
          yield chunk;
        }
        completed = true;
      } catch (error) { failure = classifyModelError(error).reason; throw error; }
      finally {
        release();
        await ledger!.finish(activeAttempt, { usage_metadata: lastUsage }, completed ? undefined : failure);
      }
    }
    return { stream: observedStream() as T, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function getModelConcurrencySnapshot(): {
  chat: { active: number; pending: number };
  embedding: { active: number; pending: number };
} {
  return {
    chat: { active: chatSemaphore.active, pending: chatSemaphore.pending },
    embedding: { active: embeddingSemaphore.active, pending: embeddingSemaphore.pending },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = reason instanceof Error ? new Error(reason.message) : new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readRetryAfterMs(error: any): number | undefined {
  const headers = error?.response?.headers || error?.responseHeaders || error?.headers;
  const raw = typeof headers?.get === 'function'
    ? headers.get('retry-after')
    : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(String(raw));
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}
