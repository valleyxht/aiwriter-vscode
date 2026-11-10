import * as assert from 'assert';
import { AIMessage, HumanMessage, ToolMessage } from '../ai/messages';
import {
  collectNormalizedEvidence,
  projectMessagesWithNormalizedEvidence,
} from '../ai/runtime/evidence-normalizer';
import { createWritingAssistantAgent, DEFAULT_AGENT_LIMITS } from '../ai/runtime/agent';
import { TokenCounter } from '../memory/token-counter';
import { DEFAULT_AI_CONFIG } from '../types';

suite('Evidence normalizer', () => {
  test('sorts evidence by source, path and line instead of tool call order', () => {
    const messages = [
      new HumanMessage('research'),
      toolCall('call_web', 'searchWeb', { query: 'weather' }),
      toolResult('call_web', 'web evidence'),
      toolCall('call_b', 'readFile', { filepath: 'B.md', startLine: 20, endLine: 30 }),
      toolResult('call_b', 'content B'),
      toolCall('call_rag', 'searchStory', { query: 'rain scene' }),
      toolResult('call_rag', 'rag evidence'),
      toolCall('call_a2', 'readFile', { filepath: 'A.md', startLine: 20, endLine: 30 }),
      toolResult('call_a2', 'content A later'),
      toolCall('call_a1', 'readFile', { filepath: 'A.md', startLine: 1, endLine: 10 }),
      toolResult('call_a1', 'content A earlier'),
      toolCall('call_search', 'searchInFiles', { baseDirectory: '.', searchText: 'rain' }),
      toolResult('call_search', 'file search evidence'),
    ];

    const evidence = collectNormalizedEvidence(messages);

    assert.deepStrictEqual(
      evidence.map(item => [item.sourceType, item.sourcePath, item.startLine]),
      [
        ['file_read', 'A.md', 1],
        ['file_read', 'A.md', 20],
        ['file_read', 'B.md', 20],
        ['rag', undefined, undefined],
        ['file_search', '.', undefined],
        ['web', undefined, undefined],
      ]
    );
  });

  test('deduplicates exact content and retains the higher-priority source', () => {
    const messages = [
      toolCall('call_web', 'searchWeb', { query: 'same' }),
      toolResult('call_web', 'same evidence'),
      toolCall('call_file', 'readFile', { filepath: 'source.md' }),
      toolResult('call_file', 'same evidence'),
    ];

    const evidence = collectNormalizedEvidence(messages);

    assert.strictEqual(evidence.length, 1);
    assert.strictEqual(evidence[0].sourceType, 'file_read');
    assert.strictEqual(evidence[0].sourcePath, 'source.md');
  });

  test('replaces completed tool protocol pairs only in the provider-facing copy', () => {
    const human = new HumanMessage('research');
    const call = toolCall('call_1', 'readFile', { filepath: 'A.md' });
    const result = toolResult('call_1', 'content A');
    const original = [human, call, result];

    const projected = projectMessagesWithNormalizedEvidence(original);

    assert.strictEqual(original.length, 3, 'the graph state must remain unchanged');
    assert.strictEqual(projected.length, 2);
    assert.strictEqual(projected[0], human);
    assert.strictEqual(projected.some(message => ToolMessage.isInstance(message)), false);
    assert.strictEqual(projected.some(message => message.getType() === 'ai'), false);
    assert.match(String(projected[1].content), /规范化工具证据/);
    assert.match(String(projected[1].content), /content A/);
  });

  test('projects accumulated evidence before every subsequent graph model call', async () => {
    const invocations: BaseMessageLike[][] = [];
    const responses = [
      toolCall('call_b', 'searchWeb', { query: 'B' }),
      toolCall('call_a', 'searchWeb', { query: 'A' }),
      new AIMessage('done'),
    ];
    const invoke = async (messages: BaseMessageLike[]) => {
      invocations.push(messages);
      const response = responses.shift();
      assert.ok(response, 'unexpected extra model invocation');
      return response;
    };
    const modelFactory = (() => ({
      bind: () => ({ invoke }),
      invoke,
    })) as any;
    const webSearchToolFactory = (() => [{
      name: 'searchWeb',
      description: 'search web',
      schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      func: async ({ query }: { query: string }) => ({ status: 'success', code: 'ok', content: `evidence ${query}` }),
    }]) as any;
    const counter = new TokenCounter('user-supplied-model', 20);

    try {
      const graph = createWritingAssistantAgent(
        {
          ...DEFAULT_AI_CONFIG,
          apiKey: 'test',
          model: 'user-supplied-model',
          webSearch: { ...DEFAULT_AI_CONFIG.webSearch!, enabled: true, apiKey: 'test' },
        },
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory,
        webSearchToolFactory
      );

      await graph.invoke({ messages: [new HumanMessage('research')] }, { });

      assert.strictEqual(invocations.length, 3);
      for (const invocation of invocations.slice(1)) {
        assert.strictEqual(invocation.some(message => message.getType() === 'tool'), false);
        assert.strictEqual(invocation.some(message =>
          message.getType() === 'ai' && Array.isArray((message as any).tool_calls)
            && (message as any).tool_calls.length > 0
        ), false);
      }
      const finalEvidence = invocations[2].map(message => String(message.content)).join('\n');
      assert.ok(finalEvidence.indexOf('evidence A') < finalEvidence.indexOf('evidence B'));
      assert.strictEqual((finalEvidence.match(/evidence A/g) || []).length, 1);
      assert.strictEqual((finalEvidence.match(/evidence B/g) || []).length, 1);
    } finally {
      counter.dispose();
    }
  });
});

type BaseMessageLike = HumanMessage | AIMessage | ToolMessage | { getType(): string; content: unknown };

function toolCall(id: string, name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args }],
  });
}

function toolResult(id: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id });
}
