import * as assert from 'assert';
import { boundedFileExcerpt } from '../ai/tools/file-excerpt';
import { RequestTelemetry } from '../ai/runtime/request-telemetry';

suite('Bounded model file reads', () => {
  test('caps defaults, excessive requests and invalid limits', () => {
    const text = '文'.repeat(180000);
    for (const limit of [undefined, -1, NaN, Infinity]) {
      const result = boundedFileExcerpt(text, 0, limit);
      assert.strictEqual(result.split('\n')[1].length, 6000);
    }
    assert.strictEqual(boundedFileExcerpt(text, 0, 180000).split('\n')[1].length, 30000);
    assert.ok(boundedFileExcerpt(text, 0, 1).includes('offset=1'));
  });
  test('reads later pages and handles EOF without returning the whole file', () => {
    assert.ok(boundedFileExcerpt('abcdef', 3, 2).endsWith('\nde'));
    assert.ok(boundedFileExcerpt('abcdef', 6, 2).includes('超出'));
  });
  test('does not mark complete chat usage unknown because embeddings have no usage', async () => {
    const ledger = new RequestTelemetry('test');
    await ledger.finish(ledger.begin('chat', 'chat', '1'), { usage_metadata: { input_tokens: 20, output_tokens: 2 } });
    await ledger.finish(ledger.begin('embed', 'embedding', '2'), [[1, 0]]);
    assert.strictEqual(ledger.snapshot().usageComplete, true);
    assert.strictEqual(ledger.snapshot().unknownEmbeddingAttempts, 1);
    assert.strictEqual(ledger.snapshot().totalTokens, 22);
  });
});
