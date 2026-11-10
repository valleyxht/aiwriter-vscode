import * as assert from 'assert';
import { AIMessage, AIMessageChunk, HumanMessage } from '../ai/messages';
import { createWritingAssistantAgent, DEFAULT_AGENT_LIMITS } from '../ai/runtime/agent';
import { VisibleTextStream } from '../ai/runtime/visible-text-stream';
import { ToolDef, toolSuccess } from '../ai/tools/contract';
import { TokenCounter } from '../memory/token-counter';
import { DEFAULT_AI_CONFIG } from '../types';

function tool(name: string, run: ToolDef['func']): ToolDef {
    return { name, description: name, schema: { type: 'object', properties: {} }, func: run };
}

async function runGraph(model: any, tools: ToolDef[], handler?: any, limits = DEFAULT_AGENT_LIMITS, signal?: AbortSignal) {
    const counter = new TokenCounter('', 100);
    try {
        const graph = createWritingAssistantAgent(
            { ...DEFAULT_AI_CONFIG, apiKey: 'test' }, {} as any, {} as any,
            handler, undefined, undefined, counter, limits, undefined,
            (() => ({ ...model, bind: () => model })) as any,
            undefined, { write: async () => {} } as any, { tools }
        );
        return await graph.invoke({ messages: [new HumanMessage('测试')] }, { signal });
    } finally { counter.dispose(); }
}

