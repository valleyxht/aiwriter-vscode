import { stableHash } from './chunker';
/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/vector-store.ts - 本地向量索引封装
 *
 * 【RAG 技术点：向量索引 + 增量更新】
 * - 用 vectra（纯 JS 本地向量库）把向量与元数据持久化到 .aiwriter/vector-index/，
 *   无需外部服务，符合插件分发场景。
 * - queryItems 原生支持 metadata filter（$lte 等），我们用它做"章节上界过滤"防剧透。
 * - 增量更新：以 filepathHash 为分组，重建某文件索引时先删该文件旧块再插新块，
 *   避免百万字每次全量重算。文件索引状态记录在 file-records.json。
 */
import * as path from 'path';
import { promises as fs } from 'node:fs';
import { LocalIndex } from 'vectra';
import { EmbeddedChunk, ChunkMetadata, FileIndexRecord, RagIndexMetadata, ChunkQualityReport } from './types';
import { KeywordIndex } from './keyword-search';
import { analyzeChunkQuality } from './quality';

// vectra 中每个 item 的 metadata 结构（值必须是 number|string|boolean）
interface StoredMetadata {
  chunkId: string;
  filepath: string;
  filepathHash: string;
  chapterIndex: number;
  title: string;
  headingPath: string;
  charStart: number;
  charEnd: number;
  seq: number;
  content: string;   // 原文直接存进 metadata，检索时无需再回读文件
  [key: string]: string | number | boolean;
}

export interface VectorQueryHit {
  metadata: ChunkMetadata;
  content: string;
  score: number;
}

export class VectorStore {
  private _index: LocalIndex;
  private _fileRecords: Map<string, FileIndexRecord> = new Map();
  private _recordsLoaded = false;
  private readonly _folderPath: string;
  private _keywordIndex?: Promise<KeywordIndex<StoredMetadata>>;

  constructor(indexFolder: string) {
    this._folderPath = indexFolder;
    this._index = new LocalIndex(indexFolder);
  }

  /**
   * 确保索引已创建（首次使用时建目录）。
   */
  async ensureIndex(): Promise<void> {
    if (!(await this._index.isIndexCreated())) {
      this._keywordIndex = undefined;
      await this._index.createIndex({
        version: 1,
        metadata_config: {
          // 让 chapterIndex 参与索引，使章节过滤高效
          indexed: ['chapterIndex', 'filepathHash', 'filepath'],
        },
      });
    }
  }

  /**
   * 用一个文件的新块替换其旧块（增量更新的核心）。
   * @returns 该文件的索引记录
   */
  async replaceFileChunks(
    filepath: string,
    _filepathHash: string,
    contentHash: string,
    chunks: EmbeddedChunk[]
  ): Promise<FileIndexRecord> {
    await this.ensureIndex();
    await this._loadRecords();

    await this._index.beginUpdate();
    try {
      // 删除该文件的旧块
      const oldKey = Array.from(this._fileRecords.keys())
        .find(existing => normalizeFilepath(existing) === normalizeFilepath(filepath));
      const old = oldKey ? this._fileRecords.get(oldKey) : undefined;
      if (old) {
        for (const id of old.chunkIds) {
          await this._index.deleteItem(id);
        }
      }

      // 插入新块
      const chunkIds: string[] = [];
      for (const chunk of chunks) {
        const metadata: StoredMetadata = {
          ...chunk.metadata,
          content: chunk.content,
          contentVersion: contentHash,
        };
        await this._index.upsertItem({
          id: chunk.metadata.chunkId,
          vector: chunk.vector,
          metadata: metadata as any,
        });
        chunkIds.push(chunk.metadata.chunkId);
      }

      await this._index.endUpdate();

      this._keywordIndex = undefined;

      const record: FileIndexRecord = {
        filepath,
        contentHash,
        chunkIds,
        indexedAt: new Date().toISOString(),
      };
      if (oldKey && oldKey !== filepath) {
        this._fileRecords.delete(oldKey);
      }
      this._fileRecords.set(filepath, record);
      await this._saveRecords();
      return record;
    } catch (error) {
      this._index.cancelUpdate();
      throw error;
    }
  }

