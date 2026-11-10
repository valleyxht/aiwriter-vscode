/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/types.ts - RAG 相关类型定义
 * 功能：定义切块、向量、检索管线使用的类型
 * 包含：
 *   - Chunk 与 ChunkMetadata（切块及其元数据，元数据用于检索过滤）
 *   - EmbeddedChunk（带向量的块）
 *   - RetrievalResult（检索结果，含出处和分数）
 *   - RagConfig（RAG 可调参数）
 */

/**
 * 块的元数据。
 * 这是 RAG 的关键设计：检索时靠这些字段做过滤（如 chapterIndex <= 当前章 防剧透），
 * 把"模型该读哪一章"从语义问题降级成结构问题。
 */
export interface ChunkMetadata {
  contentVersion?: string;
  chunkId: string;        // 全局唯一 id：`${filepathHash}:${chapterIndex}:${seq}`
  filepath: string;       // 来源文件绝对路径
  filepathHash: string;   // 文件路径 hash，用于增量 upsert 分组
  chapterIndex: number;   // 章节序号（从 0 开始）；无法识别章节时为 -1
  title: string;          // 章节标题，无则为空串
  headingPath: string;    // Markdown/章节层级路径，如“第二卷 > 第十二章 > 雨夜”
  charStart: number;      // 在原文件中的起始字符偏移
  charEnd: number;        // 在原文件中的结束字符偏移
  seq: number;            // 同一章内的块序号
}

/**
 * 一个文本块（切块产物，尚未向量化）
 */
export interface Chunk {
  content: string;
  metadata: ChunkMetadata;
}

/**
 * 带向量的块（embedding 产物）
 */
export interface EmbeddedChunk extends Chunk {
  vector: number[];
}

/**
 * 检索结果，携带出处与分数，便于 rerank 与向用户/模型展示来源
 */
export interface RetrievalResult {
  content: string;
  metadata: ChunkMetadata;
  score: number;          // 融合后的相关性分数（越大越相关）
  source: 'vector' | 'keyword' | 'hybrid';  // 命中来源，便于调试与学习
}

/**
 * 文件索引状态记录，用于增量更新：文件内容 hash 未变则跳过重新索引
 */
export interface FileIndexRecord {
  filepath: string;
  contentHash: string;
  chunkIds: string[];     // 该文件产生的所有块 id，便于删除旧块
  indexedAt: string;
}

export interface RagIndexMetadata {
  embeddingProvider?: 'openai-compatible' | 'ollama';
  version: number;
  embeddingModel: string;
  embeddingBaseUrl: string;
  chunkSize: number;
  chunkOverlap: number;
  updatedAt: string;
}

/**
 * RAG 可调参数（定义在全局 types.ts，此处重导出便于 rag 模块内引用）
 */
export type { RagConfig, ChunkQualityReport } from '../../types';
export { DEFAULT_RAG_CONFIG } from '../../types';

/**
 * 查询改写结果：QueryTransform 的产物
 */
export interface TransformedQuery {
  queries: string[];       // 从选段+意图抽取生成的检索查询（关键词式）
  hydeDocument?: string;   // HyDE 假想文档（可选）
}
