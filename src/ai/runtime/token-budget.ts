import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '../messages';
import { TokenCounter } from '../../memory/token-counter';

const TRUNCATION_MARKER = '\n…[内容已按 Token 预算截断]…';

export interface TokenBudgetOptions {
  contextWindowTokens: number;
  maxOutputTokens: number;
  fixedOverheadText?: string;
  safetyMarginTokens?: number;
}

export interface CompletionTokenBudgetOptions {
  /** User-facing target for visible answer tokens. */
  visibleOutputTokens: number;
  /** Full model context window, used as the final safety cap. */
  contextWindowTokens: number;
  /** Provider/model maximum completion size when the catalog knows it. */
  modelMaxOutputTokens?: number;
  /** Hidden reasoning allowance added on top of the visible target. */
  reasoningReserveTokens?: number;
}

export interface CompletionTokenBudget {
  visibleOutputTokens: number;
  reasoningReserveTokens: number;
  requestMaxTokens: number;
  requestedBeforeCaps: number;
  limitedBy?: 'model_max_output' | 'context_window';
}

export interface PreparedMessages {
  messages: BaseMessage[];
  inputTokens: number;
  inputBudget: number;
  droppedMessages: number;
  truncatedMessages: number;
}

export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
}

export class TokenBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenBudgetExceededError';
  }
}

/**
 * Convert the user's visible-output target into the completion budget sent to
 * an OpenAI-compatible provider. Reasoning models count hidden reasoning and
 * visible text against the same max_tokens/max_completion_tokens allowance.
 */
export function calculateCompletionTokenBudget(
  options: CompletionTokenBudgetOptions
): CompletionTokenBudget {
  const visibleOutputTokens = Math.max(1, Math.floor(options.visibleOutputTokens));
  const contextWindowTokens = Math.max(1_000, Math.floor(options.contextWindowTokens));
  const requestedReasoningReserve = Math.max(
    0,
    Math.floor(options.reasoningReserveTokens ?? Math.max(4_096, visibleOutputTokens))
  );
  const requestedBeforeCaps = visibleOutputTokens + requestedReasoningReserve;
  const contextCap = Math.max(1, contextWindowTokens - 256);
  const modelCap = positiveTokenLimit(options.modelMaxOutputTokens);
  const requestMaxTokens = Math.min(requestedBeforeCaps, contextCap, modelCap ?? Number.MAX_SAFE_INTEGER);

  let limitedBy: CompletionTokenBudget['limitedBy'];
  if (modelCap !== undefined && modelCap <= contextCap && requestMaxTokens < requestedBeforeCaps) {
    limitedBy = 'model_max_output';
  } else if (requestMaxTokens < requestedBeforeCaps) {
    limitedBy = 'context_window';
  }

  return {
    visibleOutputTokens,
    reasoningReserveTokens: Math.max(0, requestMaxTokens - visibleOutputTokens),
    requestMaxTokens,
    requestedBeforeCaps,
    limitedBy,
  };
}

export function prepareMessagesForModel(
  sourceMessages: readonly BaseMessage[],
  counter: TokenCounter,
  options: TokenBudgetOptions
): PreparedMessages {
  const contextWindow = Math.max(1_000, options.contextWindowTokens);
  const safetyMargin = options.safetyMarginTokens
    ?? Math.min(1_024, Math.max(128, Math.floor(contextWindow * 0.05)));
  const outputReserve = Math.min(
    Math.max(256, options.maxOutputTokens),
    Math.max(1, contextWindow - safetyMargin - 64)
  );
  const fixedOverheadTokens = options.fixedOverheadText
    ? counter.countTokens(options.fixedOverheadText)
    : 0;
  const inputBudget = contextWindow - outputReserve - safetyMargin;

  if (inputBudget <= fixedOverheadTokens + 64) {
    throw new TokenBudgetExceededError(
      `模型上下文窗口过小：窗口 ${contextWindow}，输出预留 ${outputReserve}，固定开销 ${fixedOverheadTokens}`
    );
  }

  const messages = [...sourceMessages];
  let droppedMessages = 0;
  let truncatedMessages = 0;
  const countInput = () => counter.countMessageLike(messages) + fixedOverheadTokens;
  let inputTokens = countInput();

  // Drop only history before the current user turn. Everything after the last
  // HumanMessage may be an active tool-call protocol sequence and must remain.
  if (inputTokens > inputBudget) {
    const lastHumanIndex = findLastMessageIndex(messages, 'human');
    const dropped = new Set<number>();
    for (let index = 0; index < lastHumanIndex && inputTokens > inputBudget; index++) {
      if (getMessageType(messages[index]) === 'system') {
        continue;
      }

      dropped.add(index);
      droppedMessages++;
      inputTokens -= messageTokenCost(messages[index], counter);

      // Drop the rest of the old turn as a unit, including SDK reasoning
      // and tool call/result pairs. Never leave an orphaned tool result.
      while (index + 1 < lastHumanIndex && getMessageType(messages[index + 1]) !== 'human') {
        index++;
        if (getMessageType(messages[index]) === 'system') { continue; }
        dropped.add(index);
        droppedMessages++;
        inputTokens -= messageTokenCost(messages[index], counter);
      }
    }
    if (dropped.size > 0) {
      const retained = messages.filter((_, index) => !dropped.has(index));
      messages.splice(0, messages.length, ...retained);
    }
  }

  // Compact project memory, static references and normalized tool evidence.
  // Current-request attachments belong to the HumanMessage and stay intact.
  for (let index = 1; index < messages.length && inputTokens > inputBudget; index++) {
    if (getMessageType(messages[index]) !== 'system') {
      continue;
    }
    const reduced = truncateMessageToFit(messages[index], inputTokens - inputBudget, counter, 96);
    if (reduced) {
      messages[index] = reduced;
      truncatedMessages++;
      inputTokens = countInput();
    }
  }

  // Tool results can be arbitrarily large. Preserve the ToolMessage and its ID,
  // but compact its content so the provider protocol stays valid.
  for (let index = 0; index < messages.length && inputTokens > inputBudget; index++) {
    if (getMessageType(messages[index]) !== 'tool') {
      continue;
    }
    const reduced = truncateMessageToFit(messages[index], inputTokens - inputBudget, counter, 128);
    if (reduced) {
      messages[index] = reduced;
      truncatedMessages++;
      inputTokens = countInput();
    }
  }

  if (inputTokens > inputBudget) {
    throw new TokenBudgetExceededError(
      `请求内容超过上下文预算：输入约 ${inputTokens} tokens，可用预算 ${inputBudget} tokens。请缩短当前指令或减少收集文本。`
    );
  }

  return { messages, inputTokens, inputBudget, droppedMessages, truncatedMessages };
}

