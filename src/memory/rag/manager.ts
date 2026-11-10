import { reviewRelevance } from './relevance';
import { readDocumentText } from '../../platform/vscode/text-content';
/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/manager.ts - RAG 门面
 * 功能：串联 chunker / embedder / vector-store / query-transform / retriever，
 *       对外暴露三个动作：buildIndex（全量）、updateFile（增量）、search（检索）。
 *
 * 设计：懒初始化。只有在配置了 apiKey 且 rag.enabled 时才创建各组件。
 * 索引存储在工作区的 .aiwriter/vector-index/ 下。
 */
import * as path from 'path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import {
  AIConfig,
  ParserModelConfig,
  RagConfig,
  RagStatusSnapshot,
  DEFAULT_RAG_CONFIG,
} from '../../types';
import { chunkFile, stableHash } from './chunker';
import { Embedder } from './embedder';
import { VectorStore } from './vector-store';
import { QueryTransformer } from './query-transform';
import { Retriever, RetrieveOptions } from './retriever';
import { EmbeddedChunk, RetrievalResult, RagIndexMetadata } from './types';

export interface BuildProgress {
  (message: string, current: number, total: number): void;
}

// 参与索引的文件类型
const INDEXABLE_GLOB = '**/*.{md,txt}';
// 排除目录
const EXCLUDE_GLOB = '**/{node_modules,.git,.aiwriter,out}/**';
const INDEX_METADATA_VERSION = 3;

export function isRagIndexMetadataCompatible(
  metadata: RagIndexMetadata | undefined,
  expected: Omit<RagIndexMetadata, 'updatedAt'>
): boolean {
  return !!metadata
    && (metadata.embeddingProvider || 'openai-compatible') === (expected.embeddingProvider || 'openai-compatible')
    && metadata.version === expected.version
    && metadata.embeddingModel === expected.embeddingModel
    && metadata.embeddingBaseUrl === expected.embeddingBaseUrl
    && metadata.chunkSize === expected.chunkSize
    && metadata.chunkOverlap === expected.chunkOverlap;
}

export class RagManager {
  private _aiConfig: AIConfig;
  private _parserConfig: ParserModelConfig;
  private _ragConfig: RagConfig;
  private _workspacePath?: string;

