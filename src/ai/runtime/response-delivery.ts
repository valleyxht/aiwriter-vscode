import { currentRequestTelemetry } from './request-telemetry';
import type { AIStreamCallback } from './engine';

/** Forwards tokens and collects the final text without a second model pass. */
export class ResponseDelivery {
  private response = '';

  constructor(private readonly callback: AIStreamCallback) {}

  push(token: string): void {
    if (!token) { return; }
    this.response += token;
    this.callback(token, false);
    if (token.trim()) { currentRequestTelemetry()?.markFirstVisible(); }
  }

  acceptCompleteResponse(content: string): void {
    if (this.response || !content) { return; }
    this.push(content);
  }

  get content(): string { return this.response; }
}
