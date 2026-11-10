import * as assert from 'assert';
import {
  classifyModelError,
  cleanBaseUrl,
  createEmbeddingModel,
  executeWithRetry,
} from '../ai/models';

suite('Model governance policy', () => {
  test('normalizes compatible API base URLs', () => {
    assert.strictEqual(
      cleanBaseUrl(' "https://example.com/v1/chat/completions" '),
      'https://example.com/v1'
    );
    assert.strictEqual(cleanBaseUrl('example.com/v1/'), 'https://example.com/v1');
    assert.strictEqual(
      cleanBaseUrl('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings'),
      'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    );
  });

  test('classifies retryable and terminal failures', () => {
    assert.strictEqual(classifyModelError({ status: 503 }).retryable, true);
    assert.strictEqual(classifyModelError({ statusCode: 429 }).retryable, true);
    assert.strictEqual(classifyModelError({ statusCode: 401 }).retryable, false);
    assert.strictEqual(classifyModelError({ statusCode: 200, cause: new Error('connection reset') }).retryable, true);
    assert.strictEqual(classifyModelError({ statusCode: 200, cause: new Error('invalid response schema') }).retryable, false);
    assert.strictEqual(classifyModelError({ status: 429, error: { code: 'insufficient_quota' } }).retryable, false);
    assert.strictEqual(classifyModelError({ status: 400 }).retryable, false);
    assert.strictEqual(classifyModelError({ code: 'ECONNRESET' }).retryable, true);
    assert.strictEqual(classifyModelError(Object.assign(new Error('cancelled'), { name: 'AbortError' })).retryable, false);
  });

  test('retries recoverable calls only within the explicit limit', async () => {
    let attempts = 0;
    const result = await executeWithRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error('temporary'), { status: 503 });
      }
      return 'ok';
    }, {
      operation: 'test.retry',
      maxRetries: 2,
      baseDelayMs: 0,
      random: () => 0.5,
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);

    attempts = 0;
    await assert.rejects(() => executeWithRetry(async () => {
      attempts++;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, { operation: 'test.no_retry', maxRetries: 2, baseDelayMs: 0 }));
    assert.strictEqual(attempts, 1);
  });

  test('does not retry failed embedding calls inside the SDK', async () => {
    let calls = 0;
    const embeddings = createEmbeddingModel({ apiKey: 'test', baseUrl: 'https://embeddings.example/v1', model: 'custom',
      fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } }); } });
    await assert.rejects(embeddings.embedQuery('测试'));
    assert.strictEqual(calls, 1);
  });
});
