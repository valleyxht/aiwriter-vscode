import * as assert from 'assert';
import { AIMessage, HumanMessage, ToolMessage } from '../ai/messages';
import { decodeToolArguments, defineTool, executeTool, toolSuccess, toolError, toolRejected, toolResultMessage } from '../ai/tools/contract';
import { createFileTools, createReadOnlyFileTools, createRagTools } from '../ai/tools';
import { collectNormalizedEvidence, projectMessagesWithNormalizedEvidence } from '../ai/runtime/evidence-normalizer';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';

suite('Unified tool contract', () => {
  test('does not repair truncated JSON or turn invalid parameters into an empty call', async () => {
    let calls = 0;
    const tool = defineTool({ name: 'write', description: '', schema: { type: 'object', properties: {} },
      func: async () => { calls++; return toolSuccess('done'); } });
    for (const raw of ['{"content":"truncated', '', 'null', '[]', '42']) {
      assert.strictEqual((await executeTool(tool, decodeToolArguments(raw))).code, 'invalid_arguments');
    }
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(decodeToolArguments('{"content":"\\ntext\\n"}'), { content: '\ntext\n' });
  });

  test('rejects invalid nested arguments before any file or approval access', async () => {
    let accesses = 0;
    const unexpected = async () => { accesses++; throw new Error('must not execute'); };
    const tools = createFileTools({ validatePath: unexpected, readFile: unexpected } as any,
      { confirmFileWrite: unexpected } as any);
    const modify = tools.find(tool => tool.name === 'modifyFile')!;
    const invalid = [
      { filepath: 123, operations: [{ type: 'append', content: 'text' }] },
      { filepath: 'a.md', operations: [{ type: 'append' }] },
      { filepath: 'a.md', operations: [{ type: 'replace', oldText: 'a' }] },
      { filepath: 'a.md', operations: [{ type: 'replace', oldText: 'a', newText: '', replaceAll: 'false' }] },
      { filepath: 'a.md', operations: [{ type: 'append', content: 'x', extra: true }] },
      { filepath: 'a.md', operations: [], unexpected: 'secret-value' },
      { filepath: '   ', operations: [{ type: 'append', content: 'x' }] },
      [], null,
    ];
    for (const args of invalid) {
      const result = await executeTool(modify, args);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.code, 'invalid_arguments');
      assert.ok(!result.content.includes('secret-value'));
    }
    assert.strictEqual(accesses, 0);
  });

  test('validates read bounds and required arguments on direct calls too', async () => {
    let reads = 0;
    const tools = createReadOnlyFileTools({ readFile: async () => { reads++; return { success: true, content: 'text' }; } } as any);
    const read = tools.find(tool => tool.name === 'readFile')!;
    for (const args of [{ filepath: 'a.md', offset: -1 }, { filepath: 'a.md', offset: 1.5 },
      { filepath: 'a.md', maxChars: 30001 }, { filepath: 'a.md', maxChars: '10' }, { path: 'a.md' }]) {
      assert.strictEqual((await read.func(args)).code, 'invalid_arguments');
    }
    assert.strictEqual(reads, 0);
  });

  test('keeps content, rejection, conflict and unavailable states independent of wording', async () => {
    const text = '读取失败: 这是正文中的一句话。';
    const read = createReadOnlyFileTools({ readFile: async () => ({ success: true, content: text }) } as any)[0];
    const result = await read.func({ filepath: 'a.md' });
    assert.strictEqual(result.status, 'success');
    assert.ok(result.content.endsWith(text));
    let writes = 0;
    const fileSystem = { validatePath: async () => ({ success: true, content: 'a.md' }),
      fileExists: async () => false, createFile: async () => { writes++; return { success: true }; } } as any;
    const create = createFileTools(fileSystem, { confirmFileWrite: async () => false } as any)
      .find(tool => tool.name === 'createNewFile')!;
    assert.strictEqual((await create.func({ filepath: 'a.md', content: 'text' })).status, 'rejected');
    fileSystem.fileExists = async () => true;
    assert.strictEqual((await create.func({ filepath: 'a.md', content: 'text' })).code, 'file_exists');
    assert.strictEqual(writes, 0);
    const rag = createRagTools({ isReady: false } as any)[0];
    assert.strictEqual((await rag.func({ query: 'person', purpose: 'context' })).code, 'rag_unavailable');
  });

  test('preserves file content whitespace after validation', async () => {
    let written: string | undefined;
    const create = createFileTools({ validatePath: async () => ({ success: true, content: 'a.md' }),
      fileExists: async () => false, createFile: async (_path: string, content: string) => {
        written = content; return { success: true };
      } } as any, { confirmFileWrite: async () => true } as any).find(tool => tool.name === 'createNewFile')!;
    assert.strictEqual((await create.func({ filepath: 'a.md', content: '\n  正文。\n' })).status, 'success');
    assert.strictEqual(written, '\n  正文。\n');
  });

  test('converts execution errors without retrying and propagates cancellation', async () => {
    let calls = 0;
    const tool = defineTool({ name: 'test', description: '', schema: { type: 'object', properties: {} },
      func: async () => { calls++; throw new Error('disk failed'); } });
    assert.strictEqual((await tool.func({})).code, 'tool_execution_failed');
    assert.strictEqual(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => tool.func({}, controller.signal), { name: 'AbortError' });
    assert.strictEqual(calls, 1);
    const aborted = defineTool({ ...tool, func: async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; } });
    await assert.rejects(() => aborted.func({}), { name: 'AbortError' });
  });

  test('fails closed for old string results instead of guessing their status', async () => {
    const tool = defineTool({ name: 'legacy', description: '', schema: { type: 'object', properties: {} },
      func: async () => '成功' } as any);
    assert.strictEqual((await tool.func({})).code, 'invalid_tool_result');
  });

  test('keeps failures available to the model but out of normalized evidence', () => {
    const messages = [new HumanMessage('read'), new AIMessage({ content: '', tool_calls: [
      { id: 'a', name: 'readFile', args: { filepath: 'a.md' } },
      { id: 'b', name: 'readFile', args: { filepath: 'b.md' } },
      { id: 'c', name: 'modifyFile', args: {} },
    ] }), toolResultMessage(toolSuccess('读取失败: 真实的原文'), 'a'),
      toolResultMessage(toolError('read_failed', '文件不可读'), 'b'),
      toolResultMessage(toolRejected('user_rejected', '用户取消了写入'), 'c')];
    const evidence = collectNormalizedEvidence(messages);
    assert.strictEqual(evidence.length, 1);
    assert.strictEqual(evidence[0].content, '读取失败: 真实的原文');
    const projected = projectMessagesWithNormalizedEvidence(messages);
    assert.ok(!projected.some(message => ToolMessage.isInstance(message)));
    assert.ok(projected.some(message => String(message.content).includes('error:read_failed')));
    assert.ok(projected.some(message => String(message.content).includes('rejected:user_rejected')));
  });

  test('main graph rejects malformed calls and supplies machine-readable error feedback', async () => {
    let reads = 0;
    let observed = false;
    const replies = [new AIMessage({ content: '', tool_calls: [
      { id: 'invalid', name: 'readFile', args: { filepath: 42 } },
    ] }), new AIMessage('参数有误，未执行读取。')];
    const invoke = async (messages: any[]) => {
      if (replies.length === 1) {
        const feedback = messages.find(message => ToolMessage.isInstance(message));
        assert.ok(feedback);
        assert.strictEqual(feedback.status, 'error');
        assert.strictEqual(feedback.artifact.code, 'invalid_arguments');
        observed = true;
      }
      return replies.shift()!;
    };
    const factory = (() => ({ bind: () => ({ invoke }), invoke })) as any;
    const graph = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' },
      { readFile: async () => { reads++; } } as any, {} as any,
      undefined, undefined, undefined, undefined, undefined, undefined, factory);
    const result = await graph.invoke({ messages: [new HumanMessage('读取文件')] });
    assert.ok(observed);
    assert.strictEqual(reads, 0);
    assert.strictEqual(result.toolResults[0].result.status, 'error');
  });
});
