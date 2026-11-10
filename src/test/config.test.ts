import * as assert from 'assert';
import { AIConfigManager, SECRET_MASK } from '../ai/models';

suite('AIConfigManager secret migration', () => {
  test('moves legacy API keys into SecretStorage and masks display values', async () => {
    const globalValues = new Map<string, any>();
    const secretValues = new Map<string, string>();
    globalValues.set('aiwriter.aiConfig', {
      apiKey: 'legacy-main',
      langsmith: { enabled: true, tracingEnabled: true, callbacksBackground: true, apiKey: 'legacy-trace' },
      rag: { enabled: true, embeddingApiKey: 'legacy-embedding' },
      webSearch: { enabled: true, provider: 'tavily', apiKey: 'legacy-search', searchDepth: 'advanced', maxResults: 5, allowedDomains: [] }
    });
    globalValues.set('aiwriter.workflowConfig', {
      parserModel: { enabled: true, provider: 'openai', apiKey: 'legacy-parser', model: 'gpt-4o-mini', temperature: 0, maxTokens: 100 },
      enableIcebergPrompting: true,
      defaultWriterSystemPrompt: ''
    });

    const context = {
      globalState: {
        get: <T>(key: string): T | undefined => globalValues.get(key),
        update: async (key: string, value: any) => { globalValues.set(key, value); }
      },
      secrets: {
        get: async (key: string) => secretValues.get(key),
        store: async (key: string, value: string) => { secretValues.set(key, value); },
        delete: async (key: string) => { secretValues.delete(key); }
      }
    } as any;

    const manager = new AIConfigManager(context, {
      resolve: async () => ({
        source: 'litellm',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        matchedModel: 'gpt-4o-mini',
        detectedAt: '2026-07-29T00:00:00.000Z',
      }),
    });
    await manager.initialize();

    assert.strictEqual(manager.config.apiKey, 'legacy-main');
    assert.strictEqual(manager.config.contextWindowSize, 128);
    assert.strictEqual(manager.config.contextWindowDetection?.source, 'litellm');
    assert.strictEqual(manager.workflowConfig.parserModel.apiKey, 'legacy-parser');
    assert.strictEqual(manager.displayConfig.apiKey, SECRET_MASK);
    assert.strictEqual(manager.config.rag?.embeddingApiKey, 'legacy-embedding');
    assert.strictEqual(manager.displayConfig.rag?.embeddingApiKey, SECRET_MASK);
    assert.strictEqual(manager.config.webSearch?.apiKey, 'legacy-search');
    assert.strictEqual(manager.displayConfig.webSearch?.apiKey, SECRET_MASK);
    assert.strictEqual(manager.displayWorkflowConfig.parserModel.apiKey, SECRET_MASK);
    assert.ok(!('apiKey' in globalValues.get('aiwriter.aiConfig')));
    assert.ok(!('apiKey' in globalValues.get('aiwriter.aiConfig').langsmith));
    assert.ok(!('embeddingApiKey' in globalValues.get('aiwriter.aiConfig').rag));
    assert.ok(!('apiKey' in globalValues.get('aiwriter.aiConfig').webSearch));
    assert.ok(!('apiKey' in globalValues.get('aiwriter.workflowConfig').parserModel));
    assert.strictEqual(secretValues.get('aiwriter.secret.aiApiKey'), 'legacy-main');
    assert.strictEqual(secretValues.get('aiwriter.secret.parserApiKey'), 'legacy-parser');
    assert.strictEqual(secretValues.get('aiwriter.secret.langsmithApiKey'), 'legacy-trace');
    assert.strictEqual(secretValues.get('aiwriter.secret.ragEmbeddingApiKey'), 'legacy-embedding');
    assert.strictEqual(secretValues.get('aiwriter.secret.webSearchApiKey'), 'legacy-search');
    assert.strictEqual(manager.workflowConfig.defaultWritingExecutionPrompt, '');
    assert.strictEqual(manager.workflowConfig.defaultWriterSystemPrompt, undefined);
  });

  test('manual context mode bypasses catalog resolution and preserves the override', async () => {
    const globalValues = new Map<string, any>();
    let resolutions = 0;
    const context = {
      globalState: {
        get: <T>(key: string): T | undefined => globalValues.get(key),
        update: async (key: string, value: any) => { globalValues.set(key, value); }
      },
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
      }
    } as any;
    const manager = new AIConfigManager(context, {
      resolve: async () => {
        resolutions++;
        return { source: 'litellm', contextWindowTokens: 128_000 };
      },
    });

    await manager.initialize();
    await manager.updateConfig({ contextWindowMode: 'manual', contextWindowSize: 256 });

    assert.strictEqual(resolutions, 1);
    assert.strictEqual(manager.config.contextWindowSize, 256);
    assert.deepStrictEqual(manager.config.contextWindowDetection, {
      source: 'manual',
      contextWindowTokens: 256_000,
    });
  });

  test('keeps initialization available when automatic detection unexpectedly fails', async () => {
    const globalValues = new Map<string, any>();
    const context = {
      globalState: {
        get: <T>(key: string): T | undefined => globalValues.get(key),
        update: async (key: string, value: any) => { globalValues.set(key, value); }
      },
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
      }
    } as any;
    const manager = new AIConfigManager(context, {
      resolve: async () => { throw new Error('unexpected catalog failure'); },
    });

    await manager.initialize();

    assert.strictEqual(manager.config.contextWindowSize, 20);
    assert.strictEqual(manager.config.contextWindowDetection?.source, 'fallback');
    assert.strictEqual(manager.config.contextWindowDetection?.contextWindowTokens, 20_000);
  });
});
