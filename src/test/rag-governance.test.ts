import * as assert from 'assert';
import { RagManager } from '../memory/rag';
import { isRagIndexMetadataCompatible } from '../memory/rag/manager';
import { DEFAULT_AI_CONFIG, DEFAULT_PARSER_CONFIG } from '../types';

suite('RAG update governance', () => {
  test('does not embed excluded files, including a scope change while queued', async () => {
    const manager = new RagManager(DEFAULT_AI_CONFIG, DEFAULT_PARSER_CONFIG, 'D:\\workspace');
    const target = manager as any;
    let scope = ['D:\\workspace\\chosen.md'];
    let writes = 0;
    target._readScope = async () => scope;
    target._canIncrementallyMutateIndex = async () => true;
    target._ensureComponents = () => undefined;
    target._indexOneFile = async () => { writes++; return 'skipped'; };
    await manager.updateFile('D:\\workspace\\excluded.md');
    assert.strictEqual(writes, 0);
    await manager.updateFile('D:\\workspace\\chosen.md');
    assert.strictEqual(writes, 1);
    target._enqueueIndexOperation = async (operation: () => Promise<void>) => {
      scope = [];
      await operation();
    };
    await manager.updateFile('D:\\workspace\\chosen.md');
    assert.strictEqual(writes, 1);
  });

  test('debounces the same file and serializes index mutations', async () => {
    const manager = new RagManager(
      {
        ...DEFAULT_AI_CONFIG,
        apiKey: 'test',
        rag: { ...DEFAULT_AI_CONFIG.rag!, enabled: true },
      },
      { ...DEFAULT_PARSER_CONFIG, enabled: false, apiKey: '' },
      'D:\\workspace'
    );
    const target = manager as any;
    target._status = {
      status: 'READY', files: 1, chunks: 1, embeddingModel: 'text-embedding-3-small'
    };
    target._store = {
      saveIndexMetadata: async () => undefined,
      getStats: async () => ({ items: 3, files: 3 }),
      getQualityReport: async () => ({ totalChunks: 3, warnings: [] }),
    };
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    target._ensureComponents = () => undefined;
    target._indexOneFile = async (filepath: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(filepath);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return 1;
    };

    await Promise.all([
      manager.scheduleFileUpdate('D:\\workspace\\one.md', 5),
      manager.scheduleFileUpdate('D:\\workspace\\one.md', 5),
      manager.scheduleFileUpdate('D:\\workspace\\one.md', 5),
    ]);
    assert.strictEqual(calls.length, 1);

    await Promise.all([
      manager.scheduleFileUpdate('D:\\workspace\\two.md', 0),
      manager.scheduleFileUpdate('D:\\workspace\\three.md', 0),
    ]);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(maxActive, 1);
  });

  test('tracks disabled and configured-but-empty states independently', () => {
    const disabled = new RagManager(
      { ...DEFAULT_AI_CONFIG, apiKey: 'main-key' },
      DEFAULT_PARSER_CONFIG,
      'D:\\workspace'
    );
    assert.strictEqual(disabled.status.status, 'DISABLED');

    const configured = new RagManager(
      {
        ...DEFAULT_AI_CONFIG,
        apiKey: '',
        rag: {
          ...DEFAULT_AI_CONFIG.rag!,
          enabled: true,
          embeddingApiKey: 'embedding-key',
          embeddingBaseUrl: 'https://embeddings.example/v1',
        },
      },
      DEFAULT_PARSER_CONFIG,
      'D:\\workspace'
    );
    assert.strictEqual(configured.status.status, 'EMPTY');
    assert.strictEqual(configured.isReady, false);
  });

  test('invalidates index metadata when embedding or chunk configuration changes', () => {
    const expected = {
      version: 2,
      embeddingModel: 'embedding-v2',
      embeddingBaseUrl: 'https://example.test/v1',
      chunkSize: 800,
      chunkOverlap: 100,
    };
    assert.strictEqual(isRagIndexMetadataCompatible({ ...expected, updatedAt: 'now' }, expected), true);
    assert.strictEqual(isRagIndexMetadataCompatible({ ...expected, embeddingModel: 'embedding-v1', updatedAt: 'now' }, expected), false);
    assert.strictEqual(isRagIndexMetadataCompatible(undefined, expected), false);
  });

  test('allows an already-built empty index to resume incremental updates', async () => {
    const manager = new RagManager(
      {
        ...DEFAULT_AI_CONFIG,
        apiKey: 'main-key',
        rag: { ...DEFAULT_AI_CONFIG.rag!, enabled: true },
      },
      DEFAULT_PARSER_CONFIG,
      'D:\\workspace'
    );
    const target = manager as any;
    target._status = { status: 'EMPTY', files: 1, chunks: 0, embeddingModel: 'text-embedding-3-small' };
    target._store = {
      getIndexMetadata: async () => ({ ...target._expectedMetadata(), updatedAt: 'now' }),
    };
    assert.strictEqual(await target._canIncrementallyMutateIndex(), true);
  });
});