  /**
   * 判断文件内容是否已索引且未变化，用于跳过未改动文件。
   */
  async isFileUpToDate(filepath: string, contentHash: string): Promise<boolean> {
    await this._loadRecords();
    const key = Array.from(this._fileRecords.keys())
      .find(existing => normalizeFilepath(existing) === normalizeFilepath(filepath));
    const record = key ? this._fileRecords.get(key) : undefined;
    return !!record && record.contentHash === contentHash;
  }

  /**
   * 纯向量检索。关键词召回由 queryKeyword 独立完成，再在 Retriever 中做 RRF。
   * @param vector 查询向量
   * @param queryText 保留给 Vectra API；当前不启用其 LocalDocumentIndex 专用 BM25 分支
   * @param topK 返回数量
   * @param beforeChapter 若提供，只检索 chapterIndex <= beforeChapter 的块（防剧透）
   */
  async queryVector(
    vector: number[],
    queryText: string,
    topK: number,
    beforeChapter?: number,
    filepath?: string
  ): Promise<VectorQueryHit[]> {
    await this.ensureIndex();

    let filter: any = undefined;
    if (typeof beforeChapter === 'number' && beforeChapter >= 0) {
      // chapterIndex 为 -1 的块（无法识别章节）也允许命中
      filter = { $or: [{ chapterIndex: { $lte: beforeChapter } }, { chapterIndex: { $eq: -1 } }] };
    }

    if (filepath) { filter = filter ? { $and: [filter, { filepathHash: { $eq: stableHash(filepath) } }] } : { filepathHash: { $eq: stableHash(filepath) } }; }
    const results = await this._index.queryItems(vector, queryText, topK, filter);
    return results.map((r) => {
      const m = r.item.metadata as unknown as StoredMetadata;
      const { content, ...meta } = m;
      return {
        metadata: meta as unknown as ChunkMetadata,
        content,
        score: r.score,
      };
    });
  }

  async queryKeyword(queryText: string, topK: number, beforeChapter?: number, filepath?: string): Promise<VectorQueryHit[]> {
    await this.ensureIndex();
    if (!this._keywordIndex) {
      const pending = this._itemsWithContent().then(items => new KeywordIndex(items.map(item => ({
        value: item.metadata,
        text: [item.metadata.headingPath, item.metadata.title, item.metadata.content].filter(Boolean).join('\n'),
      }))));
      this._keywordIndex = pending;
      // A failed hydration must be retryable; an older failure must not clear a newer snapshot.
      void pending.catch(() => { if (this._keywordIndex === pending) { this._keywordIndex = undefined; } });
    }
    const index = await this._keywordIndex;
    const eligible = (metadata: StoredMetadata) => {
      if (filepath && metadata.filepath !== filepath) { return false; }
      const chapter = Number(metadata.chapterIndex);
      return typeof beforeChapter !== 'number' || beforeChapter < 0 || chapter === -1 || chapter <= beforeChapter;
    };
    const filtered = !!filepath || (typeof beforeChapter === 'number' && beforeChapter >= 0);
    return index.search(queryText, topK, filtered ? eligible : undefined).map(hit => {
      const { content, ...metadata } = hit.value;
      return {
        metadata: metadata as unknown as ChunkMetadata,
        content,
        score: hit.score,
      };
    });
  }

  async removeFile(filepath: string): Promise<boolean> {
    await this._loadRecords();
    const recordKey = Array.from(this._fileRecords.keys())
      .find(existing => normalizeFilepath(existing) === normalizeFilepath(filepath));
    const record = recordKey ? this._fileRecords.get(recordKey) : undefined;
    if (!record) {
      return false;
    }
    await this.ensureIndex();
    await this._index.beginUpdate();
    try {
      for (const id of record.chunkIds) {
        await this._index.deleteItem(id);
      }
      await this._index.endUpdate();
      this._keywordIndex = undefined;
      this._fileRecords.delete(recordKey!);
      await this._saveRecords();
      return true;
    } catch (error) {
      this._index.cancelUpdate();
      throw error;
    }
  }

