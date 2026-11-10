import * as assert from 'assert';
import { createChatModel } from '../ai/models/model-policy';
import { getCurrentRunTree } from 'langsmith/traceable';
import { configureLangSmith, disableLangSmith, getLangSmithClient, isLangSmithEnabled, traceWritingRequest } from '../ai/models/langsmith';

suite('LangSmith configuration', () => {
  teardown(() => disableLangSmith());

  test('records full request inputs and outputs with a shared parent without network', async () => {
    configureLangSmith({ enabled: true, apiKey: 'test-only', project: 'test', tracingEnabled: true, callbacksBackground: false });
    const records: any[] = [];
    const client = getLangSmithClient()!;
    client.createRun = async value => { records.push(value); };
    client.updateRun = async (_id, value) => { records.push(value); };
    const output = await traceWritingRequest('request-test', { text: '完整小说输入' }, async () => {
      assert.strictEqual(getCurrentRunTree().name, 'aiwriter.request');
      return { text: '完整小说输出' };
    });
    assert.strictEqual(output.text, '完整小说输出');
    const json = JSON.stringify(records);
    assert.ok(json.includes('完整小说输入'));
    assert.ok(json.includes('完整小说输出'));
  });

  test('traces direct SDK model calls under the request without recording the model API key', async () => {
    configureLangSmith({ enabled: true, apiKey: 'trace-test-only', project: 'test', tracingEnabled: true, callbacksBackground: false });
    const records: any[] = [];
    const client = getLangSmithClient()!;
    client.createRun = async value => { records.push(value); };
    client.updateRun = async (_id, value) => { records.push(value); };
    const model = createChatModel({ apiKey: 'model-secret-not-for-logs', baseUrl: 'https://custom.example/v1', model: 'custom',
      temperature: 0, streaming: false, fetch: async () => new Response(JSON.stringify({
        id: 'test', object: 'chat.completion', created: 1, model: 'custom',
        choices: [{ index: 0, message: { role: 'assistant', content: 'SDK 正文' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { headers: { 'content-type': 'application/json' } }) });
    await traceWritingRequest('sdk-trace', { text: '查询' }, () => model.invoke('查询', { metadata: { operation: 'trace-test' }, tags: ['local-test'] }));
    await client.awaitPendingTraceBatches();
    const parent = records.find(item => item.name === 'aiwriter.request');
    assert.ok(parent);
    const modelRuns = records.filter(item => item.id && item.run_type === 'llm');
    assert.ok(modelRuns.length > 0);
    assert.ok(modelRuns.every(item => item.extra?.metadata?.operation === 'trace-test'));
    assert.ok(modelRuns.every(item => item.tags?.includes('local-test')));
    assert.ok(modelRuns.every(item => {
      let id = item.parent_run_id;
      const visited = new Set<string>();
      while (id && !visited.has(id)) {
        if (id === parent.id) { return true; }
        visited.add(id);
        id = records.find(record => record.id === id)?.parent_run_id;
      }
      return false;
    }));
    assert.ok(JSON.stringify(records).includes('SDK 正文'));
    assert.ok(!JSON.stringify(records).includes('model-secret-not-for-logs'));
  });

  test('missing credentials or tracing disabled clears previous configuration', async () => {
    configureLangSmith({ enabled: true, apiKey: 'test-only', tracingEnabled: true, callbacksBackground: true });
    configureLangSmith({ enabled: true, tracingEnabled: true, callbacksBackground: true });
    assert.strictEqual(isLangSmithEnabled(), false);
    assert.strictEqual(getLangSmithClient(), null);
    let count = 0;
    assert.strictEqual(await traceWritingRequest('id', {}, async () => ++count), 1);
    configureLangSmith({ enabled: true, apiKey: 'test-only', tracingEnabled: false, callbacksBackground: true });
    assert.strictEqual(isLangSmithEnabled(), false);
  });
});
