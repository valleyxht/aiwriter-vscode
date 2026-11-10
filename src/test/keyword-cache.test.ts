import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { KeywordIndex, rankKeywordDocuments } from '../memory/rag/keyword-search';
import { VectorStore } from '../memory/rag/vector-store';
import { chunkFile } from '../memory/rag/chunker';

suite('BM25 reusable index', () => {
  test('filtered statistics and stable ties match independent corpus ranking', () => {
    const documents = [
      { value: 0, text: '青铜钥匙 雨夜 林舟' },
      { value: 1, text: '青铜钥匙 雨夜 林舟' },
      { value: 2, text: '林舟'.repeat(100) },
      { value: 3, text: '' },
    ];
    const index = new KeywordIndex(documents);
    for (const query of ['青铜钥匙 林舟', '不存在', '', 'rain 林舟']) {
      assert.deepEqual(index.search(query, 10, value => value !== 2),
        rankKeywordDocuments(query, documents.filter(document => document.value !== 2), 10));
    }
    assert.deepEqual(index.search('青铜钥匙', 2).map(hit => hit.value), [0, 1]);
    assert.deepEqual(index.search('林舟', 0), []);
    assert.deepEqual(new KeywordIndex([]).search('林舟', 3), []);
  });

  test('queries reuse prepared text without touching the original document again', () => {
    let reads = 0;
    const index = new KeywordIndex([{ value: 1, get text() { reads++; return '青铜钥匙'; } }]);
    for (let i = 0; i < 10; i++) { assert.equal(index.search('青铜钥匙', 1).length, 1); }
    assert.equal(reads, 1);
  });
});

suite('Vector store keyword cache lifecycle', () => {
  let folder: string;
  let store: VectorStore;
  let loads: number;
  const replace = async (file: string, text: string) => {
    const chunks = chunkFile(file, text, { chunkSize: 800, chunkOverlap: 100 })
      .map(chunk => ({ ...chunk, vector: [1, 0] }));
    await store.replaceFileChunks(file, '', text, chunks);
  };
  setup(async () => {
    folder = await fs.mkdtemp(path.join(process.cwd(), 'out', 'keyword-test-'));
    store = new VectorStore(folder);
    // Record persistence uses VS Code; exercise the real Vectra index with in-memory records here.
    (store as any)._recordsLoaded = true;
    (store as any)._saveRecords = async () => undefined;
    const hydrate = (store as any)._itemsWithContent.bind(store);
    loads = 0;
    (store as any)._itemsWithContent = async () => { loads++; return hydrate(); };
  });
  teardown(async () => { await fs.rm(folder, { recursive: true, force: true }); });

  test('concurrent queries share hydration and replacement invalidates it', async () => {
    await replace('a.md', '青铜钥匙');
    const hits = await Promise.all([store.queryKeyword('青铜钥匙', 3), store.queryKeyword('青铜钥匙', 3)]);
    assert.equal(loads, 1);
    assert.deepEqual(hits[0], hits[1]);
    assert.equal(hits[0].length, 1);
    await replace('a.md', '白银宝剑');
    assert.equal((await store.queryKeyword('青铜钥匙', 3)).length, 0);
    assert.equal((await store.queryKeyword('白银宝剑', 3)).length, 1);
    assert.equal(loads, 2);
  });

  test('file and chapter filters stay isolated; both deletion paths invalidate', async () => {
    await replace('a.md', '第一章\n青铜钥匙\n第二章\n白银宝剑');
    await replace('b.md', '青铜钥匙');
    assert.equal((await store.queryKeyword('青铜钥匙', 10, undefined, 'b.md')).length, 1);
    assert.equal((await store.queryKeyword('白银宝剑', 10, 0, 'a.md')).length, 0);
    assert.equal((await store.queryKeyword('白银宝剑', 10)).length, 1);
    assert.equal(loads, 1);
    await store.removeFile('b.md');
    assert.equal((await store.queryKeyword('青铜钥匙', 10, undefined, 'b.md')).length, 0);
    await store.removeFilesNotIn(new Set());
    assert.equal((await store.queryKeyword('白银宝剑', 10)).length, 0);
    assert.equal(loads, 3);
  });

  test('failed hydration is retried instead of caching a rejected promise', async () => {
    await replace('a.md', '青铜钥匙');
    const hydrate = (store as any)._itemsWithContent;
    (store as any)._itemsWithContent = async () => { throw new Error('暂时不可读'); };
    await assert.rejects(store.queryKeyword('青铜钥匙', 1), /暂时不可读/);
    (store as any)._itemsWithContent = hydrate;
    assert.equal((await store.queryKeyword('青铜钥匙', 1)).length, 1);
  });
});
