import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TokenCounter } from '../../memory/token-counter';

export interface RequestLogEvent {
  event: string;
  node?: string;
  data?: unknown;
}

export interface RequestLogSink {
  write(logRoot: string | undefined, requestId: string | undefined, event: RequestLogEvent): Promise<void>;
}

export interface TextTelemetry {
  chars: number;
  utf8Bytes: number;
  lines: number;
  tokens?: number;
  sha256: string;
  endsWithSentencePunctuation: boolean;
  endsWithMarkdownFence: boolean;
}

export class RequestJsonlLogger implements RequestLogSink {
  private readonly queues = new Map<string, Promise<void>>();

  async write(
    logRoot: string | undefined,
    requestId: string | undefined,
    event: RequestLogEvent
  ): Promise<void> {
    if (!logRoot || !requestId) {
      return;
    }
    const filepath = getRequestLogPath(logRoot, requestId);
    const directory = path.dirname(filepath);
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      ...event,
      data: summarizeLogData(event.data),
    })}\n`;
    const previous = this.queues.get(filepath) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(directory, { recursive: true });
        await appendFile(filepath, line, 'utf8');
      });
    this.queues.set(filepath, task);
    try {
      await task;
    } catch (error) {
      console.warn('[RequestLogger] Failed to write request log:', error);
    } finally {
      if (this.queues.get(filepath) === task) {
        this.queues.delete(filepath);
      }
    }
  }
}

export function getRequestLogPath(logRoot: string, requestId: string): string {
  const safeRequestId = requestId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown-request';
  return path.join(logRoot, 'logs', 'requests', `${safeRequestId}.jsonl`);
}

export function summarizeText(text: string, counter?: TokenCounter): TextTelemetry {
  const trimmed = text.trimEnd();
  return {
    chars: text.length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    lines: text ? text.split(/\r?\n/).length : 0,
    tokens: counter?.countTokens(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    endsWithSentencePunctuation: /[。！？…]$/.test(trimmed),
    endsWithMarkdownFence: /```$/.test(trimmed),
  };
}

/** One disk boundary for both request and Editor logs. Free text is never raw. */
export function summarizeLogData(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    const labels = new Set(['model', 'operation', 'stage', 'transport', 'role', 'verdict',
      'status', 'outcome', 'taskOutcome', 'reasonCode', 'reasonCodes', 'errorCode', 'usageSource', 'kind',
      'callId', 'logicalCallId', 'attemptId', 'requestId', 'finishReason', 'errorName',
      'sha256', 'beforeSha256', 'afterSha256', 'providerCompletionLimit', 'tool', 'node']);
    return labels.has(key) && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : summarizeText(value);
  }
  if (Array.isArray(value)) { return value.map(item => summarizeLogData(item, key)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, summarizeLogData(item, name)]));
  }
  return value;
}

export function summarizeToolArguments(args: unknown, counter?: TokenCounter): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { valueType: Array.isArray(args) ? 'array' : typeof args };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === 'operations' && Array.isArray(value)) {
      summary[key] = value.map((operation, index) => summarizeModifyOperation(operation, index, counter));
      continue;
    }
    if (typeof value === 'string') {
      if (/^(?:filepath|directory|baseDirectory|filePattern|pattern)$/i.test(key)) {
        summary[key] = value;
      } else {
        summary[key] = summarizeText(value, counter);
      }
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value;
    } else {
      summary[key] = { valueType: Array.isArray(value) ? 'array' : typeof value };
    }
  }
  return summary;
}

function summarizeModifyOperation(
  operation: unknown,
  index: number,
  counter?: TokenCounter
): Record<string, unknown> {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return { index, valueType: Array.isArray(operation) ? 'array' : typeof operation };
  }
  const record = operation as Record<string, unknown>;
  const result: Record<string, unknown> = {
    index,
    type: typeof record.type === 'string' ? record.type : typeof record.type,
  };
  if (record.type === 'append' && typeof record.content === 'string') {
    result.content = summarizeText(record.content, counter);
  }
  if (record.type === 'replace') {
    if (typeof record.oldText === 'string') {
      result.oldText = summarizeText(record.oldText, counter);
    }
    if (typeof record.newText === 'string') {
      result.newText = summarizeText(record.newText, counter);
    }
    result.replaceAll = record.replaceAll === true;
  }
  return result;
}
