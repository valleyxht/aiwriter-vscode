import * as assert from 'node:assert/strict';
import { RequestTelemetry } from '../ai/runtime/request-telemetry';
import { ResponseDelivery } from '../ai/runtime/response-delivery';
import { AIMessageChunk, HumanMessage } from '../ai/messages';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { toolSuccess } from '../ai/tools/contract';

suite('Response timing', () => {
  test('records first visible output once, including fallback delivery, without persisting text', async () => {
    const events: any[] = [];
    const telemetry = new RequestTelemetry('timing', undefined, { write: async (_root, _id, event) => { events.push(event); } });
    assert.equal(telemetry.snapshot().firstVisibleMs, null);
    await telemetry.run(async () => {
      const delivery = new ResponseDelivery(() => {});
      delivery.push('  ');
      assert.equal(telemetry.snapshot().firstVisibleMs, null);
      delivery.push('首次正文'); delivery.push('后续正文');
      new ResponseDelivery(() => {}).acceptCompleteResponse('兜底正文');
    });
    await telemetry.complete({ status: 'COMPLETED' });
    assert.equal(events.filter(event => event.event === 'request_received').length, 1);
    assert.equal(events.filter(event => event.event === 'first_visible_output').length, 1);
    assert.equal(events.at(-1).data.firstVisibleMs, telemetry.snapshot().firstVisibleMs);
    assert.doesNotMatch(JSON.stringify(events), /首次正文|后续正文|兜底正文/);
  });

  test('distinguishes an early tool preamble from the actual final answer', async () => {
    const events: any[] = [];
    const logger = { write: async (_root: unknown, _id: unknown, event: any) => { events.push(event); } };
    const telemetry = new RequestTelemetry('two-turns', undefined, logger);
    const delivery = new ResponseDelivery(() => {});
    let turns = 0;
    const model = { stream: async function* () {
      if (turns++ === 0) {
        yield new AIMessageChunk('先查资料。');
        yield new AIMessageChunk({ content: '', tool_call_chunks: [{ id: 't1', name: 'listFiles', args: '{}', index: 0 }] });
      } else { yield new AIMessageChunk('最终答案'); }
    } };
    const agent = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' }, {} as any, {} as any,
      { handleLLMNewToken: async text => delivery.push(text) }, undefined, undefined, undefined, undefined, undefined,
      (() => ({ ...model, bind: () => model })) as any, undefined, logger,
      { tools: [{ name: 'listFiles', description: 'list', schema: { type: 'object', properties: {} }, func: async () => toolSuccess('目录') }] });
    await telemetry.run(() => agent.invoke({ messages: [new HumanMessage('查资料回答')], requestId: 'two-turns' }));
    await telemetry.complete({ status: 'COMPLETED' });
    const final = events.find(event => event.event === 'final_answer_start');
    assert.equal(final.data.agentTurn, 2);
    assert.equal(events.filter(event => event.event === 'final_answer_start').length, 1);
    assert.ok(final.data.elapsedMs >= telemetry.snapshot().firstVisibleMs!);
    assert.equal(events.filter(event => event.event === 'model_input').length, 2);
    assert.ok(events.filter(event => event.event === 'model_turn_complete').every(event => event.data.firstTextElapsedMs >= 0));
  });
});
