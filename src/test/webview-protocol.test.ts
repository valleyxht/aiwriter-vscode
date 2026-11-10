import * as assert from 'assert';
import * as vscode from 'vscode';
import { Message, WebviewProtocol } from '../webview/protocol';

suite('Webview protocol error boundary', () => {
  test('keeps persisted model protocol context out of chat and session UI payloads', () => {
    const protocol = new WebviewProtocol({} as vscode.ExtensionContext);
    const posted: any[] = [];
    protocol.setWebview({ postMessage: (message: any) => { posted.push(message); } } as any);
    const message = { role: 'assistant' as const, content: '正文', timestamp: 'now',
      modelContext: { baseUrl: 'https://example.test/v1', model: 'test', content: [{ type: 'reasoning', text: 'hidden' }] } };
    protocol.sendMessage({ type: 'message/appended', data: message });
    for (const type of ['session/active', 'session/created', 'session/loaded'] as const) {
      protocol.sendMessage({ type, data: { history: [message] } as any });
    }
    assert.ok(posted.every(item => !JSON.stringify(item).includes('hidden')));
    assert.ok(posted.every(item => JSON.stringify(item).includes('正文')));
    assert.strictEqual(message.modelContext.content[0].text, 'hidden');
  });
  test('handler errors are reported without leaking a rejected promise', async () => {
    const protocol = new WebviewProtocol({} as vscode.ExtensionContext);
    protocol.onMessage('test/failure', async () => {
      throw new Error('expected failure');
    });
    const message: Message = {
      type: 'test/failure',
      id: 'message-1',
      data: undefined,
      timestamp: new Date().toISOString(),
    };

    const result = await protocol.handleMessage(message);

    assert.strictEqual(result, undefined);
  });
});