suite('Runtime latency and ordering', () => {
    test('delivers visible text before the provider produces its next chunk, without replay', async () => {
        const received: string[] = [];
        await runGraph({ stream: async function* () {
            yield new AIMessageChunk({ content: [{ type: 'reasoning', text: 'hidden' }] });
            assert.deepStrictEqual(received, []);
            yield new AIMessageChunk('第一段');
            assert.deepStrictEqual(received, ['第一段']);
            yield new AIMessageChunk('第二段');
        } }, [], { handleLLMNewToken: async (text: string) => received.push(text) });
        assert.strictEqual(received.join(''), '第一段第二段');
    });

    test('filters split XML calls while continuing to execute compatibility tools', async () => {
        const received: string[] = [];
        let turns = 0, executions = 0;
        await runGraph({ stream: async function* () {
            if (turns++ === 0) {
                for (const char of '<tool_calls><Tool name="listFiles"></Tool></tool_calls>') {
                    yield new AIMessageChunk(char);
                }
            } else { yield new AIMessageChunk('最终正文'); }
        } }, [tool('listFiles', async () => { executions++; return toolSuccess('资料'); })],
        { handleLLMNewToken: async (text: string) => received.push(text) });
        assert.strictEqual(executions, 1);
        assert.strictEqual(received.join(''), '最终正文');
    });

    test('keeps already displayed prose when a later chunk requests a native tool', async () => {
        const received: string[] = [];
        let turns = 0;
        await runGraph({ stream: async function* () {
            if (turns++ === 0) {
                yield new AIMessageChunk('先查资料。');
                yield new AIMessageChunk({ content: '', tool_call_chunks: [
                    { name: 'listFiles', id: 'native', index: 0, args: '{', type: 'tool_call_chunk' },
                ] });
                yield new AIMessageChunk({ content: '', tool_call_chunks: [
                    { index: 0, args: '}', type: 'tool_call_chunk' },
                ] });
            } else { yield new AIMessageChunk('最终正文'); }
        } }, [tool('listFiles', async () => toolSuccess('资料'))],
        { handleLLMNewToken: async (text: string) => received.push(text) });
        assert.strictEqual(received.join(''), '先查资料。\n\n最终正文');
    });

    test('preserves prose around split tool blocks and ordinary less-than characters', () => {
        const stream = new VisibleTextStream();
        let text = '';
        for (const char of '正文<Invoke name="readFile"><parameter>秘密参数</parameter></Invoke>继续，1 < 2 <') {
            text += stream.push(char);
        }
        text += stream.push('', true);
        assert.strictEqual(text, '正文继续，1 < 2 <');
    });

    test('bounds reads at three, preserves call order and places writes behind a barrier', async () => {
        let active = 0, peak = 0, reads = 0, turns = 0;
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const calls = ['readFile', 'listFiles', 'searchFiles', 'searchInFiles', 'modifyFile', 'readChapterSummary'];
        const tools = calls.map((name, index) => tool(name, async () => {
            if (name === 'modifyFile') {
                assert.strictEqual(active, 0);
                assert.strictEqual(reads, 4);
                events.push('write');
            } else {
                if (index === 5) { assert.ok(events.includes('write')); }
                peak = Math.max(peak, ++active);
                if (index < 3) {
                    if (active === 3) { release(); }
                    await gate;
                    // Complete the first batch in reverse order.
                    await new Promise(resolve => setTimeout(resolve, (3 - index) * 5));
                }
                active--; reads++;
            }
            return toolSuccess(`result-${index}`);
        }));
        const result = await runGraph({ invoke: async () => turns++ === 0
            ? new AIMessage({ content: '', tool_calls: calls.map((name, index) => ({ name, id: String(index), args: {} })) })
            : new AIMessage('完成') }, tools);
        assert.strictEqual(peak, 3);
        assert.deepStrictEqual(result.toolResults.map((item: any) => item.result.content), calls.map((_, index) => `result-${index}`));
        assert.deepStrictEqual(result.messages.filter((message: any) => message._getType() === 'tool')
            .map((message: any) => message.tool_call_id), calls.map((_, index) => String(index)));
    });

    test('reserves duplicate and total quotas before starting parallel reads', async () => {
        let executions = 0, turns = 0;
        const result = await runGraph({ invoke: async () => turns++ === 0
            ? new AIMessage({ content: '', tool_calls: [0, 1, 2, 3].map(index => ({ name: 'listFiles', id: String(index), args: {} })) })
            : new AIMessage('完成') }, [tool('listFiles', async () => { executions++; return toolSuccess('资料'); })],
        undefined, { ...DEFAULT_AGENT_LIMITS, maxToolCalls: 3, maxRepeatedToolCalls: 1 });
        assert.strictEqual(executions, 1);
        assert.strictEqual(result.messages.filter((message: any) => message._getType() === 'tool').length, 4);
    });

    test('one failed read does not discard successful siblings', async () => {
        let turns = 0;
        const result = await runGraph({ invoke: async () => turns++ === 0
            ? new AIMessage({ content: '', tool_calls: ['readFile', 'listFiles'].map(name => ({ name, id: name, args: {} })) })
            : new AIMessage('完成') }, [
            tool('readFile', async () => { throw new Error('read failed'); }),
            tool('listFiles', async () => toolSuccess('保留资料')),
        ]);
        assert.deepStrictEqual(result.toolResults.map((item: any) => item.result.status), ['error', 'success']);
    });

    test('joins cancelled reads and never starts the following write', async () => {
        const controller = new AbortController();
        let active = 0, writes = 0;
        const tools = ['readFile', 'listFiles', 'searchFiles'].map(name => tool(name, async () => {
            active++;
            try {
                if (active === 3) { controller.abort(); }
                await new Promise(resolve => setTimeout(resolve, 5));
                return toolSuccess('资料');
            } finally { active--; }
        }));
        tools.push(tool('modifyFile', async () => { writes++; return toolSuccess('写入'); }));
        await assert.rejects(runGraph({ invoke: async () => new AIMessage({ content: '',
            tool_calls: tools.map(({ name }) => ({ name, id: name, args: {} })),
        }) }, tools, undefined, DEFAULT_AGENT_LIMITS, controller.signal), { name: 'AbortError' });
        assert.strictEqual(active, 0);
        assert.strictEqual(writes, 0);
    });
});
