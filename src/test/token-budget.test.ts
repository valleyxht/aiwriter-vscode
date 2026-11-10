import * as assert from 'assert';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '../ai/messages';
import { TokenCounter } from '../memory/token-counter';
import {
  addUsageSummaries,
  calculateCompletionTokenBudget,
  normalizeUsageMetadata,
  prepareMessagesForModel,
} from '../ai/runtime';

suite('Token budget governance', () => {
  test('counts preserved SDK reasoning and refuses to silently remove active protocol context', () => {
    const counter = new TokenCounter('', 1);
    try {
      const assistant = new AIMessage({ content: '', additional_kwargs: { ai_sdk_content: [
        { type: 'reasoning', text: '推理内容'.repeat(1000) },
      ] } });
      assert.ok(counter.countMessageLike([assistant]) > 1000);
      assert.throws(() => prepareMessagesForModel([
        new SystemMessage('系统'), new HumanMessage('当前问题'), assistant,
      ], counter, { contextWindowTokens: 1000, maxOutputTokens: 256, safetyMarginTokens: 128 }), /超过上下文预算/);
    } finally { counter.dispose(); }
  });
  test('adds hidden reasoning headroom without changing the visible-output target', () => {
    const normal = calculateCompletionTokenBudget({
      visibleOutputTokens: 2_000,
      contextWindowTokens: 1_000_000,
    });
    assert.deepStrictEqual(normal, {
      visibleOutputTokens: 2_000,
      reasoningReserveTokens: 4_096,
      requestMaxTokens: 6_096,
      requestedBeforeCaps: 6_096,
      limitedBy: undefined,
    });

    const capped = calculateCompletionTokenBudget({
      visibleOutputTokens: 4_000,
      contextWindowTokens: 128_000,
      modelMaxOutputTokens: 6_000,
    });
    assert.strictEqual(capped.requestMaxTokens, 6_000);
    assert.strictEqual(capped.reasoningReserveTokens, 2_000);
    assert.strictEqual(capped.limitedBy, 'model_max_output');
  });
  test('drops old history but preserves the current user turn', () => {
    const counter = new TokenCounter('gpt-4o-mini', 1);
    try {
      const current = '请继续写当前场景\n\n以下是本次用户请求的附件/选中文本（作为参考材料）：\n角色推门而入。';
      const messages = [
        new SystemMessage('系统提示'),
        new HumanMessage('旧问题'.repeat(180)),
        new AIMessage('旧回答'.repeat(180)),
        new HumanMessage(current),
      ];
      const prepared = prepareMessagesForModel(messages, counter, {
        contextWindowTokens: 1_000,
        maxOutputTokens: 256,
        safetyMarginTokens: 128,
      });
      assert.ok(prepared.droppedMessages >= 1);
      assert.ok(prepared.inputTokens <= prepared.inputBudget);
      assert.strictEqual(prepared.messages.at(-1)?.content, current);
      assert.strictEqual((prepared.messages[0] as any)._getType(), 'system');
    } finally {
      counter.dispose();
    }
  });

  test('compacts static context and tool output without breaking tool ids', () => {
    const counter = new TokenCounter('gpt-4o-mini', 1);
    try {
      const messages = [
        new SystemMessage('系统提示'),
        new SystemMessage('项目目录'.repeat(300)),
        new HumanMessage('读取后总结'),
        new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'readFile', args: { filepath: 'a.md' } }] }),
        new ToolMessage({ content: '工具结果'.repeat(300), tool_call_id: 'call_1' }),
      ];
      const prepared = prepareMessagesForModel(messages, counter, {
        contextWindowTokens: 1_000,
        maxOutputTokens: 256,
        safetyMarginTokens: 128,
      });
      assert.ok(prepared.truncatedMessages >= 1);
      assert.ok(prepared.inputTokens <= prepared.inputBudget);
      const tool = prepared.messages.find(message => (message as any)._getType() === 'tool') as any;
      assert.strictEqual(tool.tool_call_id, 'call_1');
    } finally {
      counter.dispose();
    }
  });

  test('prefers provider usage and accumulates agent calls', () => {
    const first = normalizeUsageMetadata({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }, 1, 1);
    const second = normalizeUsageMetadata({ input_tokens: 140, output_tokens: 30, total_tokens: 170 }, 1, 1);
    const total = addUsageSummaries(first, second);
    assert.deepStrictEqual(total, {
      inputTokens: 240,
      outputTokens: 50,
      totalTokens: 290,
      lastInputTokens: 140,
      lastOutputTokens: 30,
    });
  });

  test('accepts camelCase usage metadata from compatible providers', () => {
    const usage = normalizeUsageMetadata(
      { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      1,
      1
    );
    assert.strictEqual(usage.totalTokens, 20);
  });

  test('truncates text by tokens and includes the marker inside the limit', () => {
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const truncated = counter.truncateText('天地玄黄，宇宙洪荒。'.repeat(500), 120);
      assert.match(truncated, /已按 Token 预算截断/);
      assert.ok(counter.countTokens(truncated) <= 120);
    } finally {
      counter.dispose();
    }
  });

  test('does not split UTF-16 surrogate pairs while compacting context', () => {
    const counter = new TokenCounter('gpt-4o-mini', 1);
    try {
      const messages = [
        new SystemMessage('系统提示'),
        new SystemMessage('🔥𠮷'.repeat(400)),
        new HumanMessage('继续'),
      ];
      const prepared = prepareMessagesForModel(messages, counter, {
        contextWindowTokens: 1_000,
        maxOutputTokens: 256,
        safetyMarginTokens: 128,
      });
      const compacted = String(prepared.messages[1].content);
      assert.ok(prepared.truncatedMessages > 0);
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(compacted));
      assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(compacted));
    } finally {
      counter.dispose();
    }
  });
});
