/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/retriever.ts - 检索编排（过滤 + 多查询 RRF 排名融合；无独立模型 reranker）
 *
 * 【RAG 技术点：元数据过滤 + 混合检索 + rerank】
 * - 元数据过滤：检索前用 beforeChapter 把范围限制在"当前章之前"，防剧透、防设定矛盾，
 *   把"该读哪一章"从语义猜测降级成确定性的结构过滤。
 * - 多查询融合：QueryTransformer 生成多条查询（含 HyDE），分别检索后合并。
 * - 混合检索：Vectra 负责向量召回，独立中文 BM25 通道负责人物名、地名、物件名。
 * - 标准 RRF（倒数排名融合）只使用各通道排名，避免直接混合不同量纲的原始分数。
 */
import { Embedder } from './embedder';
import { VectorStore, VectorQueryHit } from './vector-store';
import { QueryTransformer } from './query-transform';
import { RetrievalResult, RagConfig } from './types';
import { currentRequestTelemetry } from '../../ai/runtime/request-telemetry';

export interface RetrieveOptions {
  selection: string;      // 待润色/改写的选段（也是检索锚点）
  intent?: string;        // 用户意图
  beforeChapter?: number; // 章节上界过滤
  useHyde?: boolean;      // 是否启用 HyDE
  transformQuery?: boolean; // 是否调用模型改写查询；评测基线应设为 false
  topK?: number;
  filepath?: string;
  signal?: AbortSignal;
}

export class Retriever {
  constructor(
    private _embedder: Embedder,
    private _store: VectorStore,
    private _transformer: QueryTransformer,
    private _config: RagConfig
  ) {}

  async retrieve(opts: RetrieveOptions): Promise<RetrievalResult[]> {
    const useHyde = opts.useHyde !== false;

    // 1. 查询改写：把选段+意图 → 多条可检索查询 (+ HyDE 假想文档)
    const transformed = opts.transformQuery === false
      ? { queries: [opts.selection] }
      : await this._transformer.transform(
        opts.selection,
        opts.intent || '',
        useHyde,
        opts.signal
      );

    // 汇总所有查询文本：抽取的查询 + HyDE 文档
    const queryTexts = [...transformed.queries];
    if (transformed.hydeDocument) {
      queryTexts.push(transformed.hydeDocument);
    }
    if (queryTexts.length === 0) {
      queryTexts.push(opts.selection.slice(0, 200));
    }

    const uniqueQueryTexts = Array.from(new Set(queryTexts.map(text => text.trim()).filter(Boolean)));

    // 2. 每条查询分别执行向量召回和独立 BM25 关键词召回
    const perQueryK = this._config.vectorCandidates;
    const fused = new Map<string, {
      hit: VectorQueryHit;
      score: number;
      channels: Set<'vector' | 'keyword'>;
    }>();

    for (const qText of uniqueQueryTexts) {
      const keywordHits = await this._store.queryKeyword(qText, perQueryK, opts.beforeChapter, opts.filepath);
      addRankedHits(fused, keywordHits, 'keyword');

      try {
        const vector = await this._embedder.embedQuery(qText, opts.signal);
        const vectorHits = await this._store.queryVector(vector, qText, perQueryK, opts.beforeChapter, opts.filepath);
        addRankedHits(fused, vectorHits, 'vector');
      } catch (error) {
        if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }
        console.warn('[Retriever] 查询向量化失败，跳过该查询:', error);
        currentRequestTelemetry()?.degrade('vector_retrieval_unavailable');
      }
    }

    // 3. 标准 RRF 融合后取 topK；跨通道命中的结果标记为 hybrid
    const ranked = Array.from(fused.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK || this._config.topK);

    return ranked.map((r) => ({
      content: r.hit.content,
      metadata: r.hit.metadata,
      score: r.score,
      source: r.channels.size > 1 ? 'hybrid' : Array.from(r.channels)[0],
    } as RetrievalResult));
  }
}

export function addRankedHits(
  fused: Map<string, { hit: VectorQueryHit; score: number; channels: Set<'vector' | 'keyword'> }>,
  hits: VectorQueryHit[],
  channel: 'vector' | 'keyword',
  rrfConstant = 60
): void {
  hits.forEach((hit, index) => {
    const contribution = 1 / (rrfConstant + index + 1);
    const existing = fused.get(hit.metadata.chunkId);
    if (existing) {
      existing.score += contribution;
      existing.channels.add(channel);
    } else {
      fused.set(hit.metadata.chunkId, {
        hit,
        score: contribution,
        channels: new Set([channel]),
      });
    }
  });
}
