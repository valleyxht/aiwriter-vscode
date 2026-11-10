import * as assert from 'assert';
import { SessionManager } from '../core/session';
import { Session } from '../types';
import { historyPrefixHash } from '../memory/history-summary-state';
import { ChatController } from '../presentation/webview/controllers/chat-controller';
import { WebviewProtocol } from '../webview/protocol';

suite('Session idempotency governance', () => {
  test('branches from a saved answer, switches to it, and keeps later history and undo data in the original', async () => {
    const source: Session = {
      sessionId: 'source', title: '构思', workspaceDirectory: 'workspace',
      dateCreated: '2026-11-01', dateModified: '2026-11-01',
      history: [
        { role: 'user', content: '第一问', timestamp: 'u1' },
        { role: 'assistant', content: '第一答', timestamp: 'a1',
          modelContext: { baseUrl: 'local', model: 'test', content: [{ text: 'original' }] } },
        { role: 'user', content: '第二问', timestamp: 'u2', requestId: 'request-2' },
        { role: 'assistant', content: '第二答', timestamp: 'a2', requestId: 'request-2', requestStatus: 'COMPLETED' },
      ],
      snapshots: [{ conversationIndex: 0, timestamp: 'snapshot', files: [{ filepath: 'story.md', content: 'original' }] }],
    };
    source.historySummary = { content: '包含后续剧情', coveredMessages: 4, prefixHash: historyPrefixHash(source.history, 4) };
    const values = new Map<string, unknown>([
      ['aiwriter.sessions', [source]], ['aiwriter.activeSession', source.sessionId],
    ]);
    const storage = {
      getGlobalData: async (key: string) => values.get(key),
      setGlobalData: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    };
    const manager = new SessionManager({} as any, storage as any);
    await manager.initialize();
    const protocol = new WebviewProtocol({} as any);
    const sent: any[] = [];
    protocol.setWebview({ postMessage: (message: unknown) => { sent.push(message); } } as any);
    let listRefreshes = 0;
    new ChatController(manager, {} as any, {} as any, protocol, {
      syncSessions: async () => { listRefreshes++; },
    } as any, {} as any).register();

    await protocol.handleMessage({
      type: 'session/branch', id: 'branch-message', timestamp: 'now',
      data: { sessionId: source.sessionId, timestamp: 'a1' },
    });

    const branch = (await manager.getActiveSession())!;
    assert.notStrictEqual(branch.sessionId, source.sessionId);
    assert.strictEqual(branch.title, '构思 · 分支');
    assert.strictEqual(branch.workspaceDirectory, source.workspaceDirectory);
    assert.deepStrictEqual(branch.history, source.history.slice(0, 2));
    assert.strictEqual(branch.historySummary, undefined);
    assert.deepStrictEqual(branch.snapshots, []);
    assert.strictEqual(source.history.length, 4);
    assert.strictEqual(source.snapshots.length, 1);
    assert.strictEqual(values.get('aiwriter.activeSession'), branch.sessionId);
    assert.strictEqual(listRefreshes, 1);
    assert.deepStrictEqual(sent.map(message => message.type), ['session/loaded', 'session/branch_finished']);
    assert.strictEqual(sent[0].data.history[1].modelContext, undefined);
    assert.notStrictEqual(branch.history[1].modelContext, source.history[1].modelContext);
    await manager.truncateHistory(branch.sessionId, 1);
    assert.strictEqual(source.history.length, 4);

    source.historySummary = { content: '只覆盖分支前缀', coveredMessages: 2, prefixHash: historyPrefixHash(source.history, 2) };
    const withSummary = await manager.branchSession(source.sessionId, { timestamp: 'a2', requestId: 'request-2' });
    assert.deepStrictEqual(withSummary.historySummary, source.historySummary);
    assert.notStrictEqual(withSummary.historySummary, source.historySummary);
    await assert.rejects(manager.branchSession(source.sessionId, { timestamp: 'u1' }), /已完成的回答/);
    await assert.rejects(manager.branchSession(source.sessionId, { timestamp: 'a2', requestId: 'stale' }), /已完成的回答/);
  });

  test('deduplicates request messages and replaces same-turn snapshots', async () => {
    const session: Session = {
      sessionId: 'session-1',
      title: 'test',
      workspaceDirectory: 'D:\\workspace',
      dateCreated: new Date().toISOString(),
      dateModified: new Date().toISOString(),
      history: [],
      snapshots: [],
    };
    const values = new Map<string, any>([
      ['aiwriter.sessions', [session]],
      ['aiwriter.activeSession', session.sessionId],
    ]);
    const storage = {
      getGlobalData: async <T>(key: string): Promise<T | undefined> => values.get(key),
      setGlobalData: async (key: string, value: any) => { values.set(key, value); },
      removeGlobalData: async (key: string) => { values.delete(key); },
    };
    const manager = new SessionManager({} as any, storage as any);
    await manager.initialize();

    const first = await manager.addMessage(session.sessionId, {
      role: 'user', content: 'hello', timestamp: 'first', requestId: 'request-1', requestStatus: 'RUNNING',
    });
    const duplicate = await manager.addMessage(session.sessionId, {
      role: 'user', content: 'changed', timestamp: 'second', requestId: 'request-1', requestStatus: 'RUNNING',
    });
    assert.strictEqual(first, true);
    assert.strictEqual(duplicate, false);
    assert.strictEqual((await manager.loadSession(session.sessionId))!.history.length, 1);
    assert.strictEqual((await manager.loadSession(session.sessionId))!.history[0].content, 'hello');

    await manager.addMessage(session.sessionId, {
      role: 'user', content: 'second turn', timestamp: 'third', requestId: 'request-2', requestStatus: 'FAILED',
    });
    assert.strictEqual(manager.getCurrentConversationIndex(session.sessionId), 2);
    assert.strictEqual(manager.getConversationUserMessage(session.sessionId, 1)?.content, 'second turn');
    assert.strictEqual(manager.getConversationUserMessage(session.sessionId, 2), undefined);

    await manager.saveSnapshot(session.sessionId, 0, [{ filepath: 'a.md', content: 'one' }]);
    await manager.saveSnapshot(session.sessionId, 0, [{ filepath: 'a.md', content: 'two' }]);
    const snapshots = manager.getAllSnapshots(session.sessionId);
    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(snapshots[0].files[0].content, 'two');

    await manager.truncateBeforeConversation(session.sessionId, 1);
    assert.strictEqual((await manager.loadSession(session.sessionId))!.history.length, 1);
  });
});
