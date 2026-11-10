import { LocalIndex } from 'vectra';
import * as assert from 'assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VectorStore } from '../memory/rag/vector-store';
import { chunkFile } from '../memory/rag/chunker';

suite('RAG persisted content', () => {
  test('quality statistics and keyword retrieval read external Vectra metadata after reopening', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwriter-content-'));
    try {
      const content = '月光照在青铜钥匙上，林舟终于找到了失踪的信件。';
      const chunks = chunkFile('story.md', content, { chunkSize: 800, chunkOverlap: 100 });
      const index = new LocalIndex(folder);
      await index.createIndex({ version: 1, metadata_config: { indexed: ['chapterIndex', 'filepathHash'] } });
      await index.insertItem({ vector: [1, 0], metadata: { ...chunks[0].metadata, content: chunks[0].content } });
      const reopened = new VectorStore(folder);
      const quality = await reopened.getQualityReport(800);
      assert.ok(quality.averageChunkSize > 0);
      assert.ok(quality.minChunkSize > 0);
      const hits = await reopened.queryKeyword('青铜钥匙', 3);
      assert.ok(hits.length > 0);
      assert.ok(hits[0].content.includes('青铜钥匙'));
    } finally {
      assert.strictEqual(path.dirname(folder), path.resolve(os.tmpdir()));
      assert.ok(path.basename(folder).startsWith('aiwriter-content-'));
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
});
