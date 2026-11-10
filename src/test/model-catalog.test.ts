import * as assert from 'assert';
import {
  inferContextFromModelName,
  matchCatalogEntry,
  ModelCatalogEntry,
  ModelCatalogService,
  parseLiteLLMCatalog,
} from '../ai/models';

suite('LiteLLM model catalog', () => {
  test('parses only usable context-window entries', () => {
    const entries = parseLiteLLMCatalog({
      'gpt-test': {
        litellm_provider: 'openai',
        max_input_tokens: 128000,
        max_output_tokens: 16384,
      },
      'embedding-without-window': { litellm_provider: 'custom' },
      invalid: 'not-an-object',
    });

    assert.deepStrictEqual(entries, [{
      id: 'gpt-test',
      provider: 'openai',
      maxInputTokens: 128000,
      maxOutputTokens: 16384,
    }]);
  });

  test('prefers the Base URL provider variant before a generic model entry', () => {
    const entries: ModelCatalogEntry[] = [
      { id: 'deepseek/deepseek-chat', provider: 'deepseek', maxInputTokens: 128_000 },
      { id: 'openrouter/deepseek/deepseek-chat', provider: 'openrouter', maxInputTokens: 65_536 },
    ];

    const match = matchCatalogEntry(
      entries,
      'deepseek/deepseek-chat',
      'https://openrouter.ai/api/v1'
    );
    assert.strictEqual(match?.id, 'openrouter/deepseek/deepseek-chat');
    assert.strictEqual(match?.maxInputTokens, 65_536);
  });

  test('downloads the public JSON without credentials and reuses the seven-day cache', async () => {
    const values = new Map<string, any>();
    const requests: Array<{ input: string; init: any }> = [];
    const fetcher = async (input: string, init?: { signal?: AbortSignal }) => {
      requests.push({ input, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'openrouter/example/model-128k': {
            litellm_provider: 'openrouter',
            max_input_tokens: 128000,
            max_output_tokens: 8192,
          },
        }),
      };
    };
    const storage = {
      get: <T>(key: string): T | undefined => values.get(key),
      update: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const service = new ModelCatalogService(storage, fetcher, () => 1_000_000);

    const first = await service.resolve('example/model-128k', 'https://openrouter.ai/api/v1');
    const second = await service.resolve('example/model-128k', 'https://openrouter.ai/api/v1');

    assert.strictEqual(first.contextWindowTokens, 128_000);
    assert.strictEqual(first.source, 'litellm');
    assert.strictEqual(second.fromCache, true);
    assert.strictEqual(requests.length, 1);
    assert.deepStrictEqual(Object.keys(requests[0].init), ['signal']);
  });

  test('uses explicit model-name window markers and otherwise falls back safely', async () => {
    const storage = {
      get: <T>(_key: string): T | undefined => undefined,
      update: async () => undefined,
    };
    const fetcher = async () => { throw new Error('offline'); };
    const service = new ModelCatalogService(storage, fetcher);

    assert.strictEqual(inferContextFromModelName('custom-writer-256k'), 256_000);
    assert.strictEqual(inferContextFromModelName('custom-writer-1m-context'), 1_000_000);
    assert.strictEqual((await service.resolve('custom-writer-256k')).source, 'model_name');
    assert.strictEqual((await service.resolve('unknown-model')).contextWindowTokens, 20_000);
  });
});
