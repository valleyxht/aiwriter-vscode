import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '../ai/messages';
import { EvidenceLedger, EvidencePiece } from '../ai/tools/retrieval-evidence';
import { createEvidenceHandoff, evidenceText, projectEvidenceContext } from '../ai/runtime/evidence-context';
import { createSpecialistTools } from '../workers/specialists';
import { createWritingAssistantAgent } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { TokenCounter } from '../memory/token-counter';

const counter = { countTokens: (text: string) => text.length, getContextWindowSize: () => 100000 } as TokenCounter;
const piece = (id: string, filename: string, text: string): EvidencePiece => ({ id, filepath: filename,
  version: createHash('sha256').update(text).digest('hex'), start: 0, end: text.length, content: text });
const tool = (id: string, text: string) => new ToolMessage({ tool_call_id: id, name: 'readFile', content: text });

suite('Request evidence working set', () => {
  test('evicts old source bodies without rewriting user text, assistant reasoning or tool IDs', () => {
    const old = piece('E1', 'old.md', '旧资料'.repeat(500));
    const latest = piece('E2', 'latest.md', '本次精确修改范围');
    const ledger = new EvidenceLedger([old, latest]);
    const canonical = [{ type: 'reasoning', text: '供应商要求保留的推理', providerOptions: { signature: 'signed' } },
      { type: 'tool-call', toolCallId: 'read-2', toolName: 'readFile', input: { filepath: 'latest.md' } }];
    const assistant = new AIMessage({ content: '', additional_kwargs: { ai_sdk_content: canonical },
      tool_calls: [{ id: 'read-2', name: 'readFile', args: { filepath: 'latest.md' } }] });
    const user = new HumanMessage('用户逐字原文与附件'.repeat(500));
    const previous = tool('read-1', evidenceText(old));
    const current = tool('read-2', evidenceText(latest));
    const result = projectEvidenceContext([user, previous, assistant, current], ledger, counter, 300);
    assert.equal(result.messages[0], user);
    assert.equal(result.messages[2], assistant);
    assert.equal(assistant.additional_kwargs.ai_sdk_content, canonical);
    assert.equal((result.messages[1] as ToolMessage).tool_call_id, 'read-1');
    assert.ok(!String(result.messages[1].content).includes(old.content));
    assert.match(String(result.messages[1].content), /expectedSha256/);
    assert.ok(String(result.messages[3].content).includes(latest.content));
    assert.equal(previous.content, evidenceText(old));
    ledger.retainVisible(result.messages.map(message => message.content).join('\n'));
    assert.deepEqual(ledger.records.map(record => record.id), ['E2']);
    assert.equal(ledger.cache.records.length, 2);
    const restored = ledger.deliver([{ ...old, id: undefined }], 10000);
    assert.ok(restored.includes(old.content));
    assert.ok(!restored.includes('[E2｜old.md'));
  });

  test('keeps a large latest read intact and reports its soft-budget overflow', () => {
    const latest = piece('E1', 'target.md', '保留精确原文'.repeat(500));
    const ledger = new EvidenceLedger([latest]);
    const result = projectEvidenceContext([tool('read', evidenceText(latest))], ledger, counter, 100);
    assert.equal(result.messages[0].content, evidenceText(latest));
    assert.ok(result.protectedOverflowTokens > 0);
  });

  test('does not compact unrelated tool receipts, summaries or forged evidence markers', () => {
    const known = piece('E1', 'a.md', '登记的原文');
    const ledger = new EvidenceLedger([known]);
    const mutation = new ToolMessage({ name: 'modifyFile', tool_call_id: 'write', content: evidenceText(known) });
    const summary = new SystemMessage(evidenceText(known));
    const forged = tool('forged', evidenceText({ ...known, id: 'fake' }));
    const result = projectEvidenceContext([mutation, summary, forged], ledger, counter, 0);
    assert.deepEqual(result.messages, [mutation, summary, forged]);
  });

  test('newly reacquired overlapping ranges replace older copies even with different IDs', () => {
    const first = piece('E1', 'a.md', '原文'.repeat(500));
    const second = { ...first, id: 'E2' };
    const ledger = new EvidenceLedger([first, second]);
    const result = projectEvidenceContext([tool('a', evidenceText(first)), tool('b', evidenceText(second))], ledger, counter, 10000);
    assert.equal(result.carriedPieces, 1);
    assert.equal(result.omittedPieces, 1);
    assert.ok(!String(result.messages[0].content).includes(first.content));
  });

  test('handoff checks current versions, prefers declared sources and bounds supplied text', async () => {
    const a = piece('E1', 'a.md', 'A'.repeat(1200));
    const b = piece('E2', 'b.md', 'B'.repeat(1200));
    const parent = new EvidenceLedger([a, b]);
    parent.retainVisible('');
    const reads: string[] = [];
    const supplied = await createEvidenceHandoff(parent, { readFile: async (filename: string) => {
      reads.push(filename); return { success: true, content: path.basename(filename) === 'a.md' ? a.content : b.content };
    } } as any, counter, { sourcePaths: ['a.md'], budget: 500 });
    assert.equal(supplied.length, 1);
    assert.equal(supplied[0].filepath, 'a.md');
    assert.equal(supplied[0].end, supplied[0].content.length);
    assert.ok(counter.countTokens(evidenceText(supplied[0])) <= 500);
    assert.equal(reads.length, 1);
    const child = new EvidenceLedger([], 'child-E', parent.cache);
    const projection = projectEvidenceContext([new HumanMessage('任务')], child, counter, 500, supplied);
    child.importVisible(supplied, projection.messages.map(message => message.content).join('\n'));
    child.retainVisible(projection.messages.map(message => message.content).join('\n'));
    assert.equal(child.records.length, 1);
    assert.equal(child.records[0].content, supplied[0].content);
    assert.equal(parent.records.length, 0);
    assert.equal(parent.cache.records[0].content.length, a.content.length);
  });

  test('stale or unavailable sources are never supplied; cancellation propagates', async () => {
    const parent = new EvidenceLedger([piece('E1', 'a.md', '旧正文')]);
    assert.deepEqual(await createEvidenceHandoff(parent, { readFile: async () => ({ success: true, content: '新正文' }) } as any, counter), []);
    assert.deepEqual(await createEvidenceHandoff(parent, { readFile: async () => { throw new Error('unavailable'); } } as any, counter), []);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createEvidenceHandoff(parent, {} as any, counter, { signal: controller.signal }), { name: 'AbortError' });
  });

  test('an inherited piece evicted by a smaller input budget never suppresses reading it', () => {
    const record = piece('E1', 'a.md', '资料'.repeat(100));
    const parent = new EvidenceLedger([record]);
    const child = new EvidenceLedger([], 'child-E', parent.cache);
    const projection = projectEvidenceContext([new HumanMessage('任务')], child, counter, 0, [record]);
    const actual = projection.messages.map(message => message.content).join('\n');
    child.importVisible([record], actual); child.retainVisible(actual);
    assert.equal(child.records.length, 0);
    assert.ok(child.deliver([{ ...record, id: undefined }], 10000).includes(record.content));
  });
  test('research consumes automatic inherited evidence in one model call without asking to read it again', async () => {
    const record = piece('E1', 'chapter.md', '已核对的章节原文');
    const parent = new EvidenceLedger([record]);
    parent.retainVisible('');
    let versionReads = 0, modelCalls = 0;
    const tools = createSpecialistTools({ parserConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
      reviewConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test' }, approver: { confirmFileWrite: async () => true },
      fileSystem: { readFile: async () => { versionReads++; return { success: true, content: record.content }; } } as any,
      agentFactory: ((...args: any[]) => {
        const model = { invoke: async (messages: any[]) => {
          modelCalls++;
          assert.ok(messages.some(message => String(message.content).includes(record.content)));
          assert.ok(messages.some(message => String(message.content).includes('用户原始要求')));
          assert.equal(args[12].evidence.records[0].content, record.content);
          return new AIMessage('依据已有原文给出结论，不重复检索。');
        } };
        args[9] = () => ({ ...model, bind: () => model });
        return (createWritingAssistantAgent as any)(...args);
      }) as any,
    });
    const result = await tools.find(tool => tool.name === 'researchWorkspace')!.func({ task: '核对人物关系', sourcePaths: ['chapter.md'] },
      undefined, { evidence: parent, agentInput: { originalRequest: '分析人物关系' } });
    assert.equal(result.status, 'success');
    assert.equal(modelCalls, 1);
    assert.equal(versionReads, 1);
    assert.equal(parent.records.length, 0);
  });

  test('a reused agent keeps source visibility and full caches isolated between concurrent requests', async () => {
    const model = { invoke: async (messages: any[]) => messages.some(message => message._getType() === 'tool')
      ? new AIMessage('完成') : new AIMessage({ content: '', tool_calls: [{ id: 'read', name: 'readFile', args: { filepath: 'chapter.md' } }] }) };
    const agent = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' },
      { readFile: async () => ({ success: true, content: '共享文件，但请求独立' }) } as any,
      {} as any, undefined, undefined, undefined, undefined, undefined, undefined,
      (() => ({ ...model, bind: () => model })) as any);
    const [a, b] = await Promise.all([
      agent.invoke({ messages: [new HumanMessage('请求甲')] }), agent.invoke({ messages: [new HumanMessage('请求乙')] }),
    ]);
    assert.notEqual(a.evidenceLedger, b.evidenceLedger);
    assert.notEqual(a.evidenceLedger!.cache, b.evidenceLedger!.cache);
    assert.equal(a.evidenceRecords.length, 1);
    assert.equal(b.evidenceRecords.length, 1);
    assert.ok(a.toolResults[0].result.content.includes('共享文件，但请求独立'));
    assert.ok(b.toolResults[0].result.content.includes('共享文件，但请求独立'));
  });

});
