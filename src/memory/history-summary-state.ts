import { createHash } from 'crypto';
import { ChatMessage, HistorySummary } from '../types';

export function historyPrefixHash(history: readonly ChatMessage[], count: number): string {
  return createHash('sha256').update(JSON.stringify(history.slice(0, count)
    .map(({ role, content, timestamp, requestId }) => ({ role, content, timestamp, requestId })))).digest('hex');
}

export function validHistorySummary(history: readonly ChatMessage[], summary?: HistorySummary): boolean {
  return !!summary && typeof summary.content === 'string' && !!summary.content.trim()
    && Number.isInteger(summary.coveredMessages) && summary.coveredMessages > 0
    && summary.coveredMessages <= history.length
    && summary.prefixHash === historyPrefixHash(history, summary.coveredMessages);
}
