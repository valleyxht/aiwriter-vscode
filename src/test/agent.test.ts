import * as assert from 'assert';
import { toolSuccess, toolError, toolRejected } from '../ai/tools/contract';
import { AIMessage, AIMessageChunk, HumanMessage } from '../ai/messages';
import {
  AIEngine,
  classifyRequestTermination,
  classifyToolOutcome,
  accumulateAIMessageChunk,
  createWritingAssistantAgent,
  createToolCallSignature,
  DEFAULT_AGENT_LIMITS,
  extractVisibleText,
  getAgentLimitReason,
  getVisibleMessageText,
} from '../ai/runtime';
import { applyTextToolCallCompatibility, parseTextToolCalls } from '../ai/runtime';
import { ToolDef } from '../ai/tools/index';
import { TokenCounter } from '../memory/token-counter';
import { DEFAULT_AI_CONFIG } from '../types';

const listFilesTool: ToolDef = {
  name: 'listFiles',
  description: 'list files',
  schema: {
    type: 'object',
    properties: { directory: { type: 'string' } },
    required: ['directory'],
  },
  func: async () => toolSuccess(''),
};

const modifyFileTool: ToolDef = {
  name: 'modifyFile',
  description: 'modify file',
  schema: {
    type: 'object',
    properties: {
      filepath: { type: 'string' },
      operations: { type: 'array' },
    },
    required: ['filepath', 'operations'],
  },
  func: async () => toolSuccess(''),
};