  async removeFilesNotIn(activeFilepaths: Set<string>): Promise<number> {
    await this._loadRecords();
    const active = new Set(Array.from(activeFilepaths, filepath => normalizeFilepath(filepath)));
    const stale = Array.from(this._fileRecords.entries())
      .filter(([filepath]) => !active.has(normalizeFilepath(filepath)));
    if (stale.length === 0) {
      return 0;
    }
    await this.ensureIndex();
    await this._index.beginUpdate();
    try {
      for (const [, record] of stale) {
        for (const id of record.chunkIds) {
          await this._index.deleteItem(id);
        }
      }
      await this._index.endUpdate();
      this._keywordIndex = undefined;
      for (const [filepath] of stale) {
        this._fileRecords.delete(filepath);
      }
      await this._saveRecords();
      return stale.length;
    } catch (error) {
      this._index.cancelUpdate();
      throw error;
    }
  }

  private async _itemsWithContent() {
    const items = await this._index.listItems<StoredMetadata>();
    const hydrated = [];
    for (const item of items) {
      if (!item.metadataFile) { hydrated.push(item); continue; }
      const filename = path.resolve(this._folderPath, item.metadataFile);
      const relative = path.relative(path.resolve(this._folderPath), filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('索引正文路径无效'); }
      const metadata = JSON.parse(await fs.readFile(filename, 'utf8')) as StoredMetadata;
      hydrated.push({ ...item, metadata });
    }
    return hydrated;
  }

  async getQualityReport(targetChunkSize: number): Promise<ChunkQualityReport> {
    if (!(await this._index.isIndexCreated())) {
      return analyzeChunkQuality([], targetChunkSize);
    }
    const items = await this._itemsWithContent();
    return analyzeChunkQuality(items.map(item => String(item.metadata.content || '')), targetChunkSize);
  }

  async getStats(): Promise<{ items: number; files: number }> {
    await this._loadRecords();
    let items = 0;
    if (await this._index.isIndexCreated()) {
      const stats = await this._index.getIndexStats();
      items = stats.items;
    }
    return { items, files: this._fileRecords.size };
  }

  async getIndexMetadata(): Promise<RagIndexMetadata | undefined> {
    try {
      const vscode = require('vscode');
      const uri = vscode.Uri.file(this._metadataPath());
      const buf = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(new TextDecoder('utf-8').decode(buf)) as RagIndexMetadata;
    } catch {
      return undefined;
    }
  }

  async saveIndexMetadata(metadata: RagIndexMetadata): Promise<void> {
    const vscode = require('vscode');
    const uri = vscode.Uri.file(this._metadataPath());
    const data = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    await vscode.workspace.fs.writeFile(uri, data);
  }

  // ---- file-records.json 读写（增量状态）----

  private _recordsPath(): string {
    return path.join(this._folderPath, 'file-records.json');
  }

  private _metadataPath(): string {
    return path.join(this._folderPath, 'index-metadata.json');
  }

  private async _loadRecords(): Promise<void> {
    if (this._recordsLoaded) {
      return;
    }
    try {
      const vscode = require('vscode');
      const uri = vscode.Uri.file(this._recordsPath());
      const buf = await vscode.workspace.fs.readFile(uri);
      const arr = JSON.parse(new TextDecoder('utf-8').decode(buf)) as FileIndexRecord[];
      this._fileRecords = new Map(arr.map((r) => [r.filepath, r]));
    } catch {
      this._fileRecords = new Map();
    }
    this._recordsLoaded = true;
  }

  private async _saveRecords(): Promise<void> {
    const vscode = require('vscode');
    const uri = vscode.Uri.file(this._recordsPath());
    const arr = Array.from(this._fileRecords.values());
    const data = new TextEncoder().encode(JSON.stringify(arr, null, 2));
    await vscode.workspace.fs.writeFile(uri, data);
  }
}

function normalizeFilepath(filepath: string): string {
  return path.resolve(filepath).toLowerCase();
}
