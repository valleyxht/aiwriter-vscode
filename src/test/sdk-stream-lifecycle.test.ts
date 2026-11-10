import * as assert from 'assert';
import { createChatModel, openChatModelStream } from '../ai/models/model-policy';

const headers = { 'content-type': 'text/event-stream' };
const frame = (content: string) => 'data: ' + JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1,
    model: 'custom', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n';
const completed = () => frame('正文') + 'data: ' + JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1,
    model: 'custom', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';

suite('Native SDK stream lifecycle', () => {
    test('retries a connection error before the first displayed chunk', async () => {
        let calls = 0;
        const model = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom',
            temperature: 0, streaming: true, fetch: async () => ++calls === 1
                ? new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
                : new Response(completed(), { headers }) });
        const lease = await openChatModelStream(() => model.stream('请求'), { operation: 'test', maxRetries: 1, baseDelayMs: 0 });
        try {
            let text = '';
            for await (const chunk of lease.stream) { text += chunk.content; }
            assert.strictEqual(text, '正文');
            assert.strictEqual(calls, 2);
        } finally { lease.release(); }
    });

    test('propagates a transport error after visible output without replaying the request', async () => {
        let calls = 0;
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const model = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom',
            temperature: 0, streaming: true, fetch: async () => {
                calls++;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    source = controller; controller.enqueue(new TextEncoder().encode(frame('已显示')));
                } }), { headers });
            } });
        const lease = await openChatModelStream(() => model.stream('请求'), { operation: 'test', maxRetries: 1, baseDelayMs: 0 });
        try {
            const stream = lease.stream;
            assert.strictEqual((await stream.next()).value!.content, '已显示');
            source.error(new Error('connection reset'));
            await assert.rejects(stream.next());
            assert.strictEqual(calls, 1);
        } finally { lease.release(); }
    });

    test('closing a primed stream aborts its transport even before consuming its first chunk', async () => {
        let requestSignal: AbortSignal | null | undefined;
        const model = createChatModel({ apiKey: 'test', baseUrl: 'https://custom.example/v1', model: 'custom',
            temperature: 0, streaming: true, fetch: async (_url, init) => {
                requestSignal = init?.signal;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    controller.enqueue(new TextEncoder().encode(frame('尚未显示')));
                    requestSignal?.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true });
                } }), { headers });
            } });
        const stream = await model.stream('请求');
        assert.strictEqual(requestSignal?.aborted, false);
        await stream.return(undefined);
        assert.strictEqual(requestSignal?.aborted, true);
    });
});
