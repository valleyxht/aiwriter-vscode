import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '../messages';
import { ChatMessage, HistorySummary } from '../../types';
import { TokenCounter } from '../../memory/token-counter';
import prompts from './prompts/history-summary.json';
import { historyPrefixHash, validHistorySummary } from '../../memory/history-summary-state';
export { historyPrefixHash, validHistorySummary } from '../../memory/history-summary-state';

export function historyMessages(history: readonly ChatMessage[]): BaseMessage[] {
  return history.map(message => message.role === 'user' ? new HumanMessage(message.content)
    : message.role === 'assistant' ? new AIMessage({ content: message.content,
      additional_kwargs: message.modelContext ? { ai_sdk_content: message.modelContext.content,
        ai_sdk_connection: { baseUrl: message.modelContext.baseUrl, model: message.modelContext.model } } : {} })
      : new SystemMessage(message.content));
}

export function summaryMessages(history: readonly ChatMessage[], summary?: HistorySummary): BaseMessage[] {
  if (!validHistorySummary(history, summary)) { return historyMessages(history); }
  return [new SystemMessage(`【较早历史的累计摘要，仅作对话背景】\n${summary!.content}`),
    ...historyMessages(history.slice(summary!.coveredMessages))];
}

/** Summarize bounded history batches without changing the original session. */
export async function compactHistory(options: {
  history: readonly ChatMessage[];
  previous?: HistorySummary;
  counter: TokenCounter;
  historyBudget: number;
  summaryInputBudget: number;
  summaryMaxTokens: number;
  llm: { invoke(prompt: string): Promise<string> };
  signal?: AbortSignal;
}): Promise<HistorySummary | undefined> {
  const { history, counter, signal } = options;
  const previous = validHistorySummary(history, options.previous) ? options.previous : undefined;
  const visible = summaryMessages(history, previous);
  if (counter.countMessageLike(visible) <= options.historyBudget * 0.8) { return previous; }

  // Cut only at user-turn boundaries and retain at least the latest two turns.
  const starts = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  const candidates = starts.slice(0, -2).map((_, index) => starts[index + 1])
    .filter(index => index > (previous?.coveredMessages || 0));
  let covered = previous?.coveredMessages || 0;
  for (const boundary of candidates) {
    covered = boundary;
    if (counter.countMessageLike(historyMessages(history.slice(boundary)))
      + options.summaryMaxTokens <= options.historyBudget * 0.6) { break; }
  }
  if (covered === (previous?.coveredMessages || 0)) { return previous; }

  const format = (summary: string, lines: string) => prompts.prompt.replace(/\{(max_tokens|summary|new_lines)\}/g,
    (_match, key: string) => key === 'max_tokens' ? String(options.summaryMaxTokens) : key === 'summary' ? summary : lines);
  let summary = previous?.content || '';
  const source = history.slice(previous?.coveredMessages || 0, covered)
    .map(message => `${message.role === 'user' ? 'Human' : message.role === 'assistant' ? 'AI' : 'System'}: ${message.content}`).join('\n');
  let offset = 0;
  while (offset < source.length) {
    signal?.throwIfAborted();
    // Include the running summary and prompt overhead in every summary call.
    let low = offset;
    let high = source.length;
    while (low < high) {
      let end = Math.ceil((low + high) / 2);
      const text = format(summary, 'Human: ' + source.slice(offset, end));
      if (counter.countTokens(text) + 16 <= options.summaryInputBudget) { low = end; }
      else { high = end - 1; }
    }
    let end = low;
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) { end--; }
    if (end <= offset) { throw new Error('历史摘要输入预算不足'); }
    const next = await options.llm.invoke(format(summary, 'Human: ' + source.slice(offset, end)));
    signal?.throwIfAborted();
    if (!next.trim() || counter.countTokens(next) > options.summaryMaxTokens) {
      throw new Error('历史摘要为空或超过预算，保留原历史与已有摘要');
    }
    summary = next.trim();
    offset = end;
  }
  return { content: summary, coveredMessages: covered, prefixHash: historyPrefixHash(history, covered) };
}