suite('Agent tool loop and stream accumulation', () => {
  test('finishes from collected evidence when the tool budget is exhausted mid-batch', async () => {
    let executions = 0;
    let finalizations = 0;
    const modelFactory = (() => ({
      bind: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [
        { id: 'a', name: 'listFiles', args: { directory: '.' } },
        { id: 'b', name: 'listFiles', args: { directory: 'other' } },
      ] }) }),
      invoke: async (messages: any[]) => {
        finalizations++;
        assert.ok(messages.some(m => String(m.content).includes('story.txt')));
        assert.ok(messages.some(m => String(m.content).includes('此调用未执行')));
        return new AIMessage('根据已取得的资料回答；其余尚未核实。');
      },
    })) as any;
    const counter = new TokenCounter('test', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        { listFiles: async () => { executions++; return { success: true, content: 'story.txt' }; } } as any,
        {} as any, undefined, undefined, undefined, counter,
        { ...DEFAULT_AGENT_LIMITS, maxToolCalls: 1 }, undefined, modelFactory
      );
      const result = await graph.invoke({ messages: [new HumanMessage('检查资料')] });
      assert.strictEqual(executions, 1);
      assert.strictEqual(finalizations, 1);
      assert.match(String(result.messages.at(-1)?.content), /根据已取得/);
    } finally { counter.dispose(); }
  });
  test('places project memory before conversation messages', async () => {
    let capturedMessages: any[] = [];
    const availableToolSets: string[][] = [];
    const invoke = async (messages: any[]) => {
      capturedMessages = messages;
      return new AIMessage('完成');
    };
    const modelFactory = (() => ({
      bind: ({ tools }: any) => {
        availableToolSets.push(tools.map((tool: any) => tool.function.name));
        return { invoke };
      },
      invoke,
    })) as any;
    const counter = new TokenCounter('user-supplied-model', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test', model: 'user-supplied-model' },
        {} as any,
        {} as any,
        undefined, undefined, undefined, counter, DEFAULT_AGENT_LIMITS,
        undefined, modelFactory
      );

      await graph.invoke({
        messages: [new HumanMessage('用户问题')],
        projectMemory: '# 项目地图\n\n- `设定/`：世界观资料。',
      });

      assert.match(String(capturedMessages[1].content), /AIWRITER\.md/);
      assert.match(String(capturedMessages[1].content), /`设定\/`/);
      assert.strictEqual(capturedMessages[2].content, '用户问题');
      assert.ok(availableToolSets.some(tools => tools.includes('rememberWritingPreference')));
      assert.match(String(capturedMessages[0].content), /明确要求“记住、保存、以后默认采用”/);
    } finally {
      counter.dispose();
    }
  });

  test('classifies explicit status independently of prose', () => {
    assert.strictEqual(classifyToolOutcome(toolSuccess('读取失败: 这是小说原文。')), 'success');
    assert.strictEqual(classifyToolOutcome(toolError('read_failed', '任意提示')), 'error');
    assert.strictEqual(classifyToolOutcome(toolRejected('user_rejected', '用户已取消')), 'rejected');
  });

  for (const multipart of [false, true]) {
    test(`keeps current attachments after history and before tool evidence (${multipart ? 'content blocks' : 'text'})`, async () => {
      const calls: any[][] = [];
      const invoke = async (messages: any[]) => {
        calls.push(messages);
        return calls.length === 1
          ? new AIMessage({ content: '', tool_calls: [
            { id: 'context_order', name: 'listFiles', args: { directory: '.' } },
          ] })
          : new AIMessage('完成');
      };
      const modelFactory = (() => ({ bind: () => ({ invoke }), invoke })) as any;
      const counter = new TokenCounter('test', 20);
      const content = multipart
        ? [{ type: 'text' as const, text: '当前用户请求' },
          { type: 'image_url' as const, image_url: { url: 'https://example.com/reference.png' } }]
        : '当前用户请求';
      const current = new HumanMessage({ content, id: 'current_request', name: 'writer',
        additional_kwargs: { requestTag: 'preserved' } });
      try {
        const graph = createWritingAssistantAgent(
          { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
          { listFiles: async () => ({ success: true, content: 'tool-evidence-story.txt' }) } as any,
          {} as any, undefined, undefined, undefined, counter,
          { ...DEFAULT_AGENT_LIMITS, maxToolCalls: 1 }, undefined, modelFactory, undefined, undefined,
          { systemPrompt: '系统指令', referenceContext: '静态项目目录' }
        );
        const result = await graph.invoke({
          messages: [new HumanMessage('历史问题'), new AIMessage('历史回答'), current],
          projectMemory: '长期项目记忆',
          collectedTexts: '本轮选中原文',
        });

        assert.strictEqual(calls.length, 2);
        for (const messages of calls) {
          assert.deepStrictEqual(messages.slice(0, 6).map(message => message._getType()),
            ['system', 'system', 'system', 'human', 'ai', 'human']);
          assert.strictEqual(messages[0].content.startsWith('系统指令'), true);
          assert.match(String(messages[1].content), /长期项目记忆/);
          assert.strictEqual(messages[2].content, '静态项目目录');
          assert.strictEqual(messages[3].content, '历史问题');
          assert.strictEqual(messages[4].content, '历史回答');
          const request = messages[5];
          assert.strictEqual(request.id, 'current_request');
          assert.strictEqual(request.name, 'writer');
          assert.deepStrictEqual(request.additional_kwargs, { requestTag: 'preserved' });
          const text = JSON.stringify(request.content);
          assert.ok(text.indexOf('当前用户请求') < text.indexOf('本轮选中原文'));
          assert.strictEqual(text.split('本轮选中原文').length - 1, 1);
          assert.ok(messages.filter(message => message._getType() === 'system')
            .every(message => !String(message.content).includes('本轮选中原文')));
          if (multipart) {
            assert.deepStrictEqual(request.content.slice(0, 2), content);
          }
        }
        assert.ok(calls[1].findIndex(message => String(message.content).includes('tool-evidence-story.txt')) > 5);
        assert.deepStrictEqual(current.content, content);
        assert.deepStrictEqual(result.messages.find((message: any) => message.id === 'current_request')!.content, content);
      } finally { counter.dispose(); }
    });
  }

  test('distinguishes internal timeouts from user cancellation', () => {
    const timeoutController = new AbortController();
    const timeout = new Error('请求超时');
    timeout.name = 'TimeoutError';
    timeoutController.abort(timeout);
    assert.deepStrictEqual(
      classifyRequestTermination(timeout, timeoutController.signal),
      { status: 'FAILED', error: '请求超时' }
    );

    const cancelledController = new AbortController();
    cancelledController.abort(new Error('用户停止生成'));
    assert.deepStrictEqual(
      classifyRequestTermination(new Error('用户停止生成'), cancelledController.signal),
      { status: 'INTERRUPTED', error: '请求已中断' }
    );
  });

  test('leaves the provider completion limit unset', () => {
    const modelBudgets: Array<number | undefined> = [];
    const modelFactory = ((options: any) => {
      modelBudgets.push(options.maxTokens);
      return {
        bind: () => ({ invoke: async () => undefined }),
        invoke: async () => undefined,
      };
    }) as any;
    const counter = new TokenCounter('deepseek-v4-flash', 1_000);
    try {
      createWritingAssistantAgent(
        {
          ...DEFAULT_AI_CONFIG,
          apiKey: 'test',
          model: 'deepseek-v4-flash',
          maxTokens: 2_000,
          contextWindowSize: 1_000,
          contextWindowDetection: {
            source: 'litellm',
            contextWindowTokens: 1_000_000,
            maxOutputTokens: 16_384,
          },
        },
        {} as any,
        {} as any,
        undefined, undefined, undefined, counter, DEFAULT_AGENT_LIMITS,
        undefined, modelFactory
      );

      assert.deepStrictEqual(modelBudgets, [undefined, undefined]);
    } finally {
      counter.dispose();
    }
  });

  test('merges text, partial tool arguments and finish reason', () => {
    const first = new AIMessageChunk({
      content: '准备',
      tool_call_chunks: [{
        name: 'readFile',
        args: '{"file',
        id: 'call_1',
        index: 0,
        type: 'tool_call_chunk'
      }]
    });
    const second = new AIMessageChunk({
      content: '读取',
      tool_call_chunks: [{
        name: undefined,
        args: 'path":"story.md"}',
        id: undefined,
        index: 0,
        type: 'tool_call_chunk'
      }],
      response_metadata: { finish_reason: 'tool_calls' }
    });

    const result = accumulateAIMessageChunk(first, second);
    const toolCalls = result.tool_calls || [];

    assert.strictEqual(result.content, '准备读取');
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].name, 'readFile');
    assert.deepStrictEqual(toolCalls[0].args, { filepath: 'story.md' });
    assert.strictEqual(result.response_metadata.finish_reason, 'tool_calls');
  });

  test('extracts visible text blocks without exposing reasoning blocks', () => {
    const content = [
      { type: 'reasoning', text: 'hidden chain of thought' },
      { type: 'output_text', text: '第一段回答。' },
      { type: 'text', text: '第二段回答。' },
    ];

    assert.strictEqual(extractVisibleText(content), '第一段回答。第二段回答。');
    assert.strictEqual(getVisibleMessageText(new AIMessage({ content } as any)), '第一段回答。第二段回答。');
  });

  test('normalizes provider content blocks into a visible final answer', async () => {
    let calls = 0;
    const modelFactory = (() => ({
      bind: () => ({ invoke: async () => {
        calls++;
        return new AIMessage({
          content: [{ type: 'output_text', text: '可以正常显示的回答。' }] as any,
          response_metadata: { finish_reason: 'stop' },
        });
      } }),
      invoke: async () => {
        throw new Error('finalizer should not run');
      },
    })) as any;
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory
      );

      const result = await graph.invoke(
        { messages: [new HumanMessage('你好')] },
        { }
      );

      assert.strictEqual(calls, 1);
      assert.strictEqual(result.messages[result.messages.length - 1].content, '可以正常显示的回答。');
    } finally {
      counter.dispose();
    }
  });

  test('recovers one empty final response with the no-tool finalizer', async () => {
    const responses = [
      new AIMessage({
        content: '',
        response_metadata: { finish_reason: 'stop' },
        usage_metadata: {
          input_tokens: 20,
          output_tokens: 100,
          total_tokens: 120,
          output_token_details: { reasoning: 100 },
        },
      }),
      new AIMessage({
        content: '自动恢复后的正常回答。',
        response_metadata: { finish_reason: 'stop' },
      }),
    ];
    const invocations: string[][] = [];
    const invoke = async (_messages: any[], tools: string[]) => {
      invocations.push(tools);
      const response = responses.shift();
      assert.ok(response, 'model received an unexpected extra invocation');
      return response;
    };
    const modelFactory = (() => ({
      bind: ({ tools }: any) => ({
        invoke: (messages: any[]) => invoke(messages, tools.map((tool: any) => tool.function.name)),
      }),
      invoke: (messages: any[]) => invoke(messages, []),
    })) as any;
    const events: any[] = [];
    const recoveryProgress: string[] = [];
    const logger = {
      write: async (_root: unknown, _id: unknown, event: any) => {
        events.push(event);
      },
    };
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        {} as any,
        {} as any,
        undefined,
        { onRecovery: detail => recoveryProgress.push(detail) },
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory,
        undefined,
        logger
      );

      const result = await graph.invoke(
        { messages: [new HumanMessage('请回答这个问题')], logRoot: 'test-root' },
        { metadata: { requestId: 'empty-recovery' }, }
      );

      assert.strictEqual(invocations.length, 2);
      assert.ok(invocations[0].length > 0);
      assert.deepStrictEqual(invocations[1], []);
      assert.strictEqual(result.messages[result.messages.length - 1].content, '自动恢复后的正常回答。');
      assert.ok(events.some(event => event.event === 'empty_response_detected'));
      assert.strictEqual(
        events.find(event => event.event === 'empty_response_recovered').data.source,
        'model'
      );
      assert.strictEqual(recoveryProgress.length, 1);
      assert.strictEqual(
        events.find(event => event.event === 'empty_response_detected').data.usage.reasoningTokens,
        100
      );
    } finally {
      counter.dispose();
    }
  });

  test('does not repeat a reasoning-only response that exhausted the provider limit', async () => {
    let calls = 0;
    const response = new AIMessage({
      content: '',
      response_metadata: { finish_reason: 'length' },
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 8_191,
        total_tokens: 8_291,
        output_token_details: { reasoning: 8_191 },
      },
    });
    const modelFactory = (() => ({
      bind: () => ({ invoke: async () => { calls++; return response; } }),
      invoke: async () => { calls++; return response; },
    })) as any;
    const events: any[] = [];
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory,
        undefined,
        { write: async (_root, _id, event) => { events.push(event); } }
      );
      const result = await graph.invoke(
        { messages: [new HumanMessage('请完成正文')], logRoot: 'test-root' },
        { metadata: { requestId: 'reasoning-only' }, }
      );
      const finalMessage = result.messages[result.messages.length - 1];

      assert.strictEqual(calls, 1);
      assert.strictEqual(result.agentTurns, 1);
      assert.strictEqual(finalMessage.additional_kwargs.reasoning_only_exhausted, true);
      assert.ok(events.some(event => event.event === 'reasoning_only_completion_exhausted'));
    } finally {
      counter.dispose();
    }
  });

  test('marks a second empty response as terminal when no tool result exists', async () => {
    const responses = [
      new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }),
      new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }),
    ];
    const modelFactory = (() => ({
      bind: () => ({ invoke: async () => responses.shift()! }),
      invoke: async () => responses.shift()!,
    })) as any;
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory
      );
      const result = await graph.invoke(
        { messages: [new HumanMessage('请回答')] },
        { }
      );
      const finalMessage = result.messages[result.messages.length - 1];

      assert.strictEqual(finalMessage.content, '');
      assert.strictEqual(finalMessage.additional_kwargs.empty_response_failure, true);
      assert.strictEqual(result.agentTurns, 2);
    } finally {
      counter.dispose();
    }
  });

  test('falls back to existing tool results when final recovery is also empty', async () => {
    const responses = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'list-1', name: 'listFiles', args: { directory: '.' } }],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }),
      new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }),
    ];
    let calls = 0;
    const nextResponse = async () => {
      calls++;
      return responses.shift()!;
    };
    const modelFactory = (() => ({
      bind: () => ({ invoke: nextResponse }),
      invoke: nextResponse,
    })) as any;
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        { listFiles: async () => ({ success: true, content: 'chapter-01.md', message: 'ok' }) } as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory
      );
      const result = await graph.invoke(
        { messages: [new HumanMessage('列出文件后回答')] },
        { }
      );
      const finalMessage = result.messages[result.messages.length - 1];

      assert.strictEqual(calls, 3);
      assert.ok(String(finalMessage.content).trim());
      assert.match(String(finalMessage.content), /chapter-01\.md/);
      assert.strictEqual(finalMessage.additional_kwargs.empty_response_recovered, true);
    } finally {
      counter.dispose();
    }
  });

  test('non-streaming engine reports a terminal empty response as failure', async () => {
    const engine = new AIEngine(
      { ...DEFAULT_AI_CONFIG, apiKey: '' },
      {} as any,
      {} as any
    );
    (engine as any)._agent = {
      invoke: async () => ({
        messages: [new AIMessage({
          content: '',
          additional_kwargs: { empty_response_failure: true },
          response_metadata: { finish_reason: 'stop' },
        })],
      }),
    };
    try {
      const result = await engine.sendMessage('你好');

      assert.strictEqual(result.success, false);
      assert.match(result.error || '', /未返回可显示内容/);
    } finally {
      engine.dispose();
    }
  });

  test('retains short history according to tokens rather than message count', () => {
    const engine = new AIEngine(
      { ...DEFAULT_AI_CONFIG, apiKey: '', contextWindowSize: 1 },
      {} as any,
      {} as any
    );
    try {
      const history = Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `短消息 ${index}`,
        timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      }));
      engine.loadHistory(history);
      assert.strictEqual(engine.getHistory().length, history.length);
    } finally {
      engine.dispose();
    }
  });

  test('creates stable signatures for equivalent tool arguments', () => {
    assert.strictEqual(
      createToolCallSignature('readFile', { b: 2, a: { y: 1, x: 0 } }),
      createToolCallSignature('readFile', { a: { x: 0, y: 1 }, b: 2 })
    );
  });

  test('converts provider text tool syntax into a structured tool call', () => {
    const parsed = parseTextToolCalls(
      '准备调用工具。\n<Tool name="list_files">\n<parameter name="target_directory" string="true">d:\\workspace</parameter>\n</Tool>',
      [listFilesTool]
    );

    assert.ok(parsed);
    assert.strictEqual(parsed.visibleContent, '准备调用工具。');
    assert.strictEqual(parsed.toolCalls[0].name, 'listFiles');
    assert.deepStrictEqual(parsed.toolCalls[0].args, { directory: 'd:\\workspace' });
  });

  test('converts tool_calls invoke syntax and maps path to directory', () => {
    const content = '准备调用工具。\n<tool_calls>\n<invoke name="list_files">\n<parameter name="path" string="true">d:\\workspace</parameter>\n</invoke>\n</tool_calls>';
    const parsed = parseTextToolCalls(content, [listFilesTool]);

    assert.ok(parsed);
    assert.strictEqual(parsed.toolCalls.length, 1);
    assert.strictEqual(parsed.toolCalls[0].name, 'listFiles');
    assert.deepStrictEqual(parsed.toolCalls[0].args, { directory: 'd:\\workspace' });
    assert.strictEqual(parsed.visibleContent, '准备调用工具。');

    const compatibleMessage = applyTextToolCallCompatibility(new AIMessage(content), [listFilesTool]);
    assert.strictEqual(compatibleMessage.tool_calls?.length, 1);
    assert.strictEqual(compatibleMessage.tool_calls?.[0].name, 'listFiles');
  });

  test('does not replace native structured tool calls', () => {
    const native = new AIMessage({
      content: '<Tool name="list_files"></Tool>',
      tool_calls: [{ id: 'native_1', name: 'listFiles', args: { directory: 'workspace' } }],
    });
    assert.strictEqual(applyTextToolCallCompatibility(native, [listFilesTool]), native);
  });

  test('reports model-turn, tool-call and cumulative-token limits', () => {
    assert.match(
      getAgentLimitReason({ agentTurns: DEFAULT_AGENT_LIMITS.maxModelTurns }, DEFAULT_AGENT_LIMITS, 1_000) || '',
      /模型轮数/
    );
    assert.match(
      getAgentLimitReason({ toolCallCount: DEFAULT_AGENT_LIMITS.maxToolCalls }, DEFAULT_AGENT_LIMITS, 1_000) || '',
      /工具调用次数/
    );
    assert.match(
      getAgentLimitReason({ usage: { totalTokens: 3_000 } }, DEFAULT_AGENT_LIMITS, 1_000) || '',
      /累计 Token/
    );
    assert.strictEqual(getAgentLimitReason({ agentTurns: 1, toolCallCount: 1 }, DEFAULT_AGENT_LIMITS, 1_000), undefined);
  });

  test('parses JSON operation arrays from text-compatible tool calls', () => {
    const content = '<Tool name="modify_file">\n'
      + '<parameter name="filepath">chapter.md</parameter>\n'
      + '<parameter name="operations">[{&quot;type&quot;:&quot;append&quot;,&quot;content&quot;:&quot;next&quot;}]</parameter>\n'
      + '</Tool>';
    const parsed = parseTextToolCalls(content, [modifyFileTool]);

    assert.ok(parsed);
    assert.strictEqual(parsed.toolCalls[0].name, 'modifyFile');
    assert.deepStrictEqual(parsed.toolCalls[0].args, {
      filepath: 'chapter.md',
      operations: [{ type: 'append', content: 'next' }],
    });
  });

  test('stops an exhausted tool but still produces a final answer from prior results', async () => {
    const searches: string[] = [];
    const invocationTools: string[][] = [];
    const invocationMessages: any[][] = [];
    const responses = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'searchWeb', args: { query: '听风术' } }],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_2', name: 'searchWeb', args: { query: '风角术' } },
          { id: 'call_3', name: 'searchWeb', args: { query: '乙巳占' } },
        ],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_4', name: 'searchWeb', args: { query: '候风法' } }],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      new AIMessage({
        content: '根据前三份资料整理出的正常回答',
        response_metadata: { finish_reason: 'stop' },
      }),
    ];
    const invoke = async (messages: any[], toolNames: string[]) => {
      invocationTools.push(toolNames);
      invocationMessages.push(messages);
      const response = responses.shift();
      assert.ok(response, 'model received an unexpected extra invocation');
      return response;
    };
    const modelFactory = (() => ({
      bind: ({ tools }: any) => ({
        invoke: (messages: any[]) => invoke(messages, tools.map((tool: any) => tool.function.name)),
      }),
      invoke: (messages: any[]) => invoke(messages, []),
    })) as any;
    const webSearchToolFactory = (() => [{
      name: 'searchWeb',
      description: 'search public sources',
      schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      maxCallsPerRequest: 3,
      func: async ({ query }: { query: string }) => {
        searches.push(query);
        return toolSuccess(`关于“${query}”的公开资料`);
      },
    }]) as any;
    const fileSystem = {} as any;
    const counter = new TokenCounter('gpt-4o-mini', 20);

    try {
      const graph = createWritingAssistantAgent(
        {
          ...DEFAULT_AI_CONFIG,
          apiKey: 'test',
          webSearch: { ...DEFAULT_AI_CONFIG.webSearch!, enabled: true, apiKey: 'tvly-test' },
        },
        fileSystem,
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
      const result = await graph.invoke(
        { messages: [new HumanMessage('读取资料后回答')] },
        { }
      );

      assert.deepStrictEqual(searches, ['听风术', '风角术', '乙巳占']);
      assert.strictEqual(invocationTools.length, 4);
      assert.ok(invocationTools[3].includes('modifyFile'));
      assert.ok(invocationTools[3].includes('createNewFile'));
      assert.ok(!invocationMessages[3].some(message => String(message.content).includes('必须立即基于对话中已有的工具结果回答用户')));
      const blockedResult = result.messages.find((message: any) =>
        message?._getType?.() === 'tool' && message.tool_call_id === 'call_4'
      );
      assert.ok(blockedResult, 'the rejected tool call must receive a matching ToolMessage');
      assert.match(String(blockedResult.content), /调用额度/);
      assert.strictEqual(result.messages[result.messages.length - 1].content, '根据前三份资料整理出的正常回答');
      assert.doesNotMatch(String(result.messages[result.messages.length - 1].content), /Agent 已停止/);
    } finally {
      counter.dispose();
    }
  });
});
