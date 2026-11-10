import { embedMany } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { EmbeddingModelOptions } from './model-policy';

/** Direct OpenAI-compatible embeddings; batching/retries remain governed by
 * the caller, so the SDK cannot multiply attempts or exceed its quota. */
export class SdkEmbeddings {
    constructor(private readonly settings: EmbeddingModelOptions) {}
    async embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
        if (!texts.length) { return []; }
        const timeout = AbortSignal.timeout(this.settings.timeoutMs ?? 120_000);
        const result = await embedMany({
            model: createOpenAICompatible({ name: 'compatible', apiKey: this.settings.apiKey,
                baseURL: this.settings.baseUrl || 'https://api.openai.com/v1', fetch: this.settings.fetch })
                .embeddingModel(this.settings.model),
            values: texts.map(text => text.replace(/\n/g, ' ')),
            maxRetries: 0, maxParallelCalls: 1,
            abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        return result.embeddings;
    }
    async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
        return (await this.embedDocuments([text], signal))[0];
    }
}
