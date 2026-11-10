import * as assert from 'assert';
import { AIMessage, HumanMessage } from '../ai/messages';
import { createSpecialistTools } from '../workers/specialists';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { EvidenceLedger } from '../ai/tools/retrieval-evidence';
import { RequestTelemetry } from '../ai/runtime/request-telemetry';

const config = { ...DEFAULT_AI_CONFIG, apiKey: 'test', contextWindowSize: 100 };
const approver = { confirmFileWrite: async () => true };

suite('Workspace research specialist', () => {
  test('discovers files, reads in isolation, and sends only the evidence packet to the main agent', async () => {
    const operations: string[] = [];
    const essential = '弗洛里安先心疼勒内，再追问昨夜，最后决定让他离开。';
    const privateTail = '不应进入主 Agent 的无关正文。'.repeat(300);
    let researchTurns = 0;
    let mainTurns = 0;
    let packet = '';
    const telemetry = new RequestTelemetry('research-test');
    const fs: any = {
      listFiles: async () => { operations.push('list'); return { success: true, content: 'chapter.md\nsetting.md' }; },
      readFile: async (path: string) => { operations.push(`read:${path}`); return { success: true, content: path === 'chapter.md' ? essential + privateTail : '设定文件中的其他私有材料。' }; },
    };
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: fs, approver, rag: {} as any,
      agentFactory: ((...args: any[]) => {
        const options = args[12];
        args[9] = () => ({ bind: ({ tools: schemas }: any) => {
          const names = schemas.map((item: any) => item.function.name);
          assert.ok(names.includes('listFiles') && names.includes('searchFiles') && names.includes('searchInFiles') && names.includes('searchStory'));
          assert.ok(!names.includes('createNewFile') && !names.includes('modifyFile') && !names.includes('reviewWriting'));
          return { invoke: async (messages: any[]) => {
            researchTurns++;
            assert.ok(messages.some(message => String(message.content).includes('按情绪递进撰写下一章')));
            if (researchTurns === 1) {
              assert.ok(messages.some(message => String(message.content).includes('已知两人昨晚发生争执')));
              return new AIMessage({ content: '', tool_calls: [{ id: 'inventory', name: 'listFiles', args: { directory: '.' } }] });
            }
            if (researchTurns === 2) {
              assert.ok(messages.some(message => String(message.content).includes('setting.md')));
              return new AIMessage({ content: '', tool_calls: [
                { id: 'chapter', name: 'readFile', args: { filepath: 'chapter.md', maxChars: 30000 } },
                { id: 'setting', name: 'readFile', args: { filepath: 'setting.md' } },
              ] });
            }
            assert.ok(messages.some(message => String(message.content).includes(privateTail)));
            assert.ok(messages.some(message => String(message.content).includes('已到文件末尾')));
            const record = options.evidence.records.find((item: any) => item.filepath === 'chapter.md');
            packet = `任务结论：情绪递进是心疼、追问、决策。\n必要原文：\n[${record.id}｜${record.filepath}｜字符 ${record.start}～${essential.length}｜版本 ${record.version}]\n${essential}\n\n来源：chapter.md；覆盖：已读取两份文件。未核实问题：无。`;
            return new AIMessage(packet);
          } };
        }, invoke: async () => { throw new Error('unexpected finalizer'); } });
        return (createWritingAssistantAgent as any)(...args);
      }) as any });
    const mainFactory: any = () => ({ bind: () => ({ invoke: async (messages: any[]) => {
      if (++mainTurns === 1) { return new AIMessage({ content: '', tool_calls: [{ id: 'research', name: 'researchWorkspace', args: { task: '找情绪递进的原文依据', knownContext: '已知两人昨晚发生争执' } }] }); }
      const body = messages.map(message => String(message.content)).join('\n');
      assert.ok(body.includes(packet));
      assert.ok(!body.includes(privateTail));
      assert.ok(!body.includes('设定文件中的其他私有材料'));
      assert.ok(!body.includes('tool_call_id'));
      assert.ok(telemetry.evidence.records.every(record => record.filepath === 'chapter.md'));
      assert.strictEqual(telemetry.evidence.records[0].content, essential);
      return new AIMessage('根据原文情绪递进完成创作。');
    } }), invoke: async () => { throw new Error('unexpected main finalizer'); } });
    const graph = createWritingAssistantAgent(config, fs, approver, undefined, undefined, undefined, undefined, undefined, undefined,
      mainFactory, undefined, undefined, { additionalTools: tools });
    const result: any = await telemetry.run(() => graph.invoke({ messages: [new HumanMessage('按情绪递进撰写下一章')], workspacePath: 'workspace' }, { }));
    assert.deepStrictEqual(operations, ['list', 'read:chapter.md', 'read:setting.md']);
    assert.strictEqual(result.toolResults.length, 1);
    assert.strictEqual(result.toolResults[0].tool, 'researchWorkspace');
    assert.strictEqual(result.toolResults[0].result.data.sources.length, 1);
    assert.strictEqual(mainTurns, 2);
  });

  test('no-progress protection lets the read-only researcher finish its packet without pretending it can write', async () => {
    let turns = 0;
    let reads = 0;
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config,
      fileSystem: { readFile: async () => { reads++; return { success: true, content: '已有原文证据足够支持当前分析。'.repeat(10) }; } } as any,
      approver,
      agentFactory: ((...args: any[]) => {
        args[9] = () => ({ bind: () => ({ invoke: async () => {
          const turn = ++turns;
          return new AIMessage({ content: '', tool_calls: [{ id: `read-${turn}`, name: 'readFile', args: { filepath: 'chapter.md', offset: turn === 1 ? 0 : turn, maxChars: turn === 1 ? 1000 : 10 } }] });
        } }), invoke: async (messages: any[]) => {
          assert.ok(messages.some(message => String(message.content).includes('不要创作最终文章、写入文件')));
          assert.ok(!messages.some(message => String(message.content).includes('创作、专业审核及文件交付能力仍然可用')));
          return new AIMessage('结论：已有原文可以支持分析。来源：chapter.md。缺口：无新增证据。');
        } });
        return (createWritingAssistantAgent as any)(...args);
      }) as any });
    const result = await tools.find(tool => tool.name === 'researchWorkspace')!.func({ task: '核实人物背景' }, undefined, {
      agentInput: { originalRequest: '分析人物背景' }, evidence: new EvidenceLedger(),
    });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(reads, 3);
    assert.match(result.content, /来源：chapter.md/);
  });

  test('research failure returns an error and the main can still continue', async () => {
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => ({ invoke: async () => { throw new Error('检索模型暂不可用'); } })) as any });
    const result = await tools.find(tool => tool.name === 'researchWorkspace')!.func({ task: '搜集人物前情' }, undefined, {
      agentInput: { originalRequest: '根据人物前情写作' },
    });
    assert.strictEqual(result.status, 'error');
    assert.match(result.content, /检索模型暂不可用/);
  });

  test('research respects user cancellation without turning it into a completed packet', async () => {
    const controller = new AbortController();
    let invocations = 0;
    const tools = createSpecialistTools({ parserConfig: config, reviewConfig: config, fileSystem: {} as any, approver,
      agentFactory: (() => { invocations++; return { invoke: async () => ({ messages: [new AIMessage('不应返回')] }) }; }) as any });
    controller.abort();
    await assert.rejects(tools.find(tool => tool.name === 'researchWorkspace')!.func({ task: '读取资料' }, controller.signal, {
      agentInput: { originalRequest: '写作' },
    }), error => error instanceof Error && error.name === 'AbortError');
    assert.strictEqual(invocations, 0);
  });
});
