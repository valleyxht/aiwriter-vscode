/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/index.ts - RAG 模块导出
 */
export { RagManager } from './manager';
export type { BuildProgress } from './manager';
export { Retriever } from './retriever';
export type { RetrieveOptions } from './retriever';
export { VectorStore } from './vector-store';
export { Embedder } from './embedder';
export { QueryTransformer } from './query-transform';
export { chunkFile, stableHash } from './chunker';
export { evaluateRagRetrieval } from './evaluation';
export type { RagEvaluationCase, RagEvaluationSummary } from './evaluation';
export { parseNovelQaEvaluationCases, sampleNovelQaCases } from './novelqa';
export {
  analyzeCLongEvalChunking,
  evaluateCLongEvalRetrieval,
  parseCLongEvalJsonl,
  renderCLongEvalMarkdown,
  sampleCLongEvalCases,
} from './clongeval';
export type {
  CLongEvalBenchmarkReport,
  CLongEvalCase,
  CLongEvalDataset,
  CLongEvalDocument,
} from './clongeval';
export * from './types';
