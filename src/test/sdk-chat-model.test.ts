import * as assert from 'assert';
import { AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from '../ai/messages';
import { createChatModel } from '../ai/models/model-policy';
import { createDirectProvider } from '../ai/models/sdk-chat-model';
import { historyMessages } from '../ai/runtime/history-summary';
import { projectMessagesWithNormalizedEvidence } from '../ai/runtime/evidence-normalizer';
import { createWritingAssistantAgent, DEFAULT_AGENT_LIMITS } from '../ai/runtime/agent';
import { DEFAULT_AI_CONFIG } from '../types';
import { TokenCounter } from '../memory/token-counter';

const definition = { type: 'function' as const, function: { name: 'lookup', description: 'Lookup',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } };
const completion = (message: object = { role: 'assistant', content: '正文' }, finish = 'stop') => ({
    id: 'reply', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } },
});
function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function sse(parts: object[]) {
    const data = parts.map(delta => `data: ${JSON.stringify(delta)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
}
function delta(content: object, finish: string | null = null) {
    return { id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: content, finish_reason: finish }] };
}

suite('AI SDK direct provider integration', () => {
    for (const [baseUrl, model] of [
        ['https://api.openai.com/v1', 'gpt-4o-mini'],
        ['https://api.deepseek.com/v1', 'deepseek-chat'],
        ['https://api.moonshot.cn/v1', 'kimi-k2.6'],
        ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
        ['https://custom.example/v1', 'custom-model'],
        ['https://api.moonshot.cn.example/v1', 'kimi-k2.6'],
    ]) {
        test(`sends the configured key and model only to the exact configured endpoint (${new URL(baseUrl).hostname})`, async () => {
            const calls: { url: string; body: any }[] = [];
            const modelClient = createChatModel({ apiKey: 'test-key', baseUrl: baseUrl + '/chat/completions', model,
                temperature: 0.2, streaming: false, fetch: async (url, init) => {
                    assert.strictEqual(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
                    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
                    return json(completion());
                } });
            const response = await modelClient.bind({ tools: [definition] }).invoke([new HumanMessage('查询')]);
            assert.strictEqual(response.content, '正文');
            assert.strictEqual(response.usage_metadata?.total_tokens, 15);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].url, baseUrl + '/chat/completions');
            assert.strictEqual(calls[0].body.model, model);
            assert.strictEqual(calls[0].body.tools[0].function.name, 'lookup');
            if (baseUrl.includes('moonshot.cn/v1')) { assert.strictEqual(calls[0].body.temperature, undefined); }
            if (baseUrl.includes('custom.example') || baseUrl.includes('cn.example')) {
                assert.strictEqual(calls[0].body.temperature, 0.2);
                assert.strictEqual(calls[0].body.thinking, undefined);
            }
        });
    }

    for (const [baseUrl, model] of [
        ['https://api.deepseek.com/v1', 'deepseek-chat'],
        ['https://api.moonshot.ai/v1', 'kimi-k2.6'],
        ['https://custom.example/v1', 'custom-model'],
    ]) {
        for (const streaming of [false, true]) {
            test(`preserves reasoning and tool associations on the next request (${model}, stream=${streaming})`, async () => {
                const requests: any[] = [];
                const client = createChatModel({ apiKey: 'test', baseUrl, model, temperature: 0, streaming,
                    fetch: async (_url, init) => {
                        const body = JSON.parse(String(init?.body)); requests.push(body);
                        if (requests.length === 1) {
                            return body.stream ? sse([
                                delta({ role: 'assistant', reasoning_content: '必须传回的推理' }),
                                delta({ tool_calls: [{ index: 0, id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }] }),
                                delta({ tool_calls: [{ index: 0, function: { arguments: '"线索"}' } }] }),
                                delta({}, 'tool_calls'),
                            ]) : json(completion({ role: 'assistant', content: '', reasoning_content: '必须传回的推理',
                                tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"线索"}' } }] }, 'tool_calls'));
                        }
                        return json(completion());
                    } });
                const bound = client.bind({ tools: [definition] });
                const input = [new SystemMessage('系统'), new HumanMessage('查询')];
                let reply;
                if (streaming) {
                    let collected: AIMessageChunk | undefined;
                    for await (const chunk of await bound.stream(input)) { collected = collected ? collected.concat(chunk) : chunk; }
                    reply = collected!;
                } else { reply = await bound.invoke(input); }
                assert.strictEqual(reply.content, '');
                assert.strictEqual(reply.tool_calls?.[0].args.query, '线索');
                const messages = projectMessagesWithNormalizedEvidence([...input, reply,
                    new ToolMessage({ content: '资料', tool_call_id: 'lookup-1', name: 'lookup' })]);
                await bound.invoke(messages);
                const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
                assert.strictEqual(assistant.reasoning_content, '必须传回的推理');
                assert.strictEqual(assistant.tool_calls[0].id, 'lookup-1');
                assert.deepStrictEqual(requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'lookup-1', content: '资料' });
            });
        }
    }

    test('streams incremental text, usage and reasoning through the actual graph without exposing reasoning', async () => {
        const visible: string[] = [];
        const counter = new TokenCounter('', 100);
        try {
            const graph = createWritingAssistantAgent({ ...DEFAULT_AI_CONFIG, apiKey: 'test' }, {} as any, {} as any,
                { handleLLMNewToken: async (text: string) => visible.push(text) }, undefined, undefined, counter,
                DEFAULT_AGENT_LIMITS, undefined,
                (options => createChatModel({ ...options, fetch: async () => sse([
                    delta({ role: 'assistant', reasoning_content: '隐藏推理' }),
                    delta({ content: '第一段' }), delta({ content: '第二段' }), delta({}, 'stop'),
                    { id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
                ]) })) as typeof createChatModel, undefined, { write: async () => {} } as any, { tools: [] });
            const result = await graph.invoke({ messages: [new HumanMessage('写作')] });
            assert.strictEqual(visible.join(''), '第一段第二段');
            assert.strictEqual(result.usage.totalTokens, 15);
        } finally { counter.dispose(); }
    });

    test('does not retry terminal HTTP failures or fall back to another endpoint', async () => {
        let attempts = 0;
        const client = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom',
            temperature: 0, streaming: false, fetch: async () => {
                attempts++; return json({ error: { message: 'invalid key', type: 'authentication_error', code: 'invalid_api_key' } }, 401);
            } });
        await assert.rejects(client.invoke('test'), (error: any) => error.statusCode === 401);
        assert.strictEqual(attempts, 1);
    });

    test('cancels an in-flight SDK request without retrying', async () => {
        const controller = new AbortController();
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        let attempts = 0;
        const client = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom',
            temperature: 0, streaming: false, fetch: async (_url, init) => {
                attempts++; started();
                return new Promise<Response>((_resolve, reject) => {
                    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
                });
            } });
        const request = client.invoke('test', { signal: controller.signal });
        await ready;
        controller.abort();
        await assert.rejects(request);
        assert.strictEqual(attempts, 1);
    });

    test('an unknown host always uses the generic adapter even when the model has a known provider name', () => {
        assert.strictEqual(createDirectProvider({ apiKey: 'test', baseUrl: 'https://custom.example/v1',
            model: 'kimi-k2.6', temperature: 0, streaming: false }).name, 'compatible');
    });

    test('replays persisted reasoning only for the original endpoint and model', async () => {
        const saved = JSON.parse(JSON.stringify({ role: 'assistant', content: '历史正文', timestamp: 'now',
            modelContext: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', content: [
                { type: 'reasoning', text: '历史推理' }, { type: 'text', text: '历史正文' },
            ] } }));
        for (const baseUrl of ['https://api.deepseek.com/v1', 'https://custom.example/v1']) {
            let request: any;
            const client = createChatModel({ apiKey: 'test', baseUrl, model: 'deepseek-v4-flash', temperature: 0, streaming: false,
                fetch: async (_url, init) => { request = JSON.parse(String(init?.body)); return json(completion()); } });
            await client.bind({ tools: [definition] }).invoke([...historyMessages([saved]), new HumanMessage('继续')]);
            assert.strictEqual(request.messages[0].content, '历史正文');
            assert.strictEqual(request.messages[0].reasoning_content, baseUrl.includes('api.deepseek.com') ? '历史推理' : undefined);
        }
    });

    test('the SDK never executes tools; the existing approval and execution layer remains authoritative', async () => {
        const client = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom', temperature: 0,
            streaming: false, fetch: async () => json(completion({ role: 'assistant', content: '',
                tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"线索"}' } }] }, 'tool_calls')) });
        const reply = await client.bind({ tools: [definition] }).invoke('test');
        assert.strictEqual(reply.tool_calls?.[0].name, 'lookup');
    });
});
