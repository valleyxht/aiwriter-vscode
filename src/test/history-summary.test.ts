import * as assert from 'assert';
import { AIMessage } from '../ai/messages';
const summaryModel = (invoke: (prompt: string) => Promise<string>) => ({ invoke });
import { compactHistory, historyPrefixHash, summaryMessages, validHistorySummary } from '../ai/runtime/history-summary';
import { AIEngine } from '../ai/runtime/engine';
import { ChatMessage, DEFAULT_AI_CONFIG, HistorySummary } from '../types';
import { TokenCounter } from '../memory/token-counter';
import { SessionManager } from '../core/session';

function history(turns = 6): ChatMessage[] {
  return Array.from({ length: turns * 2 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}:` + '内容😀'.repeat(40), timestamp: String(index),
  }));
}

const counter = {
  countTokens: (text: string) => text.length,
  countMessageLike: (messages: any[]) => messages.reduce((total, m) => total + String(m.content).length + 4, 0),
} as TokenCounter;

suite('Rolling conversation summary', () => {
  test('generates summaries in bounded batches, keeps complete recent turns and original history', async () => {
    const original = history();
    const before = JSON.stringify(original);
    const inputs: string[] = [];
    const options = { history: original, counter, historyBudget: 1200, summaryInputBudget: 1000,
      summaryMaxTokens: 150, llm: summaryModel(async (prompt: any) => {
        inputs.push(prompt.toString());
        return '用户已确认设定；助手建议尚待确认。';
      }) as any };
    const summary = (await compactHistory(options))!;
    assert.ok(inputs.length > 1);
    assert.ok(inputs.every(input => input.length + 4 <= options.summaryInputBudget));
    assert.ok(inputs.slice(1).every(input => input.includes('用户已确认设定')));
    assert.strictEqual(summary.coveredMessages % 2, 0);
    assert.ok(summary.coveredMessages <= original.length - 4);
    assert.ok(validHistorySummary(original, summary));
    const visible = summaryMessages(original, summary);
    assert.strictEqual(visible[0]._getType(), 'system');
    assert.deepStrictEqual(visible.slice(-4).map(m => m.content), original.slice(-4).map(m => m.content));
    assert.strictEqual(JSON.stringify(original), before);
    // Formatting adds a Human: prefix to each batch; all original material survives batching.
    const combined = inputs.map(input => input.split('Human: ').slice(1).join('Human: ')
      .split('\n\n更新后的摘要：')[0]).join('');
    for (const message of original.slice(0, summary.coveredMessages)) {
      assert.ok(combined.includes(message.content));
    }
    assert.strictEqual(await compactHistory({ ...options, previous: summary, historyBudget: 3000 }), summary);
  });

  test('rejects changed or rewound prefixes, but accepts appended messages and status updates', () => {
    const messages = history();
    const summary: HistorySummary = { content: '摘要', coveredMessages: 4, prefixHash: historyPrefixHash(messages, 4) };
    assert.ok(validHistorySummary([...messages, ...history(1)], summary));
    assert.ok(validHistorySummary(messages.map(m => ({ ...m, requestStatus: 'COMPLETED' })), summary));
    assert.ok(!validHistorySummary(messages.slice(0, 2), summary));
    assert.ok(!validHistorySummary(messages.map((m, i) => i ? m : { ...m, content: '改过' }), summary));
  });

  test('extends the saved summary with only newly covered history', async () => {
    const messages = history(10);
    const previous = { content: '之前已确认的设计', coveredMessages: 4, prefixHash: historyPrefixHash(messages, 4) };
    const inputs: string[] = [];
    const summary = (await compactHistory({ history: messages, previous, counter, historyBudget: 1200,
      summaryInputBudget: 1000, summaryMaxTokens: 150,
      llm: summaryModel(async (prompt: any) => { inputs.push(prompt.toString()); return '累计的新摘要'; }) as any }))!;
    assert.ok(inputs[0].includes(previous.content));
    assert.ok(inputs.every(input => !input.includes('message-0:') && !input.includes('message-3:')));
    assert.ok(inputs[0].includes('message-4:'));
    assert.ok(summary.coveredMessages > previous.coveredMessages);
    assert.ok(summary.coveredMessages <= messages.length - 4);
  });

  test('does not publish partial summaries after failure or cancellation', async () => {
    const previous = { content: '旧摘要', coveredMessages: 2, prefixHash: historyPrefixHash(history(), 2) };
    const controller = new AbortController();
    let calls = 0;
    const options = { history: history(), previous, counter, historyBudget: 1200,
      summaryInputBudget: 1000, summaryMaxTokens: 150, signal: controller.signal,
      llm: summaryModel(async () => { if (++calls > 1) { throw new Error('网络失败'); } return '中间摘要'; }) as any };
    await assert.rejects(compactHistory(options), /网络失败/);
    assert.strictEqual(previous.content, '旧摘要');
    controller.abort();
    await assert.rejects(compactHistory(options), { name: 'AbortError' });
    await assert.rejects(compactHistory({ ...options, signal: undefined,
      llm: summaryModel(async () => '') as any }), /摘要为空/);
    await assert.rejects(compactHistory({ ...options, signal: undefined,
      llm: summaryModel(async () => '过长'.repeat(100)) as any }), /超过预算/);
  });

  test('persists per-session summaries across reload and invalidates summaries on rollback', async () => {
    const values = new Map<string, any>();
    const storage = { getGlobalData: async (key: string) => values.get(key),
      setGlobalData: async (key: string, value: any) => { values.set(key, structuredClone(value)); } };
    const manager = new SessionManager({} as any, storage as any);
    const first = await manager.createSession('first');
    const second = await manager.createSession('second');
    for (const message of history()) { await manager.addMessage(first.sessionId, message); }
    const summary = { content: '会话一摘要', coveredMessages: 4, prefixHash: historyPrefixHash(first.history, 4) };
    await manager.saveHistorySummary(first.sessionId, summary);
    const reloaded = new SessionManager({} as any, storage as any);
    await reloaded.initialize();
    assert.deepStrictEqual((await reloaded.loadSession(first.sessionId))!.historySummary, summary);
    assert.strictEqual((await reloaded.loadSession(second.sessionId))!.historySummary, undefined);
    await reloaded.truncateHistory(first.sessionId, 6);
    assert.deepStrictEqual((await reloaded.loadSession(first.sessionId))!.historySummary, summary);
    await reloaded.truncateHistory(first.sessionId, 2);
    await reloaded.saveHistorySummary(first.sessionId, summary); // Late result after rollback must be rejected.
    assert.strictEqual((await reloaded.loadSession(first.sessionId))!.historySummary, undefined);
  });

  test('engine summarizes before trimming, persists once and reloads without repeating summary calls', async () => {
    let calls = 0;
    const engine = new AIEngine({ ...DEFAULT_AI_CONFIG, apiKey: '', model: 'test', contextWindowSize: 20 },
      {} as any, {} as any, undefined, undefined, undefined, [], (() => ({
        invoke: async () => { calls++; return new AIMessage('用户已确认的设计与未决任务。'); },
      })) as any);
    const original = history(40);
    const saved: HistorySummary[] = [];
    const request = { requestId: 'summary-test', controller: new AbortController() };
    try {
      engine.loadHistory(original, undefined, async summary => { saved.push(summary); });
      assert.strictEqual(engine.getHistory().length, original.length);
      const visible = await (engine as any)._prepareHistory('当前请求', '本轮附件', undefined, request);
      assert.ok(calls > 0);
      assert.strictEqual(saved.length, 1);
      assert.ok(visible[0].content.includes('用户已确认的设计'));
      assert.strictEqual(engine.getHistory().length, original.length);
      engine.loadHistory(original, saved[0]);
      const previousCalls = calls;
      await (engine as any)._prepareHistory('当前请求', '本轮附件', undefined, request);
      assert.strictEqual(calls, previousCalls);
      engine.loadHistory(original, undefined, async () => { engine.loadHistory(history(1)); });
      await (engine as any)._prepareHistory('切换会话', undefined, undefined, request);
      assert.strictEqual((engine as any)._historySummary, undefined);
      engine.clearHistory();
      assert.deepStrictEqual(await (engine as any)._prepareHistory('新会话', undefined, undefined, request), []);
    } finally { engine.dispose(); }
  });

  test('engine retains the old summary on failure and isolates a session switch during summary generation', async () => {
    const original = history(40);
    const previous = { content: '有效旧摘要', coveredMessages: 2, prefixHash: historyPrefixHash(original, 2) };
    let fail = true;
    let engine: AIEngine;
    let writes = 0;
    engine = new AIEngine({ ...DEFAULT_AI_CONFIG, apiKey: '', model: 'test', contextWindowSize: 20 },
      {} as any, {} as any, undefined, undefined, undefined, [], (() => ({
        invoke: async () => {
          if (fail) { throw new Error('摘要失败'); }
          engine.loadHistory(history(1));
          return new AIMessage('旧会话生成的摘要');
        },
      })) as any);
    try {
      engine.loadHistory(original, previous, async () => { writes++; });
      const input = await (engine as any)._prepareHistory('问题', undefined, undefined,
        { requestId: 'failed-summary', controller: new AbortController() });
      assert.ok(input[0].content.includes(previous.content));
      assert.strictEqual(writes, 0);
      fail = false;
      await (engine as any)._prepareHistory('问题', undefined, undefined,
        { requestId: 'switched-summary', controller: new AbortController() });
      assert.strictEqual(writes, 0);
      assert.strictEqual((engine as any)._historySummary, undefined);
      assert.strictEqual(engine.getHistory().length, 2);
    } finally { engine.dispose(); }
  });
});
