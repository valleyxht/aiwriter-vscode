import * as assert from 'assert';
import { AIMessage, HumanMessage } from '../ai/messages';
import { createWritingAssistantAgent, DEFAULT_AGENT_LIMITS, type AgentState } from '../ai/runtime/agent';
import { toolSuccess } from '../ai/tools/contract';
import { TokenCounter } from '../memory/token-counter';
import { DEFAULT_AI_CONFIG } from '../types';

function fixture(invoke: (messages: any[], options?: any) => Promise<AIMessage>, execute = async () => toolSuccess('资料')) {
    const counter = new TokenCounter('', 100);
    const modelFactory = (() => ({ invoke, bind: () => ({ invoke }) })) as any;
    const agent = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' }, {} as any, {} as any,
        undefined, undefined, undefined, counter, DEFAULT_AGENT_LIMITS, undefined, modelFactory, undefined,
        { write: async () => {} }, { tools: [{ name: 'readFile', description: 'read',
            schema: { type: 'object', properties: {} }, func: execute }] });
    return { agent, dispose: () => counter.dispose() };
}

suite('AI SDK agent lifecycle', () => {
    test('emits stable snapshots and accumulates usage without mutating the input', async () => {
        let calls = 0;
        const { agent, dispose } = fixture(async () => ++calls === 1
            ? new AIMessage({ content: '', tool_calls: [{ name: 'readFile', id: 'read-1', args: {} }],
                usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
            : new AIMessage({ content: '完成', usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }));
        const input = { messages: [new HumanMessage('查询')] };
        try {
            const states: AgentState[] = [];
            for await (const state of agent.stream(input)) { states.push(state); }
            assert.deepStrictEqual(states.map(state => [state.agentTurns, state.toolCallCount]), [[0, 0], [1, 0], [1, 1], [2, 1]]);
            assert.deepStrictEqual(states.map(state => state.messages.length), [1, 2, 3, 4]);
            assert.strictEqual(states.at(-1)!.usage.totalTokens, 11);
            assert.strictEqual(input.messages.length, 1);
            assert.strictEqual(calls, 2);
        } finally { dispose(); }
    });

    test('closing after a tool-call response never executes its pending tool', async () => {
        let executions = 0, calls = 0;
        const { agent, dispose } = fixture(async () => {
            calls++;
            return new AIMessage({ content: '', tool_calls: [{ name: 'readFile', id: 'read-1', args: {} }] });
        }, async () => { executions++; return toolSuccess('资料'); });
        try {
            const stream = agent.stream({ messages: [new HumanMessage('查询')] });
            await stream.next();
            const response = await stream.next();
            assert.strictEqual(response.value!.agentTurns, 1);
            await stream.return(undefined);
            assert.strictEqual((await stream.next()).done, true);
            assert.strictEqual(calls, 1);
            assert.strictEqual(executions, 0);
        } finally { dispose(); }
    });

    test('a cancelled request never starts a model or tool', async () => {
        let calls = 0;
        const { agent, dispose } = fixture(async () => { calls++; return new AIMessage('不应执行'); });
        const controller = new AbortController(); controller.abort();
        try {
            await assert.rejects(agent.invoke({ messages: [new HumanMessage('查询')] }, { signal: controller.signal }), { name: 'AbortError' });
            assert.strictEqual(calls, 0);
        } finally { dispose(); }
    });

    test('separate runs on one agent do not share counters or messages', async () => {
        const { agent, dispose } = fixture(async messages => {
            const text = String(messages.find(message => message._getType() === 'human').content);
            await Promise.resolve();
            return new AIMessage(text);
        });
        try {
            const [first, second] = await Promise.all([
                agent.invoke({ messages: [new HumanMessage('第一项')], requestId: 'first' }),
                agent.invoke({ messages: [new HumanMessage('第二项')], requestId: 'second' }),
            ]);
            assert.strictEqual(first.messages.at(-1)!.content, '第一项');
            assert.strictEqual(second.messages.at(-1)!.content, '第二项');
            assert.strictEqual(first.agentTurns, 1);
            assert.strictEqual(second.agentTurns, 1);
            assert.notStrictEqual(first.messages, second.messages);
        } finally { dispose(); }
    });

    test('terminal model errors propagate once without a recovery call', async () => {
        let calls = 0;
        const { agent, dispose } = fixture(async () => {
            calls++;
            throw Object.assign(new Error('invalid key'), { statusCode: 401 });
        });
        try {
            await assert.rejects(agent.invoke({ messages: [new HumanMessage('查询')] }), /invalid key/);
            assert.strictEqual(calls, 1);
        } finally { dispose(); }
    });
});
