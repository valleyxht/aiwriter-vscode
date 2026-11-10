import * as assert from 'assert';
import { ResponseDelivery } from '../ai/runtime';

suite('Streaming response delivery', () => {
  test('forwards every token immediately and accumulates final text', () => {
    const events: Array<{ content: string; done: boolean }> = [];
    const delivery = new ResponseDelivery((content, done) => events.push({ content, done }));
    delivery.push('第一段');
    delivery.push('');
    delivery.push('第二段');
    assert.strictEqual(delivery.content, '第一段第二段');
    assert.deepStrictEqual(events, [{ content: '第一段', done: false }, { content: '第二段', done: false }]);
  });

  test('publishes a completed response once if the provider emitted no streamed tokens', () => {
    const events: string[] = [];
    const delivery = new ResponseDelivery(content => events.push(content));
    delivery.acceptCompleteResponse('完整正文');
    delivery.acceptCompleteResponse('完整正文');
    assert.strictEqual(delivery.content, '完整正文');
    assert.deepStrictEqual(events, ['完整正文']);
  });

  test('does not duplicate the complete response after tokens have already been forwarded', () => {
    const events: string[] = [];
    const delivery = new ResponseDelivery(content => events.push(content));
    delivery.push('正文');
    delivery.acceptCompleteResponse('正文');
    assert.deepStrictEqual(events, ['正文']);
  });
});
