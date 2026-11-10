import { EvidenceLedger } from '../tools/retrieval-evidence';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { RequestLogSink } from './request-logger';

export interface AttemptRecord {
  logicalCallId: string;
  attemptId: string;
  operation: string;
  kind: 'chat' | 'embedding';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  durationMs: number;
  usageSource: 'actual' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  errorCode?: string;
}

const context = new AsyncLocalStorage<RequestTelemetry>();
export function currentRequestTelemetry(): RequestTelemetry | undefined { return context.getStore(); }

/** Request-scoped attempt ledger. Missing provider usage never means free. */
export class RequestTelemetry {
  readonly evidence = new EvidenceLedger();
  private readonly attempts: AttemptRecord[] = [];
  private readonly reasons = new Set<string>();
  private readonly startedAt = Date.now();
  private closed = false;
  private received = false;
  private firstVisibleMs?: number;
  private finalAnswerStartMs?: number;
  contextUsagePercent?: number;

  constructor(readonly requestId: string, private readonly logRoot?: string, private readonly logger?: RequestLogSink) {}

  run<T>(action: () => Promise<T>): Promise<T> {
    if (!this.received) { this.received = true; void this.log('request_received', { startedAt: this.startedAt }); }
    return context.run(this, action);
  }
  markFirstVisible(at = Date.now()): void {
    if (this.closed || this.firstVisibleMs !== undefined) { return; }
    this.firstVisibleMs = Math.max(0, at - this.startedAt);
    void this.log('first_visible_output', { elapsedMs: this.firstVisibleMs });
  }
  markFinalAnswerStart(at: number, agentTurn: number): void {
    if (this.closed || this.finalAnswerStartMs !== undefined) { return; }
    this.finalAnswerStartMs = Math.max(0, at - this.startedAt);
    // Recorded after the turn is known to contain no tool calls; elapsedMs is
    // the actual first output time, not the later classification/log time.
    void this.log('final_answer_start', { elapsedMs: this.finalAnswerStartMs, agentTurn });
  }
  degrade(reasonCode: string): void { if (!this.closed) { this.reasons.add(reasonCode); } }
  async observe(event: string, data: unknown): Promise<void> {
    if (!this.closed) { await this.log(event, data); }
  }

  begin(operation: string, kind: AttemptRecord['kind'], logicalCallId: string): AttemptRecord {
    const attempt: AttemptRecord = { operation, kind, logicalCallId, attemptId: randomUUID(),
      status: 'running', startedAt: Date.now(), durationMs: 0, usageSource: 'unknown' };
    if (!this.closed) { this.attempts.push(attempt); }
    return attempt;
  }

  async finish(attempt: AttemptRecord, response?: any, errorCode?: string): Promise<void> {
    if (this.closed || attempt.status !== 'running') { return; }
    const raw = response?.raw || response;
    const usage = raw?.usage_metadata || raw?.usage || raw?.response_metadata?.tokenUsage;
    const input = tokenNumber(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.inputTokens ?? usage?.promptTokens);
    const output = tokenNumber(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.outputTokens ?? usage?.completionTokens);
    if (input !== undefined && output !== undefined) {
      attempt.usageSource = 'actual';
      attempt.inputTokens = input;
      attempt.outputTokens = output;
      attempt.totalTokens = tokenNumber(usage?.total_tokens ?? usage?.totalTokens) ?? input + output;
    }
    attempt.model = typeof raw?.response_metadata?.model_name === 'string' ? raw.response_metadata.model_name : undefined;
    attempt.status = errorCode === 'aborted' ? 'interrupted' : errorCode ? 'failed' : 'completed';
    attempt.errorCode = errorCode;
    attempt.durationMs = Date.now() - attempt.startedAt;
    await this.log('model_attempt', attempt);
  }

  snapshot() {
    const chat = this.attempts.filter(item => item.kind === 'chat');
    const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') => chat.reduce((total, item) => total + (item[key] || 0), 0);
    const unknownAttempts = chat.filter(item => item.usageSource === 'unknown' || item.status === 'running').length;
    return {
      requestId: this.requestId,
      elapsedMs: Date.now() - this.startedAt,
      firstVisibleMs: this.firstVisibleMs ?? null, finalAnswerStartMs: this.finalAnswerStartMs ?? null,
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
      logicalCalls: new Set(this.attempts.map(item => item.logicalCallId)).size,
      attempts: this.attempts.length,
      embeddingAttempts: this.attempts.filter(item => item.kind === 'embedding').length,
      unknownEmbeddingAttempts: this.attempts.filter(item => item.kind === 'embedding' && item.usageSource === 'unknown').length,
      unknownAttempts,
      usageComplete: unknownAttempts === 0,
      reasonCodes: [...this.reasons],
      // No price model is configured. Never manufacture an invoice from tokens.
      cost: null,
      contextUsagePercent: this.contextUsagePercent,
    };
  }

  async complete(result: { status: string; taskOutcome?: string; reasonCodes?: string[] }): Promise<void> {
    // A cancelled transport may still settle later. Freeze the request report;
    // outstanding attempts remain explicitly unknown rather than disappearing.
    this.closed = true;
    await this.log('request_summary', { ...this.snapshot(), status: result.status,
      taskOutcome: result.taskOutcome || (result.status === 'COMPLETED' ? 'unverified' : 'failed'),
      reasonCodes: [...new Set([...this.reasons, ...(result.reasonCodes || [])])] });
  }

  private async log(event: string, data: unknown): Promise<void> {
    try { await this.logger?.write(this.logRoot, this.requestId, { event, data }); }
    catch { /* Observability must never fail a user operation. */ }
  }
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
