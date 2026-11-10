import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { IFileSystem } from '../../types';
import { BaseMessage, SystemMessage, ToolMessage } from '../messages';
import { EvidenceLedger, EvidencePiece } from '../tools/retrieval-evidence';
import { TokenCounter } from '../../memory/token-counter';
import prompts from './prompts/context.json';

export function evidenceBudget(counter: TokenCounter, requested?: number): number {
  return Math.max(0, Math.min(requested ?? 12_000, Math.floor(counter.getContextWindowSize() * 0.25)));
}

export function evidenceText(record: EvidencePiece): string {
  return `[${record.id}｜${record.filepath}｜字符 ${record.start}～${record.end}｜版本 ${record.version}]\n${record.content}`;
}

interface Span { message: number; start: number; end: number; record: EvidencePiece; tokens: number }
export interface EvidenceProjection {
  messages: BaseMessage[];
  sourceTokens: number;
  carriedTokens: number;
  carriedPieces: number;
  omittedPieces: number;
  protectedOverflowTokens: number;
}

/** Project tool result bodies only. Never rewrite assistant thinking, call IDs,
 * arguments, user attachments, mutation receipts or the stored conversation. */
export function projectEvidenceContext(
  source: readonly BaseMessage[], ledger: EvidenceLedger, counter: TokenCounter,
  budget: number, inherited: readonly EvidencePiece[] = [],
): EvidenceProjection {
  const messages = [...source];
  const inheritedRecords = [...inherited].reverse();
  if (inheritedRecords.length) {
    messages.unshift(new SystemMessage(prompts.inheritedEvidence + '\n\n' + inheritedRecords.map(evidenceText).join('\n\n')));
  }
  const spans: Span[] = [];
  const records = [...ledger.cache.records, ...inherited].sort((a, b) => b.content.length - a.content.length);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const isInherited = inheritedRecords.length && index === 0;
    if (!isInherited && (!(message instanceof ToolMessage) || message.status === 'error'
      || !['readFile', 'searchInFiles', 'searchStory', 'researchWorkspace'].includes(message.name || ''))) { continue; }
    if (typeof message.content !== 'string') { continue; }
    const text = message.content;
    // Only registered, verbatim source bodies can be evicted. Text resembling
    // an evidence header inside a novel is never parsed into a new record.
    const occupied: Array<[number, number]> = [];
    for (const record of records) {
      const block = evidenceText(record);
      let offset = 0;
      while (offset < text.length) {
        const start = text.indexOf(block, offset);
        if (start < 0) { break; }
        const end = start + block.length;
        offset = end;
        if (occupied.some(([a, b]) => start < b && end > a)) { continue; }
        occupied.push([start, end]);
        spans.push({ message: index, start, end, record, tokens: counter.countTokens(block) });
      }
    }
  }
  spans.sort((a, b) => b.message - a.message || b.start - a.start);
  const latestToolMessage = spans.find(span => messages[span.message] instanceof ToolMessage)?.message;
  const kept = new Set<Span>();
  const selected: EvidencePiece[] = [];
  const overlaps = (record: EvidencePiece) => selected.some(item => item.filepath === record.filepath
    && item.version === record.version && item.start < record.end && item.end > record.start);
  let carriedTokens = 0;
  // The latest retrieval exchange stays intact for local edits and quotations.
  // A single large read may exceed the soft evidence budget; log that explicitly.
  for (const span of spans) {
    if (span.message !== latestToolMessage) { continue; }
    if (!overlaps(span.record)) { kept.add(span); selected.push(span.record); carriedTokens += span.tokens; }
  }
  for (const span of spans) {
    if (kept.has(span) || overlaps(span.record) || carriedTokens + span.tokens > budget) { continue; }
    kept.add(span); selected.push(span.record); carriedTokens += span.tokens;
  }
  const omitted = spans.filter(span => !kept.has(span));
  for (let index = 0; index < messages.length; index++) {
    const removals = omitted.filter(span => span.message === index).sort((a, b) => b.start - a.start);
    if (!removals.length) { continue; }
    const message = messages[index];
    let content = String(message.content);
    for (const span of removals) {
      const record = span.record;
      const pointer = prompts.omittedEvidence + '\n' + JSON.stringify({ evidenceId: record.id, filepath: record.filepath,
        offset: record.start, maxChars: record.end - record.start, expectedSha256: record.version });
      content = content.slice(0, span.start) + pointer + content.slice(span.end);
    }
    messages[index] = message instanceof ToolMessage
      ? new ToolMessage({ ...message, content }) : new SystemMessage({ ...message, content });
  }
  return { messages, sourceTokens: spans.reduce((total, span) => total + span.tokens, 0), carriedTokens,
    carriedPieces: kept.size, omittedPieces: omitted.length, protectedOverflowTokens: Math.max(0, carriedTokens - budget) };
}

/** Build a bounded handoff without an LLM. Each selected file version is checked
 * once; stale or unreadable pieces are not represented as supplied evidence. */
export async function createEvidenceHandoff(
  parent: EvidenceLedger | undefined, fileSystem: IFileSystem, counter: TokenCounter,
  options: { sourcePaths?: string[]; workspacePath?: string; budget?: number; signal?: AbortSignal } = {},
): Promise<EvidencePiece[]> {
  if (!parent) { return []; }
  const normalized = (value: string) => path.resolve(options.workspacePath || '.', value);
  const preferred = new Set((options.sourcePaths || []).map(normalized));
  const candidates = [...parent.cache.records].reverse().sort((a, b) =>
    Number(preferred.has(normalized(b.filepath))) - Number(preferred.has(normalized(a.filepath))));
  const versions = new Map<string, string | undefined>();
  const selected: EvidencePiece[] = [];
  let remaining = options.budget ?? Math.min(4000, evidenceBudget(counter) / 2);
  for (const record of candidates) {
    options.signal?.throwIfAborted();
    if (!record.id || remaining < 64) { continue; }
    if (selected.some(item => normalized(item.filepath) === normalized(record.filepath) && item.version === record.version
      && item.start < record.end && item.end > record.start)) { continue; }
    let piece = record;
    if (counter.countTokens(evidenceText(piece)) > remaining) {
      let low = 0, high = record.content.length;
      while (low < high) {
        const end = Math.ceil((low + high) / 2);
        const candidate = { ...record, end: record.start + end, content: record.content.slice(0, end) };
        if (counter.countTokens(evidenceText(candidate)) <= remaining) { low = end; } else { high = end - 1; }
      }
      if (/[\uD800-\uDBFF]/.test(record.content[low - 1])) { low--; }
      if (low <= 0) { continue; }
      piece = { ...record, end: record.start + low, content: record.content.slice(0, low) };
    }
    const cost = counter.countTokens(evidenceText(piece));
    const filename = normalized(record.filepath);
    if (!versions.has(filename)) {
      try {
        const response = await fileSystem.readFile(filename);
        options.signal?.throwIfAborted();
        versions.set(filename, response.success ? response.version
          || createHash('sha256').update(response.content || '').digest('hex') : undefined);
      } catch (error) {
        if (options.signal?.aborted) { throw error; }
        versions.set(filename, undefined);
      }
    }
    if (versions.get(filename) !== record.version) { continue; }
    selected.push({ ...piece });
    remaining -= cost;
  }
  return selected;
}
