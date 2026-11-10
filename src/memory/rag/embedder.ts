/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/embedder.ts - 文本向量化
 *
 * 【RAG 技术点：Embedding】
 * - 把文本块转成向量，语义相近的文本在向量空间中距离更近，这是语义检索的基础。
 * - 复用插件已配置的 OpenAI 兼容接口（baseUrl / apiKey），默认用 text-embedding-3-small：
 *   便宜、维度 1536、对中文够用。
 * - 批处理（batch）+ 失败重试：百万字会产生上万个块，逐条请求既慢又贵，必须批量。
 */
import { OllamaEmbeddings } from './ollama';
import { createEmbeddingModel, executeEmbeddingCall } from '../../ai/models/model-policy';

export interface EmbedderOptions {
  provider?: 'openai-compatible' | 'ollama';
  apiKey: string;
  baseUrl?: string;
  model: string;
  batchSize: number;
}

const MODEL_BATCH_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'qwen3.7-text-embedding': 20,
  'text-embedding-v4': 10,
  'text-embedding-v2': 25,
});

/**
 * Normalize a user-configured batch size and enforce limits published by
 * known embedding providers. Unknown models keep the configured value so
 * private OpenAI-compatible endpoints are not restricted unnecessarily.
 */
export function resolveEmbeddingBatchSize(model: string, configuredSize: number): number {
  const requestedSize = Number.isFinite(configuredSize)
    ? Math.max(1, Math.floor(configuredSize))
    : 10;
  const modelLimit = MODEL_BATCH_LIMITS[model.trim().toLowerCase()];
  return modelLimit ? Math.min(requestedSize, modelLimit) : requestedSize;
}

export class Embedder {
  private _client: ReturnType<typeof createEmbeddingModel> | OllamaEmbeddings;
  private _batchSize: number;

  constructor(opts: EmbedderOptions) {
    this._client = opts.provider === 'ollama' ? new OllamaEmbeddings(opts.baseUrl, opts.model) : createEmbeddingModel({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    });
    this._batchSize = opts.provider === 'ollama' ? 1 : resolveEmbeddingBatchSize(opts.model, opts.batchSize);
  }

  /**
   * 向量化一批文本。内部按 batchSize 分批，逐批重试，返回与输入等长的向量数组。
   * @param onProgress 可选进度回调 (已完成数, 总数)
   */
  async embedTexts(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this._batchSize) {
      const batch = texts.slice(i, i + this._batchSize);
      const vectors = await executeEmbeddingCall(
        () => this._client.embedDocuments(batch, signal),
        { operation: 'rag.embed_documents', signal }
      );
      results.push(...vectors);
      onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
    }
    return results;
  }

  /**
   * 单条文本向量化（用于查询）。
   */
  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return executeEmbeddingCall(
      () => this._client.embedQuery(text, signal),
      { operation: 'rag.embed_query', signal }
    );
  }
}