export function normalizeUsageMetadata(
  metadata: any,
  fallbackInputTokens: number,
  fallbackOutputTokens: number
): ModelUsageSummary {
  const inputTokens = finiteNumber(
    metadata?.input_tokens ?? metadata?.prompt_tokens ?? metadata?.inputTokens,
    fallbackInputTokens
  );
  const outputTokens = finiteNumber(
    metadata?.output_tokens ?? metadata?.completion_tokens ?? metadata?.outputTokens,
    fallbackOutputTokens
  );
  const totalTokens = finiteNumber(
    metadata?.total_tokens ?? metadata?.totalTokens,
    inputTokens + outputTokens
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    lastInputTokens: inputTokens,
    lastOutputTokens: outputTokens,
  };
}

export function addUsageSummaries(
  current: ModelUsageSummary | undefined,
  next: ModelUsageSummary | undefined
): ModelUsageSummary {
  if (!current) {
    return next || emptyUsageSummary();
  }
  if (!next) {
    return current;
  }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    lastInputTokens: next.lastInputTokens,
    lastOutputTokens: next.lastOutputTokens,
  };
}

export function emptyUsageSummary(): ModelUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
  };
}

export function serializeToolSchemas(tools: readonly any[]): string {
  return JSON.stringify(tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  })));
}

function truncateMessageToFit(
  message: BaseMessage,
  tokensToRemove: number,
  counter: TokenCounter,
  minimumTokens: number
): BaseMessage | undefined {
  const content = contentToText(message.content);
  const currentTokens = counter.countTokens(content);
  if (currentTokens <= minimumTokens) {
    return undefined;
  }
  const targetTokens = Math.max(minimumTokens, currentTokens - tokensToRemove - 8);
  const truncated = truncateTextToTokens(content, targetTokens, counter);
  if (truncated === content) {
    return undefined;
  }
  const type = getMessageType(message);
  if (type === 'system') {
    return new SystemMessage(truncated);
  }
  if (type === 'tool') {
    const toolMessage = message as ToolMessage;
    return new ToolMessage({
      content: truncated,
      tool_call_id: toolMessage.tool_call_id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  if (type === 'human') {
    return new HumanMessage(truncated);
  }
  return new AIMessage(truncated);
}

function truncateTextToTokens(text: string, targetTokens: number, counter: TokenCounter): string {
  if (counter.countTokens(text) <= targetTokens) {
    return text;
  }
  // Binary-search Unicode code points, not UTF-16 code units, so the prefix
  // can never end with half of a surrogate pair.
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join('') + TRUNCATION_MARKER;
    if (counter.countTokens(candidate) <= targetTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best || TRUNCATION_MARKER.trim();
}

function findLastMessageIndex(messages: readonly BaseMessage[], type: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (getMessageType(messages[index]) === type) {
      return index;
    }
  }
  return messages.length;
}

function getMessageType(message: BaseMessage): string {
  return message.getType();
}

function messageTokenCost(message: BaseMessage, counter: TokenCounter): number {
  // countMessageLike adds a fixed two-token conversation suffix. Remove it
  // when calculating one message's contribution to an already-counted list.
  return Math.max(0, counter.countMessageLike([message]) - 2);
}

function contentToText(content: BaseMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  // Several OpenAI-compatible providers emit an all-zero usage object when
  // usage reporting is unsupported. Preserve a meaningful local estimate.
  return numeric === 0 && fallback > 0 ? fallback : numeric;
}

function positiveTokenLimit(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}
