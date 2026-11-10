import * as assert from 'assert';
import { AIMessage, HumanMessage } from '../ai/messages';
import { createSpecialistTools } from '../workers/specialists';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { EvidenceLedger } from '../ai/tools/retrieval-evidence';
import { collectFileMutationSummaries } from '../ai/runtime/file-mutations';
import { AIManager } from '../ai/manager';

const config = { ...DEFAULT_AI_CONFIG, apiKey: 'test', contextWindowSize: 100 };
const approver = { confirmFileWrite: async () => true };

suite('Optional specialist agents', () => {
  test('specialist can read original prose, preserves the raw request and cannot write', async () => {
    let turns = 0;
    let reads = 0;
    let names: string[] = [];
    const raw = '改第十九章：保留心疼、追问、决策的情绪递进。';
    const factory: any = () => ({
      bind: ({ tools }: any) => {
        names = tools.map((item: any) => item.function.name);
        return { invoke: async (messages: any[]) => {
          assert.ok(messages.some(m => String(m.content).includes(raw)));
          assert.strictEqual(messages.filter(m => String(m.content).includes('用户提供的设计')).length, 1);
          if (++turns === 1) {
            return new AIMessage({ content: '', tool_calls: [{ id: 'read', name: 'readFile', args: { filepath: 'chapter.md' } }] });
          }
          assert.ok(messages.some(m => String(m.content).includes('原文：弗洛里安心疼勒内')));
          return new AIMessage('拆解：心疼后追问，充分对话后决定让他离开。');
        } };
      },
      invoke: async () => new AIMessage('unused'),
    });
    const tools = createSpecialistTools({
      parserConfig: config, reviewConfig: config,
      fileSystem: { readFile: async () => { reads++; return { success: true, content: '原文：弗洛里安心疼勒内', message: '' }; } } as any,
      approver,
      agentFactory: ((...args: any[]) => {
        args[9] = factory;
        return (createWritingAssistantAgent as any)(...args);
      }) as any,
    });
    const mainEvidence = new EvidenceLedger();
    const result = await tools[0].func({ task: '拆解情绪场景', sourcePaths: ['chapter.md'] }, undefined, {
      evidence: mainEvidence, agentInput: { originalRequest: raw, suppliedContext: '用户提供的设计' },
    });
    assert.strictEqual(result.status, 'success');
    assert.match(result.content, /充分对话/);
    assert.strictEqual(reads, 1);
    assert.ok(names.includes('readFile'));
    assert.ok(!names.includes('modifyFile') && !names.includes('createNewFile'));
    assert.ok(!names.includes('reviewWriting') && !names.includes('decomposeScene'));
    assert.strictEqual(mainEvidence.records.length, 0);
  });

  test('review edits an existing file through approval and the shared transaction, then returns the actual write to main', async () => {
    let text = '原文情绪太快。';
    let reviewTurns = 0;
    let mainTurns = 0;
    let approvals = 0;
    const transactions: string[] = [];
    const fs: any = {
      validatePath: async (path: string) => ({ success: true, content: path }),
      fileExists: async () => true,
      readFile: async () => ({ success: true, content: text }),
      editFile: async (_path: string, content: string) => { text = content; return { success: true, message: 'edited' }; },
    };
    const approval = { confirmFileWrite: async (_path: string, _mode: string, _old: string, _next: string, _signal: any, context: any) => {
      approvals++; assert.strictEqual(context.requestId, 'review-request'); return true;
    } };
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: fs, approver: approval,
      transactionManager: { executeWrite: async (id: string, _path: string, _content: string, write: any) => { transactions.push(id); return write(); } } as any,
      agentFactory: ((...args: any[]) => {
        args[9] = () => ({ bind: ({ tools: schemas }: any) => {
          const names = schemas.map((tool: any) => tool.function.name);
          assert.ok(names.includes('modifyFile') && names.includes('createNewFile'));
          return { invoke: async (messages: any[]) => {
            if (++reviewTurns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'read-review', name: 'readFile', args: { filepath: 'chapter.md' } }] }); }
            if (reviewTurns === 2) {
              assert.ok(messages.some(message => String(message.content).includes('原文情绪太快。')));
              return new AIMessage({ content: '', tool_calls: [{ id: 'edit-review', name: 'modifyFile', args: { filepath: 'chapter.md', operations: [{ type: 'replace', oldText: '原文情绪太快。', newText: '情绪循序渐进。' }] } }] });
            }
            return new AIMessage('已修订 chapter.md 的情绪递进。');
          } };
        }, invoke: async () => new AIMessage('unused') });
        return (createWritingAssistantAgent as any)(...args);
      }) as any });
    const mainModel: any = () => ({ bind: () => ({ invoke: async (messages: any[]) => {
      if (++mainTurns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'delegate-review', name: 'reviewWriting', args: { task: '检查并直接修订情绪递进', filepath: 'chapter.md' } }] }); }
      assert.ok(messages.some(message => String(message.content).includes('以上写入已执行')));
      return new AIMessage('审核已完成并修改文件。');
    } }), invoke: async () => new AIMessage('unused') });
    const graph = createWritingAssistantAgent(config, fs, approval, undefined, undefined, undefined, undefined, undefined, undefined,
      mainModel, undefined, undefined, { additionalTools: tools });
    const result: any = await graph.invoke({ messages: [new HumanMessage('审核并修改 chapter.md 的情绪递进')] }, { metadata: { requestId: 'review-request' } });
    assert.strictEqual(text, '情绪循序渐进。');
    assert.strictEqual(approvals, 1);
    assert.deepStrictEqual(transactions, ['review-request']);
    const mutations = collectFileMutationSummaries(result.toolResults);
    assert.strictEqual(mutations.length, 1);
    assert.strictEqual(mutations[0].tool, 'modifyFile');
    assert.strictEqual(mutations[0].filepath, 'chapter.md');
    assert.strictEqual(mutations[0].changed, true);
  });

  test('review respects rejected file changes', async () => {
    let turns = 0;
    let writes = 0;
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config,
      fileSystem: { validatePath: async (path: string) => ({ success: true, content: path }), fileExists: async () => false,
        createFile: async () => { writes++; return { success: true }; } } as any,
      approver: { confirmFileWrite: async () => false },
      agentFactory: ((...args: any[]) => {
        args[9] = () => ({ bind: () => ({ invoke: async (messages: any[]) => {
          if (++turns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'rejected-review', name: 'createNewFile', args: { filepath: 'chapter.md', content: '拟写正文' } }] }); }
          assert.ok(messages.some(message => String(message.content).includes('user_rejected')));
          return new AIMessage('用户拒绝了写入，文件未修改。');
        } }), invoke: async () => new AIMessage('unused') });
        return (createWritingAssistantAgent as any)(...args);
      }) as any });
    const mutations: unknown[] = [];
    const result = await tools[1].func({ task: '审核并写入', filepath: 'chapter.md', proposedText: '拟写正文' }, undefined, {
      agentInput: { originalRequest: '审核后创建 chapter.md' }, onFileMutation: mutation => mutations.push(mutation),
    });
    assert.strictEqual(writes, 0);
    assert.strictEqual(mutations.length, 0);
    assert.match(result.content, /拒绝了写入/);
    assert.deepStrictEqual((result.data as any).fileMutations, []);
  });

  test('main agent can skip specialists and write directly', async () => {
    let turns = 0;
    let writes = 0;
    let specialistCalls = 0;
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => { specialistCalls++; throw new Error('must not run'); }) as any });
    const model: any = () => ({ bind: ({ tools: schemas }: any) => {
      const names = schemas.map((s: any) => s.function.name);
      assert.ok(names.includes('decomposeScene') && names.includes('reviewWriting'));
      assert.ok(names.includes('createNewFile') && !names.includes('submitNovelDraft'));
      return { invoke: async () => ++turns === 1
        ? new AIMessage({ content: '', tool_calls: [{ id: 'write', name: 'createNewFile', args: { filepath: 'chapter.md', content: '新正文' } }] })
        : new AIMessage('已创建。') };
    }, invoke: async () => new AIMessage('unused') });
    const fs: any = { validatePath: async (path: string) => ({ success: true, content: path }), fileExists: async () => false,
      createFile: async () => { writes++; return { success: true, message: 'created' }; } };
    const graph = createWritingAssistantAgent(config, fs, approver, undefined, undefined, undefined, undefined, undefined, undefined,
      model, undefined, undefined, { additionalTools: tools });
    await graph.invoke({ messages: [new HumanMessage('创建 chapter.md 并写正文')] }, { });
    assert.strictEqual(writes, 1);
    assert.strictEqual(specialistCalls, 0);
  });

  test('main resumes after specialist failure and can finish the requested write', async () => {
    let turns = 0;
    let writes = 0;
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => ({ invoke: async () => { throw new Error('provider unavailable'); } })) as any });
    const model: any = () => ({ bind: () => ({ invoke: async (messages: any[]) => {
      turns++;
      if (turns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'review', name: 'reviewWriting', args: { task: '审核', proposedText: '新正文' } }] }); }
      if (turns === 2) {
        assert.ok(messages.some(m => String(m.content).includes('provider unavailable')));
        return new AIMessage({ content: '', tool_calls: [{ id: 'write', name: 'createNewFile', args: { filepath: 'chapter.md', content: '新正文' } }] });
      }
      return new AIMessage('审核服务不可用，已根据原始要求完成正文并写入。');
    } }), invoke: async () => new AIMessage('unused') });
    const fs: any = { validatePath: async (path: string) => ({ success: true, content: path }), fileExists: async () => false,
      createFile: async () => { writes++; return { success: true, message: 'created' }; } };
    const graph = createWritingAssistantAgent(config, fs, approver, undefined, undefined, undefined, undefined, undefined, undefined,
      model, undefined, undefined, { additionalTools: tools });
    const result: any = await graph.invoke({ messages: [new HumanMessage('写入 chapter.md，可审核')] }, { });
    assert.strictEqual(writes, 1);
    assert.match(String(result.messages.at(-1).content), /审核服务不可用/);
  });

  test('complete candidate reaches review before the main performs the only write', async () => {
    const events: string[] = [];
    let turns = 0;
    const candidate = '完整正文开头。' + '中段情绪递进。'.repeat(200) + '结尾决策。';
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => ({ invoke: async (state: any) => {
        events.push('review');
        assert.ok(String(state.messages[0].content).includes(candidate));
        return { messages: [new AIMessage('审核完成，可以写入。')] };
      } })) as any });
    const model: any = () => ({ bind: () => ({ invoke: async () => {
      if (++turns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'review', name: 'reviewWriting', args: { task: '检查情绪递进', proposedText: candidate } }] }); }
      if (turns === 2) { return new AIMessage({ content: '', tool_calls: [{ id: 'write', name: 'createNewFile', args: { filepath: 'chapter.md', content: candidate } }] }); }
      return new AIMessage('已审核并写入。');
    } }), invoke: async () => new AIMessage('unused') });
    const fs: any = { validatePath: async (path: string) => ({ success: true, content: path }), fileExists: async () => false,
      createFile: async (_path: string, text: string) => { events.push('write'); assert.strictEqual(text, candidate); return { success: true, message: 'created' }; } };
    const graph = createWritingAssistantAgent(config, fs, approver, undefined, undefined, undefined, undefined, undefined, undefined,
      model, undefined, undefined, { additionalTools: tools });
    await graph.invoke({ messages: [new HumanMessage('先审核再写入 chapter.md')] }, { });
    assert.deepStrictEqual(events, ['review', 'write']);
  });

  test('over-budget review fails visibly without sending a clipped candidate to the model', async () => {
    let modelCalls = 0;
    const smallConfig = { ...config, contextWindowSize: 20 };
    const tools = createSpecialistTools({ parserConfig: smallConfig, reviewConfig: smallConfig, fileSystem: {} as any, approver,
      agentFactory: ((...args: any[]) => {
        args[9] = () => ({ bind: () => ({ invoke: async () => { modelCalls++; return new AIMessage('不应被调用'); } }), invoke: async () => new AIMessage('unused') });
        return (createWritingAssistantAgent as any)(...args);
      }) as any });
    const result = await tools[1].func({ task: '审核整篇', proposedText: '原文完整内容'.repeat(20_000) }, undefined, {
      agentInput: { originalRequest: '审核完整章节，不可使用样本' },
    });
    assert.strictEqual(result.status, 'error');
    assert.match(result.content, /超过上下文预算/);
    assert.strictEqual(modelCalls, 0);
  });

  test('partial provider output is not returned as completed review', async () => {
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => ({ invoke: async () => ({ messages: [new AIMessage({ content: '只有开头的修订', response_metadata: { finish_reason: 'length' } })] }) })) as any });
    const result = await tools[1].func({ task: '返回完整修订', proposedText: '原始完整正文' }, undefined, {
      agentInput: { originalRequest: '修订后写入文件' },
    });
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.code, 'specialist_incomplete');
  });

  test('disabling iceberg decomposition leaves review independently available', () => {
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver, enableDecomposition: false });
    assert.deepStrictEqual(tools.map(tool => tool.name), ['reviewWriting', 'researchWorkspace']);
  });

  test('manager forwards raw request and selected context once without an automatic output processor', async () => {
    const manager = Object.create(AIManager.prototype) as any;
    manager._activeRequests = new Map();
    manager._prepareProjectMemoryForTurn = async () => undefined;
    manager._projectMemory = { currentContent: '项目说明', refreshExisting: async () => undefined };
    manager.getWorkspacePath = () => 'workspace';
    manager._releaseRequest = () => undefined;
    manager._engine = { getHistory: () => [], sendMessage: async (...args: any[]) => {
      assert.strictEqual(args[0], '用户原始要求');
      assert.match(args[1], /选中文本/);
      assert.strictEqual(args[3].projectMemory, '项目说明');
      return { success: true, content: '完成' };
    } };
    const result = await manager.sendMessage('用户原始要求', [{ displayName: 'chapter.md', contents: '选中文本' }]);
    assert.strictEqual(result.success, true);
  });
});
