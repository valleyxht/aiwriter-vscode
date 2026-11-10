export interface RagConfig {
  enabled: boolean;
  embeddingProvider?: 'openai-compatible' | 'ollama';
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  vectorCandidates: number;
  embedBatchSize: number;
}

export const DEFAULT_RAG_CONFIG: RagConfig = {
  enabled: false,
  embeddingProvider: 'openai-compatible',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3-embedding:0.6b',
  embeddingApiKey: '',
  embeddingBaseUrl: '',
  embeddingModel: 'text-embedding-3-small',
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 6,
  vectorCandidates: 20,
  embedBatchSize: 10,
};

export type RagStatus =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'EMPTY'
  | 'BUILDING'
  | 'READY'
  | 'STALE'
  | 'FAILED';

export interface ChunkQualityReport {
  totalChunks: number;
  totalCharacters: number;
  averageChunkSize: number;
  minChunkSize: number;
  maxChunkSize: number;
  chunkSizeStdDev: number;
  smallChunkCount: number;
  oversizedChunkCount: number;
  garbledChunkCount: number;
  warnings: string[];
}

export interface RagStatusSnapshot {
  status: RagStatus;
  files: number;
  chunks: number;
  embeddingModel: string;
  lastUpdated?: string;
  error?: string;
  quality?: ChunkQualityReport;
}
