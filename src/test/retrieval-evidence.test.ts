import * as assert from 'assert';
import { EvidenceLedger } from '../ai/tools/retrieval-evidence';
import { validateRelevance } from '../memory/rag/relevance';
import { createRagTools, createReadOnlyFileTools } from '../ai/tools/tools';
import { stableHash } from '../memory/rag/chunker';

suite('Purpose-driven retrieval', () => {
  const piece = { filepath: '/story.txt', version: 'v1', start: 0, end: 6, content: 'abcdef' };

  test('deduplicates by file version and range, returning only new context', () => {
    const ledger = new EvidenceLedger();
    assert.match(ledger.deliver([piece]), /E1/);
    assert.match(ledger.deliver([{ ...piece, chunkId: 'different-id' }]), /此前证据已覆盖/);
    const next = ledger.deliver([{ ...piece, start: 3, end: 9, content: 'defghi' }]);
    assert.ok(next.endsWith('ghi'));
    assert.strictEqual(ledger.added, 2);
    assert.ok(ledger.deliver([{ ...piece, version: 'v2' }]).includes('abcdef'));
    assert.ok(new EvidenceLedger().deliver([piece]).includes('abcdef'));
  });

  test('only marks emitted text as read when a reading budget is reached', () => {
    const ledger = new EvidenceLedger();
    ledger.deliver([piece], 3);
    assert.strictEqual(ledger.records[0].end, 3);
    assert.ok(ledger.deliver([piece]).endsWith('def'));
  });

  test('only inherits the actual body prefix and allows reading its omitted suffix', () => {
    const preparation = new EvidenceLedger([], 'P-test-E');
    const output = preparation.deliver([piece]);
    const partial = output.slice(0, output.indexOf('abcdef') + 3);
    const writer = new EvidenceLedger();
    writer.importVisible(preparation.records, partial);
    assert.strictEqual(writer.records[0].end, 3);
    assert.strictEqual(writer.records[0].content, 'abc');
    assert.ok(writer.deliver([piece]).includes('def'));
    assert.match(writer.deliver([piece]), /此前证据已覆盖/);
    assert.strictEqual(new EvidenceLedger(preparation.records).visibleIn('工具参数引用 P-test-E1').length, 0);
  });

  test('input trimming releases coverage without reusing old evidence IDs', () => {
    const ledger = new EvidenceLedger();
    const output = ledger.deliver([piece]);
    ledger.retainVisible(output.slice(0, output.indexOf('abcdef') + 2));
    assert.strictEqual(ledger.records[0].end, 2);
    ledger.retainVisible('all source bodies removed');
    assert.strictEqual(ledger.records.length, 0);
    assert.match(ledger.deliver([piece]), /E2/);
  });

  test('requires grounded relevance decisions and accepts no relevant candidates', () => {
    const candidates = [{ content: '这里记载了原文证据' }] as any;
    assert.strictEqual(validateRelevance([{ index: 0, relevance: 2, quote: '原文证据' }], candidates).length, 1);
    assert.strictEqual(validateRelevance([{ index: 0, relevance: 2, quote: '不存在的证据' }], candidates).length, 0);
    assert.strictEqual(validateRelevance([{ index: 0, relevance: 0, quote: '' }], candidates).length, 0);
    assert.throws(() => validateRelevance([], candidates), /Incomplete/);
  });

  test('does not review or refill duplicates on later RAG calls', async () => {
    let reviewedCount = -1;
    const candidate = { content: piece.content, metadata: { filepath: piece.filepath, charStart: 0,
      contentVersion: piece.version, chunkId: 'chunk' } };
    const tool = createRagTools({ isReady: true, search: async () => [candidate],
      reviewCandidates: async (_q: string, _p: string, candidates: any[]) => {
        reviewedCount = candidates.length;
        return { results: candidates, verified: true };
      } } as any)[0];
    const evidence = new EvidenceLedger();
    await tool.func({ query: 'test', purpose: 'find evidence' }, undefined, { evidence });
    const result = await tool.func({ query: 'another wording', purpose: 'check missing facts', basedOnEvidenceIds: ['E1'] }, undefined, { evidence });
    assert.strictEqual(reviewedCount, 0);
    assert.match(result.content, /无新增有效证据/);
    assert.ok(!result.content.includes('abcdef'));
  });

  test('keyword hits and direct reads share coordinates without a separate expansion tool', async () => {
    const text = '前文目标后文';
    const version = stableHash(text);
    const tools = createReadOnlyFileTools({
      searchInFiles: async () => ({ success: true, message: '', matches: [
        { filepath: '/story.txt', text: '目标', charStart: 2, charEnd: 4, version, line: 1, column: 3 },
      ] }),
      readFile: async () => ({ success: true, message: '', content: text, filepath: '/story.txt', version }),
    } as any);
    const evidence = new EvidenceLedger();
    const context = { evidence };
    const search = tools.find(t => t.name === 'searchInFiles')!;
    assert.match((await search.func({ baseDirectory: '/', searchText: '目标' }, undefined, context)).content, /E1/);
    assert.ok(!tools.some(t => t.name === 'readEvidence'));
    const direct = tools.find(t => t.name === 'readFile')!;
    const output = await direct.func({ filepath: '/story.txt' }, undefined, context);
    assert.ok(output.content.includes('前文') && output.content.includes('后文'));
    assert.ok(!output.content.includes('目标'));
    assert.match((await direct.func({ filepath: '/story.txt' }, undefined, context)).content, /此前证据已覆盖/);
  });
});
