import * as assert from 'assert';
import { createEmbeddingModel } from '../ai/models/model-policy';

suite('Direct SDK embeddings', () => {
    test('uses the configured endpoint, key, model and input order', async () => {
        let calls = 0;
        const model = createEmbeddingModel({ apiKey: 'test-key', baseUrl: 'https://vectors.example/v1/embeddings', model: 'custom-vector',
            fetch: async (url, init) => {
                calls++;
                assert.strictEqual(String(url), 'https://vectors.example/v1/embeddings');
                assert.strictEqual(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
                const body = JSON.parse(String(init?.body));
                assert.strictEqual(body.model, 'custom-vector');
                assert.deepStrictEqual(body.input, ['人物 设定', '剧情']);
                return new Response(JSON.stringify({ object: 'list', model: 'custom-vector',
                    data: [{ object: 'embedding', index: 0, embedding: [1, 0] }, { object: 'embedding', index: 1, embedding: [0, 1] }],
                    usage: { prompt_tokens: 2, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
            } });
        assert.deepStrictEqual(await model.embedDocuments(['人物\n设定', '剧情']), [[1, 0], [0, 1]]);
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(await model.embedDocuments([]), []);
        assert.strictEqual(calls, 1);
    });

    test('cancellation is forwarded to the embedding transport', async () => {
        const controller = new AbortController();
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const model = createEmbeddingModel({ apiKey: 'test', baseUrl: 'https://vectors.example/v1', model: 'custom',
            fetch: async (_url, init) => {
                started();
                return new Promise<Response>((_resolve, reject) => {
                    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
                });
            } });
        const result = model.embedQuery('原文', controller.signal);
        await ready; controller.abort();
        await assert.rejects(result);
    });
});
