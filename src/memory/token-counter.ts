/*
 * AI Writer - Token 用量计算器
 *
 * 功能：
 *   - 计算文本的 token 数量
 *   - 计算整个对话历史的 token 总数
 *   - 检查是否接近上下文窗口限制
 */

import { encoding_for_model, Tiktoken } from 'tiktoken';
import { ChatMessage } from '../types';

export class TokenCounter {
  private _encoding: Tiktoken | null = null;
  private _modelName: string;
  private _contextWindowSize: number; // 最大上下文窗口（千token）

  constructor(modelName: string, contextWindowSize: number) {
    this._modelName = modelName;
    this._contextWindowSize = contextWindowSize * 1000; // 转成实际token数
    this._initEncoding();
    console.log(`[TokenCounter] Initialized for model: ${modelName}, context window: ${this._contextWindowSize} tokens`);
  }

  private _initEncoding(): void {
    const model = this._modelName.trim();
    if (!model) {
      this._encoding = null;
      console.warn('[TokenCounter] Model ID is empty; using local character-based token estimates');
      return;
    }
    try {
      // Pass the exact user-supplied model ID to tiktoken. Unsupported custom
      // models use the local estimate below; they are never impersonated as a
      // GPT model just to obtain an encoding.
      this._encoding = encoding_for_model(model as any);
      console.log(`[TokenCounter] Encoding initialized for model: ${model}`);
    } catch {
      console.warn(`[TokenCounter] No local tiktoken encoding for exact model ID: ${model}; using character-based estimates`);
      this._encoding = null;
    }
  }

  /**
   * 计算单个文本的 token 数量
   */
  countTokens(text: string): number {
    if (!this._encoding) {
      // 回退估算：平均每个英文单词 ~1.3 token，中文每个字 ~1 token
      const estimated = Math.ceil(text.length * 0.8);
      console.log(`[TokenCounter] No encoding available, estimated: ${estimated} tokens for ${text.length} chars`);
      return estimated;
    }

    try {
      const tokens = this._encoding.encode(text);
      const count = tokens.length;
      console.log(`[TokenCounter] Counted: ${count} tokens for ${text.length} characters`);
      return count;
    } catch (error) {
      console.error('[TokenCounter] Error counting tokens', error);
      const estimated = Math.ceil(text.length * 0.8);
      return estimated;
    }
  }

  /**
   * Truncate text to an actual token limit instead of guessing from character
   * count. The marker is included in the token budget.
   */
  truncateText(text: string, maxTokens: number, marker = '\n……（已按 Token 预算截断）'): string {
    const limit = Math.max(0, Math.floor(maxTokens));
    if (limit === 0) {
      return '';
    }

    if (!this._encoding) {
      const estimatedChars = Math.max(0, Math.floor(limit / 0.8) - marker.length);
      return text.length <= estimatedChars ? text : `${text.slice(0, estimatedChars)}${marker}`;
    }

    try {
      const tokens = this._encoding.encode(text);
      if (tokens.length <= limit) {
        return text;
      }

      const markerTokens = this._encoding.encode(marker);
      if (markerTokens.length >= limit) {
        return Buffer.from(this._encoding.decode(markerTokens.slice(0, limit))).toString('utf8');
      }
      const contentTokens = tokens.slice(0, limit - markerTokens.length);
      return `${Buffer.from(this._encoding.decode(contentTokens)).toString('utf8')}${marker}`;
    } catch (error) {
      console.error('[TokenCounter] Error truncating text', error);
      const estimatedChars = Math.max(0, Math.floor(limit / 0.8) - marker.length);
      return text.length <= estimatedChars ? text : `${text.slice(0, estimatedChars)}${marker}`;
    }
  }

  /**
   * 计算整个消息列表的 token 总数
   */
  countMessages(messages: ChatMessage[]): number {
    return this.countMessageLike(messages);
  }

  /** Count runtime messages and persisted ChatMessage objects uniformly. */
  countMessageLike(messages: readonly { content: unknown; additional_kwargs?: Record<string, unknown> }[]): number {
    let total = 0;
    for (const message of messages) {
      const protocol = message.additional_kwargs?.ai_sdk_content;
      const content = Array.isArray(protocol) ? JSON.stringify(protocol) : typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      total += this.countTokens(content) + 4;
    }
    return total + 2;
  }

  /**
   * 检查是否接近上下文窗口限制
   * @returns 使用率百分比（0-1）
   */
  getUsagePercentage(totalTokens: number): number {
    const percentage = totalTokens / this._contextWindowSize;
    console.log(`[TokenCounter] Context usage: ${(percentage * 100).toFixed(1)}% (${totalTokens}/${this._contextWindowSize})`);
    return percentage;
  }

  /**
   * 是否需要警告（超过 80%）
   */
  shouldWarn(totalTokens: number): boolean {
    const percentage = this.getUsagePercentage(totalTokens);
    const shouldWarn = percentage > 0.8;
    if (shouldWarn) {
      console.warn(`[TokenCounter] WARNING: Context window is ${(percentage * 100).toFixed(1)}% full`);
    }
    return shouldWarn;
  }

  /**
   * 更新模型配置
   */
  updateConfig(modelName: string, contextWindowSize: number): void {
    console.log(`[TokenCounter] Updating config: model=${modelName}, contextWindow=${contextWindowSize}k`);
    this._modelName = modelName;
    this._contextWindowSize = contextWindowSize * 1000;

    // 重新初始化编码
    if (this._encoding) {
      this._encoding.free();
    }
    this._initEncoding();
  }

  /**
   * 获取上下文窗口大小
   */
  getContextWindowSize(): number {
    return this._contextWindowSize;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this._encoding) {
      this._encoding.free();
      this._encoding = null;
    }
    console.log('[TokenCounter] Disposed');
  }
}

/**
 * Token 统计结果
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextUsagePercent: number;
  shouldWarn: boolean;
}

/**
 * 计算完整统计
 */
export function calculateStats(
  messages: ChatMessage[],
  outputTokens: number,
  modelName: string,
  contextWindowSize: number
): TokenStats {
  const counter = new TokenCounter(modelName, contextWindowSize);
  const inputTokens = counter.countMessages(messages);
  const totalTokens = inputTokens + outputTokens;
  const contextUsagePercent = counter.getUsagePercentage(totalTokens) * 100;
  const shouldWarn = counter.shouldWarn(totalTokens);

  const stats: TokenStats = {
    inputTokens,
    outputTokens,
    totalTokens,
    contextUsagePercent,
    shouldWarn,
  };

  console.log('[TokenCounter] Final stats:', JSON.stringify(stats, null, 2));

  counter.dispose();
  return stats;
}
