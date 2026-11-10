import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { executeChatModelCall } from '../ai/models/model-policy';

suite('Agent delivery reliability', () => {
  for (const status of [401, 403, 400, 429]) {
    test(`does not repair terminal model errors (${status}) with another prompt`, async () => {
      let calls = 0;
      const failure = Object.assign(new Error('terminal test failure'), {
        status, code: status === 429 ? 'insufficient_quota' : undefined,
      });
      await assert.rejects(executeChatModelCall(async () => { calls++; throw failure; }, { operation: 'test.reliability' }), error => error === failure);
      assert.strictEqual(calls, 1);
    });
  }

  test('updates token UI without referencing an unavailable price', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/webview/html/main.js'), 'utf8');
    const start = source.indexOf('function updateTokenStats(stats)');
    assert.ok(start >= 0);
    const end = source.indexOf('function handleSend()', start);
    const elements = new Map<string, any>();
    for (const id of ['token-bar', 'token-count', 'token-usage']) {
      elements.set(id, { textContent: '', classList: { remove() {}, add() {} } });
    }
    runInNewContext(source.slice(start, end) + ';updateTokenStats({inputTokens:1,outputTokens:2,totalTokens:3});', {
      document: { getElementById: (id: string) => elements.get(id) }, console: { log() {}, warn() {} },
    });
    assert.strictEqual(elements.get('token-count').textContent, '1+2=3 tokens');
  });
});