  private _embedder?: Embedder;
  private _store?: VectorStore;
  private _transformer?: QueryTransformer;
  private _retriever?: Retriever;
  private _benchmarkRetrievers = new Map<string, Retriever>();
  private _status: RagStatusSnapshot;
  private _onStatusChange?: (status: RagStatusSnapshot) => void;
  private _indexQueue: Promise<void> = Promise.resolve();
  private _scheduledUpdates = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  }>();

  constructor(aiConfig: AIConfig, parserConfig: ParserModelConfig, workspacePath?: string) {
    this._aiConfig = aiConfig;
    this._parserConfig = parserConfig;
    this._ragConfig = { ...DEFAULT_RAG_CONFIG, ...(aiConfig.rag || {}) };
    this._workspacePath = workspacePath;
    this._status = this._initialStatus();
  }

  updateConfig(aiConfig: AIConfig, parserConfig: ParserModelConfig): void {
    this._aiConfig = aiConfig;
    this._parserConfig = parserConfig;
    this._ragConfig = { ...DEFAULT_RAG_CONFIG, ...(aiConfig.rag || {}) };
    // 强制下次使用时重建组件
    this._embedder = undefined;
    this._store = undefined;
    this._transformer = undefined;
    this._retriever = undefined;
    this._benchmarkRetrievers.clear();
    this._setStatus(this._initialStatus());
  }

  get isReady(): boolean {
    return this._status.status === 'READY';
  }

  get status(): RagStatusSnapshot {
    return { ...this._status };
  }

  get benchmarkConfiguration(): {
    embeddingModel: string;
    chunkSize: number;
    chunkOverlap: number;
  } {
    return {
      embeddingModel: this._effectiveEmbeddingModel(),
      chunkSize: this._ragConfig.chunkSize,
      chunkOverlap: this._ragConfig.chunkOverlap,
    };
  }

  setStatusCallback(callback?: (status: RagStatusSnapshot) => void): void {
    this._onStatusChange = callback;
    callback?.(this.status);
  }

  async initialize(): Promise<void> {
    await this.refreshStatus();
  }

  async refreshStatus(): Promise<RagStatusSnapshot> {
    const initial = this._initialStatus();
    if (initial.status === 'DISABLED' || initial.status === 'NOT_CONFIGURED') {
      this._setStatus(initial);
      return this.status;
    }

    try {
      const store = this._store || new VectorStore(this._indexFolder());
      this._store = store;
      const [stats, metadata, quality] = await Promise.all([
        store.getStats(),
        store.getIndexMetadata(),
        store.getQualityReport(this._ragConfig.chunkSize),
      ]);
      if (stats.items === 0 || stats.files === 0) {
        this._setStatus({ ...initial, status: 'EMPTY', lastUpdated: metadata?.updatedAt, quality });
      } else if (!isRagIndexMetadataCompatible(metadata, this._expectedMetadata())) {
        this._setStatus({
          ...initial,
          status: 'STALE',
          files: stats.files,
          chunks: stats.items,
          lastUpdated: metadata?.updatedAt,
          quality,
        });
      } else {
        this._setStatus({
          ...initial,
          status: 'READY',
          files: stats.files,
          chunks: stats.items,
          lastUpdated: metadata?.updatedAt,
          quality,
        });
      }
    } catch (error) {
      this._setFailed(error);
    }
    return this.status;
  }

  private _indexFolder(): string {
    return path.join(this._workspacePath || '', '.aiwriter', 'vector-index');
  }

  private _effectiveEmbeddingModel(): string {
    return this._ragConfig.embeddingProvider === "ollama" ? (this._ragConfig.ollamaModel || "qwen3-embedding:0.6b") : this._ragConfig.embeddingModel;
  }

  private _effectiveEmbeddingApiKey(): string {
    if (this._ragConfig.embeddingProvider === "ollama") { return "local"; }
    return this._ragConfig.embeddingApiKey?.trim() || this._aiConfig.apiKey.trim();
  }

  private _effectiveEmbeddingBaseUrl(): string {
    if (this._ragConfig.embeddingProvider === "ollama") { return this._ragConfig.ollamaBaseUrl || "http://127.0.0.1:11434"; }
    return (this._ragConfig.embeddingBaseUrl?.trim() || this._aiConfig.baseUrl?.trim() || '').replace(/\/$/, '');
  }

  private _initialStatus(): RagStatusSnapshot {
    const common = {
      files: 0,
      chunks: 0,
      embeddingModel: this._effectiveEmbeddingModel(),
    };
    if (!this._ragConfig.enabled) {
      return { ...common, status: 'DISABLED' };
    }
    if (!this._workspacePath || !this._effectiveEmbeddingApiKey() || !this._effectiveEmbeddingBaseUrl()) {
      return { ...common, status: 'NOT_CONFIGURED' };
    }
    return { ...common, status: 'EMPTY' };
  }

  private _expectedMetadata(): Omit<RagIndexMetadata, 'updatedAt'> {
    return {
      version: INDEX_METADATA_VERSION,
      embeddingProvider: this._ragConfig.embeddingProvider || 'openai-compatible',
      embeddingModel: this._effectiveEmbeddingModel(),
      embeddingBaseUrl: this._effectiveEmbeddingBaseUrl(),
      chunkSize: this._ragConfig.chunkSize,
      chunkOverlap: this._ragConfig.chunkOverlap,
    };
  }

  private _setStatus(status: RagStatusSnapshot): void {
    this._status = status;
    this._onStatusChange?.(this.status);
  }

  private _setFailed(error: unknown): void {
    this._setStatus({
      ...this._status,
      status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** 懒初始化各组件 */
  private _ensureComponents(): void {
    const initial = this._initialStatus();
    if (initial.status === 'DISABLED') {
      throw new Error('RAG 未启用');
    }
    if (initial.status === 'NOT_CONFIGURED') {
      throw new Error('RAG 未配置：需要 Embedding API Key、Base URL 和工作区');
    }
    if (!this._embedder) {
      this._embedder = new Embedder({
        provider: this._ragConfig.embeddingProvider,
        apiKey: this._effectiveEmbeddingApiKey(),
        baseUrl: this._effectiveEmbeddingBaseUrl(),
        model: this._effectiveEmbeddingModel(),
        batchSize: this._ragConfig.embedBatchSize,
      });
    }
    if (!this._store) {
      this._store = new VectorStore(this._indexFolder());
    }
    if (!this._transformer) {
      this._transformer = new QueryTransformer(this._parserConfig);
    }
    if (!this._retriever) {
      this._retriever = new Retriever(this._embedder, this._store, this._transformer, this._ragConfig);
    }
  }

  private async _readScope(): Promise<string[] | undefined> {
    if (!this._workspacePath) { return []; }
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(this._workspacePath, '.aiwriter', 'rag-scope.json'), 'utf8'));
      if (!Array.isArray(value) || value.some(p => typeof p !== 'string')) { throw new Error('索引文件范围配置无效'); }
      return value.map(p => path.resolve(this._workspacePath!, p));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw error;
    }
  }

  async indexCandidates(): Promise<Array<{ filepath: string; label: string; picked: boolean }>> {
    if (!this._workspacePath) { throw new Error('请先打开小说文件夹'); }
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this._workspacePath, INDEXABLE_GLOB), EXCLUDE_GLOB);
    const scope = await this._readScope();
    return files.map(uri => ({ filepath: uri.fsPath, label: path.relative(this._workspacePath!, uri.fsPath),
      picked: scope === undefined || scope.includes(uri.fsPath) })).sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * 全量构建索引：扫描工作区所有可索引文件，跳过未变化的，逐个建块+向量化+入库。
   */
  async buildIndex(onProgress?: BuildProgress, selectedFiles?: string[]): Promise<{ indexed: number; skipped: number; removed: number; chunks: number }> {
    return this._enqueueIndexOperation(async () => {
      try {
        this._ensureComponents();
        this._setStatus({ ...this._status, status: 'BUILDING', error: undefined });
        await this._store!.ensureIndex();
        const existingMetadata = await this._store!.getIndexMetadata();
        const forceRebuild = !isRagIndexMetadataCompatible(existingMetadata, this._expectedMetadata());
        const pattern = new vscode.RelativePattern(this._workspacePath!, INDEXABLE_GLOB);
        const candidates = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB);
        const scope = selectedFiles ?? await this._readScope();
        if (selectedFiles) {
          const allowed = new Set(candidates.map(uri => uri.fsPath));
          if (selectedFiles.some(p => !allowed.has(p))) { throw new Error('所选文件不在当前工作区的可索引范围内'); }
          const folder = path.join(this._workspacePath!, '.aiwriter');
          await fs.mkdir(folder, { recursive: true });
          await fs.writeFile(path.join(folder, 'rag-scope.json'), JSON.stringify(selectedFiles.map(p => path.relative(this._workspacePath!, p)), null, 2), 'utf8');
        }
        const files = scope === undefined ? candidates : candidates.filter(uri => scope.includes(uri.fsPath));
        const removed = await this._store!.removeFilesNotIn(new Set(files.map(uri => uri.fsPath)));

        let indexed = 0;
        let skipped = 0;
        let totalChunks = 0;

        for (let i = 0; i < files.length; i++) {
          const uri = files[i];
          onProgress?.(`索引中: ${path.basename(uri.fsPath)}`, i + 1, files.length);
          const result = await this._indexOneFile(uri.fsPath, forceRebuild);
          if (result === 'skipped') {
            skipped++;
          } else {
            indexed++;
            totalChunks += result;
          }
        }
        const metadata: RagIndexMetadata = {
          ...this._expectedMetadata(),
          updatedAt: new Date().toISOString(),
        };
        await this._store!.saveIndexMetadata(metadata);
        const [stats, quality] = await Promise.all([
          this._store!.getStats(),
          this._store!.getQualityReport(this._ragConfig.chunkSize),
        ]);
        this._setStatus({
          status: stats.items > 0 && stats.files > 0 ? 'READY' : 'EMPTY',
          files: stats.files,
          chunks: stats.items,
          embeddingModel: this._effectiveEmbeddingModel(),
          lastUpdated: metadata.updatedAt,
          quality,
        });
        return { indexed, skipped, removed, chunks: totalChunks };
      } catch (error) {
        this._setFailed(error);
        throw error;
      }
    });
  }

  /**
   * 增量更新单个文件（保存文件时调用）。
   */
  async updateFile(filepath: string): Promise<void> {
    const scope = await this._readScope();
    if (scope !== undefined && !scope.includes(path.resolve(filepath))) { return; }
    if (!await this._canIncrementallyMutateIndex()) {
      return;
    }
    // 仅处理可索引类型
    if (!/\.(md|txt)$/i.test(filepath)) {
      return;
    }
    this._ensureComponents();
    await this._enqueueIndexOperation(async () => {
      try {
        const currentScope = await this._readScope();
        if (currentScope !== undefined && !currentScope.includes(path.resolve(filepath))) { return; }
        const result = await this._indexOneFile(filepath);
        if (result !== 'skipped') {
          const metadata: RagIndexMetadata = {
            ...this._expectedMetadata(),
            updatedAt: new Date().toISOString(),
          };
          await this._store!.saveIndexMetadata(metadata);
          const [stats, quality] = await Promise.all([
            this._store!.getStats(),
            this._store!.getQualityReport(this._ragConfig.chunkSize),
          ]);
          this._setStatus({
            status: stats.items > 0 && stats.files > 0 ? 'READY' : 'EMPTY',
            files: stats.files,
            chunks: stats.items,
            embeddingModel: this._effectiveEmbeddingModel(),
            lastUpdated: metadata.updatedAt,
            quality,
          });
        }
      } catch (error) {
        this._setFailed(error);
        throw error;
      }
    });
  }

  /** Debounce rapid saves of one file; all index mutations remain globally serial. */
  scheduleFileUpdate(filepath: string, debounceMs = 500): Promise<void> {
    if (!['READY', 'EMPTY'].includes(this._status.status) || !this._ragConfig.enabled || !/\.(md|txt)$/i.test(filepath)) {
      return Promise.resolve();
    }
    const key = path.resolve(filepath).toLowerCase();
    return new Promise((resolve, reject) => {
      const existing = this._scheduledUpdates.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.waiters.push({ resolve, reject });
        existing.timer = this._createUpdateTimer(key, filepath, debounceMs, existing.waiters);
        return;
      }
      const waiters = [{ resolve, reject }];
      const timer = this._createUpdateTimer(key, filepath, debounceMs, waiters);
      this._scheduledUpdates.set(key, { timer, waiters });
    });
  }

  async removeFile(filepath: string): Promise<void> {
    if (!/\.(md|txt)$/i.test(filepath) || !await this._canIncrementallyMutateIndex()) {
      return;
    }
    await this._enqueueIndexOperation(async () => {
      try {
        this._ensureComponents();
        if (!await this._store!.removeFile(filepath)) {
          return;
        }
        const metadata: RagIndexMetadata = {
          ...this._expectedMetadata(),
          updatedAt: new Date().toISOString(),
        };
        await this._store!.saveIndexMetadata(metadata);
        const [stats, quality] = await Promise.all([
          this._store!.getStats(),
          this._store!.getQualityReport(this._ragConfig.chunkSize),
        ]);
        this._setStatus({
          status: stats.items > 0 && stats.files > 0 ? 'READY' : 'EMPTY',
          files: stats.files,
          chunks: stats.items,
          embeddingModel: this._effectiveEmbeddingModel(),
          lastUpdated: metadata.updatedAt,
          quality,
        });
      } catch (error) {
        this._setFailed(error);
        throw error;
      }
    });
  }

  /**
   * 索引单个文件；返回块数，或 'skipped'（内容未变）。
   */
  private async _indexOneFile(filepath: string, force = false): Promise<number | 'skipped'> {
    const uri = vscode.Uri.file(filepath);
    const text = await readDocumentText(uri, true);

    const contentHash = stableHash(text);
    if (!force && await this._store!.isFileUpToDate(filepath, contentHash)) {
      return 'skipped';
    }

    const chunks = chunkFile(filepath, text, {
      chunkSize: this._ragConfig.chunkSize,
      chunkOverlap: this._ragConfig.chunkOverlap,
    });
    if (chunks.length === 0) {
      await this._store!.replaceFileChunks(filepath, stableHash(filepath), contentHash, []);
      return 0;
    }

    const vectors = await this._embedder!.embedTexts(chunks.map(createEmbeddingText));
    const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: vectors[i] }));

    const filepathHash = chunks[0].metadata.filepathHash;
    await this._store!.replaceFileChunks(filepath, filepathHash, contentHash, embedded);
    return embedded.length;
  }

  /**
   * 检索：润色/改写场景的主入口。走完整 QueryTransform → 过滤 → 混合检索 → rerank。
   */
  reviewCandidates(query: string, purpose: string, candidates: RetrievalResult[], signal?: AbortSignal) {
    return reviewRelevance(this._aiConfig, query, purpose, candidates, signal);
  }

  async search(opts: RetrieveOptions): Promise<RetrievalResult[]> {
    if (!this.isReady) {
      throw new Error(`RAG 当前状态为 ${this._status.status}，无法检索`);
    }
    this._ensureComponents();
    return this._retriever!.retrieve(this._ragConfig.embeddingProvider === "ollama"
      ? { ...opts, transformQuery: false, useHyde: false } : opts);
  }

  /**
   * 在独立、可复用的单文档索引中执行基准检索。
   * 数据不会混入用户的主 RAG 索引；缓存位于 .aiwriter/benchmark-cache/。
   */
  async benchmarkSearchDocument(
    documentId: string,
    content: string,
    query: string,
    options: {
      topK: number;
      signal?: AbortSignal;
      onIndexProgress?: (done: number, total: number) => void;
    }
  ): Promise<RetrievalResult[]> {
    this._ensureComponents();
    if (options.signal?.aborted) {
      throw new DOMException('RAG benchmark cancelled', 'AbortError');
    }
    const metadataKey = stableHash(JSON.stringify(this._expectedMetadata()));
    const cacheKey = `${metadataKey}:${documentId}`;
    let retriever = this._benchmarkRetrievers.get(cacheKey);
    if (!retriever) {
      const cacheFolder = path.join(
        this._workspacePath!,
        '.aiwriter',
        'benchmark-cache',
        'clongeval',
        metadataKey,
        documentId
      );
      const store = new VectorStore(cacheFolder);
      const virtualFilepath = path.join(cacheFolder, `${documentId}.txt`);
      const contentHash = stableHash(content);
      if (!await store.isFileUpToDate(virtualFilepath, contentHash)) {
        const chunks = chunkFile(virtualFilepath, content, {
          chunkSize: this._ragConfig.chunkSize,
          chunkOverlap: this._ragConfig.chunkOverlap,
        });
        const vectors = await this._embedder!.embedTexts(
          chunks.map(createEmbeddingText),
          options.onIndexProgress,
          options.signal
        );
        const embedded: EmbeddedChunk[] = chunks.map((chunk, index) => ({
          ...chunk,
          vector: vectors[index],
        }));
        await store.replaceFileChunks(virtualFilepath, stableHash(virtualFilepath), contentHash, embedded);
        await store.saveIndexMetadata({
          ...this._expectedMetadata(),
          updatedAt: new Date().toISOString(),
        });
      }
      retriever = new Retriever(this._embedder!, store, this._transformer!, this._ragConfig);
      this._benchmarkRetrievers.set(cacheKey, retriever);
    }
    return retriever.retrieve({
      selection: query,
      intent: '',
      useHyde: false,
      transformQuery: false,
      topK: options.topK,
      signal: options.signal,
    });
  }

  async getStats(): Promise<{ items: number; files: number }> {
    if (!this._workspacePath) {
      return { items: 0, files: 0 };
    }
    const store = this._store || new VectorStore(this._indexFolder());
    this._store = store;
    return store.getStats();
  }

  private _createUpdateTimer(
    key: string,
    filepath: string,
    debounceMs: number,
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
  ): ReturnType<typeof setTimeout> {
    return setTimeout(async () => {
      this._scheduledUpdates.delete(key);
      try {
        await this.updateFile(filepath);
        waiters.forEach(waiter => waiter.resolve());
      } catch (error) {
        waiters.forEach(waiter => waiter.reject(error));
      }
    }, Math.max(0, debounceMs));
  }

  private _enqueueIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._indexQueue.then(operation, operation);
    this._indexQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async _canIncrementallyMutateIndex(): Promise<boolean> {
    if (this._status.status === 'READY') {
      return true;
    }
    if (this._status.status !== 'EMPTY' || this._initialStatus().status === 'NOT_CONFIGURED') {
      return false;
    }
    const store = this._store || new VectorStore(this._indexFolder());
    this._store = store;
    return isRagIndexMetadataCompatible(await store.getIndexMetadata(), this._expectedMetadata());
  }
}

export function createEmbeddingText(chunk: { content: string; metadata: { headingPath?: string; title?: string } }): string {
  const heading = chunk.metadata.headingPath || chunk.metadata.title || '';
  return heading ? `章节：${heading}\n\n${chunk.content}` : chunk.content;
}
