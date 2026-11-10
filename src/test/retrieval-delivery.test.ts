import * as assert from 'assert';
import { AIMessage, HumanMessage } from '../ai/messages';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { ToolDef, toolSuccess } from '../ai/tools/contract';

suite('Retrieval stop preserves delivery', () => {
  test('two rounds without new evidence stop reads but still allow review and a real file write', async () => {
    let turns = 0;
    let reads = 0;
    let reviews = 0;
    let writes = 0;
    const events: any[] = [];
    const review: ToolDef = { name: 'reviewWriting', description: 'review', schema: {
      type: 'object', properties: { task: { type: 'string' } }, required: ['task'],
    }, func: async () => { reviews++; return toolSuccess('已审核，可以交付。'); } };
    const factory: any = () => ({
      bind: ({ tools }: any) => {
        const names = tools.map((tool: any) => tool.function.name);
        return { invoke: async (messages: any[]) => {
          turns++;
          if (turns <= 3) {
            assert.ok(names.includes('readFile'));
            return new AIMessage({ content: '', tool_calls: [{ id: `read-${turns}`, name: 'readFile', args: {
              filepath: 'source.md', offset: turns === 1 ? 0 : turns, maxChars: turns === 1 ? 1000 : 10,
            } }] });
          }
          assert.ok(!names.includes('readFile') && !names.includes('searchInFiles') && !names.includes('searchFiles'));
          assert.ok(names.includes('reviewWriting') && names.includes('modifyFile') && names.includes('createNewFile'));
          assert.ok(messages.some(message => String(message.content).includes('创作、专业审核及文件交付能力仍然可用')));
          if (turns === 4) {
            return new AIMessage({ content: '', tool_calls: [
              { id: 'blocked-read', name: 'readFile', args: { filepath: 'source.md', offset: 4, maxChars: 10 } },
              { id: 'review', name: 'reviewWriting', args: { task: '审核新正文' } },
            ] });
          }
          if (turns === 5) {
            assert.ok(messages.some(message => String(message.content).includes('retrieval_stopped')));
            return new AIMessage({ content: '', tool_calls: [{ id: 'write', name: 'createNewFile', args: { filepath: 'chapter.md', content: '完成的新正文。' } }] });
          }
          return new AIMessage('正文已审核并保存到 chapter.md。');
        } };
      },
      invoke: async () => { throw new Error('must not enter the no-tool finalizer'); },
    });
    const fs: any = {
      validatePath: async (path: string) => ({ success: true, content: path }),
      fileExists: async (path: string) => path === 'source.md',
      readFile: async (path: string) => { if (path === 'source.md') { reads++; } return { success: true, content: '原文情绪循序渐进，心疼、追问与决策是连续的。'.repeat(5) }; },
      createFile: async (path: string, content: string) => {
        writes++; assert.strictEqual(path, 'chapter.md'); assert.strictEqual(content, '完成的新正文。');
        return { success: true, message: 'created' };
      },
    };
    const graph = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' }, fs,
      { confirmFileWrite: async () => true }, undefined, undefined, undefined, undefined, undefined, undefined,
      factory, undefined, { write: async (_root: any, _id: any, event: any) => { events.push(event); } }, { additionalTools: [review] });
    const result: any = await graph.invoke({ messages: [new HumanMessage('根据原文写作，审核后保存到 chapter.md')], requestId: 'delivery-test' }, { });
    assert.strictEqual(reads, 3);
    assert.strictEqual(reviews, 1);
    assert.strictEqual(writes, 1);
    assert.strictEqual(result.retrievalStopped, true);
    assert.strictEqual(result.finalizationReason, '');
    assert.ok(events.some(event => event.event === 'retrieval_stopped'));
    assert.match(String(result.messages.at(-1).content), /保存到 chapter.md/);
  });

  test('identical retrieval call limit stops retrieval without terminating file delivery', async () => {
    let turns = 0;
    let lists = 0;
    let writes = 0;
    const factory: any = () => ({ bind: () => ({ invoke: async () => {
      if (++turns <= 3) { return new AIMessage({ content: '', tool_calls: [{ id: `list-${turns}`, name: 'listFiles', args: { directory: '.' } }] }); }
      if (turns === 4) { return new AIMessage({ content: '', tool_calls: [{ id: 'write', name: 'createNewFile', args: { filepath: 'chapter.md', content: '新正文' } }] }); }
      return new AIMessage('已保存。');
    } }), invoke: async () => { throw new Error('must not finalize after repeated retrieval'); } });
    const graph = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' }, {
      listFiles: async () => { lists++; return { success: true, content: 'source.md' }; },
      validatePath: async (path: string) => ({ success: true, content: path }), fileExists: async () => false,
      createFile: async () => { writes++; return { success: true }; },
    } as any, { confirmFileWrite: async () => true }, undefined, undefined, undefined, undefined, undefined, undefined, factory);
    const result: any = await graph.invoke({ messages: [new HumanMessage('查找稿件并写新章节')] }, { });
    assert.strictEqual(lists, 2);
    assert.strictEqual(writes, 1);
    assert.strictEqual(result.finalizationReason, '');
  });
});
