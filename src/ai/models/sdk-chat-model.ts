import { jsonSchema, type ModelMessage, type ToolSet, type LanguageModelUsage, type JSONValue } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createAlibaba } from '@ai-sdk/alibaba';
import { AIMessage, AIMessageChunk, BaseMessage, ToolMessage, HumanMessage } from '../messages';
import { getModelSDK, getModelTracingOptions } from './langsmith';
import type { ChatModelOptions } from './model-policy';

type FunctionTool = { type: 'function'; function: { name: string; description?: string; parameters: object } };
export interface SdkCallOptions { tools?: FunctionTool[]; signal?: AbortSignal; stop?: string[]; metadata?: Record<string, unknown>; tags?: string[] }

/** Select a local adapter by exact endpoint host. Every adapter receives the
 * caller's URL and key; model strings are never sent to AI Gateway. */
export function createDirectProvider(options: ChatModelOptions) {
    const baseURL = options.baseUrl || 'https://api.openai.com/v1';
    const host = new URL(baseURL).hostname.toLowerCase();
    const settings = { baseURL, apiKey: options.apiKey, fetch: options.fetch };
    if (host === 'api.openai.com') {
        return { name: 'openai', model: createOpenAI(settings).chat(options.model) };
    }
    if (host === 'api.deepseek.com') {
        return { name: 'deepseek', model: createDeepSeek(settings)(options.model) };
    }
    if (['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.com', 'api.kimi.ai'].includes(host)) {
        return { name: 'moonshotai', model: createMoonshotAI(settings)(options.model) };
    }
    if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)) {
        return { name: 'alibaba', model: createAlibaba(settings)(options.model) };
    }
    return { name: 'compatible', model: createOpenAICompatible({ ...settings, name: 'compatible', includeUsage: true })
        .chatModel(options.model) };
}

/** Direct AI SDK client with application messages at its boundary. */
export class SdkChatModel {
    private readonly connection: ReturnType<typeof createDirectProvider>;
    constructor(private readonly settings: ChatModelOptions, private readonly bound: SdkCallOptions = {}) {
        this.connection = createDirectProvider(settings);
    }
    bind(options: SdkCallOptions): SdkChatModel { return new SdkChatModel(this.settings, { ...this.bound, ...options }); }

    private request(messages: BaseMessage[], options: SdkCallOptions) {
        const tools: ToolSet = {};
        for (const tool of options.tools || []) {
            tools[tool.function.name] = { description: tool.function.description,
                inputSchema: jsonSchema(tool.function.parameters) };
        }
        const providerOptions: Record<string, Record<string, JSONValue>> = {};
        if (this.settings.reasoningMode === 'disabled') {
            switch (this.connection.name) {
                case 'openai': providerOptions.openai = { reasoningEffort: 'none' }; break;
                case 'deepseek': providerOptions.deepseek = { thinking: { type: 'disabled' } }; break;
                case 'moonshotai': providerOptions.moonshotai = { thinking: { type: 'disabled' } }; break;
                case 'alibaba': providerOptions.alibaba = { enableThinking: false }; break;
            }
        }
        Object.assign(providerOptions, getModelTracingOptions(options));
        const timeout = AbortSignal.timeout(this.settings.timeoutMs ?? 300_000);
        const abortSignal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        return { model: this.connection.model, messages: toSdkMessages(messages, this.settings), tools,
            temperature: this.settings.temperature, maxOutputTokens: this.settings.maxTokens,
            stopSequences: options.stop, providerOptions, abortSignal, maxRetries: 0, allowSystemInMessages: true };
    }

    async invoke(input: string | BaseMessage[], options: SdkCallOptions = {}): Promise<AIMessage> {
        const messages = typeof input === 'string' ? [new HumanMessage(input)] : input;
        const result = await getModelSDK().generateText(this.request(messages, { ...this.bound, ...options }));
        const message = new AIMessage({ content: result.text,
            tool_calls: result.toolCalls.map(call => ({ id: call.toolCallId, name: call.toolName, args: call.input as Record<string, unknown> })),
            additional_kwargs: { ai_sdk_content: assistantContent(result.response.messages) },
            response_metadata: { finish_reason: finishReason(result.finishReason), model_name: this.settings.model },
            usage_metadata: usageMetadata(result.usage),
        });
        return message;
    }

    async stream(input: string | BaseMessage[], options: SdkCallOptions = {}): Promise<AsyncGenerator<AIMessageChunk>> {
        const controller = new AbortController();
        const inherited = options.signal || this.bound.signal;
        const signal = inherited ? AbortSignal.any([inherited, controller.signal]) : controller.signal;
        const iterator = this.readStream(input, { ...options, signal });
        let first: IteratorResult<AIMessageChunk>;
        try { first = await iterator.next(); }
        catch (error) { controller.abort(); throw error; }
        let pending = true;
        const stream: AsyncGenerator<AIMessageChunk> = {
            [Symbol.asyncIterator]() { return stream; },
            async next() {
                try {
                    const result = pending ? first : await iterator.next();
                    pending = false;
                    if (result.done) { controller.abort(); }
                    return result;
                } catch (error) { controller.abort(); throw error; }
            },
            async return(value) { pending = false; controller.abort(); return iterator.return(value); },
            async throw(error) { pending = false; controller.abort(); return iterator.throw(error); },
        };
        return stream;
    }

    private async *readStream(input: string | BaseMessage[], options: SdkCallOptions): AsyncGenerator<AIMessageChunk> {
        const messages = typeof input === 'string' ? [new HumanMessage(input)] : input;
        const result = getModelSDK().streamText(this.request(messages, { ...this.bound, ...options }));
        const indexes = new Map<string, number>();
        for await (const part of result.fullStream) {
            let message: AIMessageChunk | undefined;
            if (part.type === 'error') { throw part.error; }
            if (part.type === 'abort') {
                const error = new Error('请求已取消'); error.name = 'AbortError'; throw error;
            }
            if (part.type === 'text-delta') {
                message = new AIMessageChunk(part.text);
            } else if (part.type === 'tool-input-start') {
                indexes.set(part.id, indexes.size);
                message = new AIMessageChunk({ content: '', tool_call_chunks: [{
                    id: part.id, name: part.toolName, index: indexes.get(part.id), args: '', type: 'tool_call_chunk',
                }] });
            } else if (part.type === 'tool-input-delta') {
                message = new AIMessageChunk({ content: '', tool_call_chunks: [{
                    index: indexes.get(part.id), args: part.delta, type: 'tool_call_chunk',
                }] });
            }
            if (message) { yield message; }
        }
        // SDK content includes reasoning and provider metadata. Keep it for the
        // next request without forwarding it to the visible token callback.
        const response = await result.response;
        yield new AIMessageChunk({ content: '',
            additional_kwargs: { ai_sdk_content: assistantContent(response.messages) },
            response_metadata: { finish_reason: finishReason(await result.finishReason), model_name: this.settings.model },
            usage_metadata: usageMetadata(await result.totalUsage),
        });
    }
}

function assistantContent(messages: ModelMessage[]) {
    const content = messages.find(message => message.role === 'assistant')?.content;
    return typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
}

function finishReason(reason: string): string {
    return reason === 'tool-calls' ? 'tool_calls' : reason === 'content-filter' ? 'content_filter' : reason;
}

function usageMetadata(usage: LanguageModelUsage) {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) { return undefined; }
    return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
        output_token_details: { reasoning: usage.outputTokenDetails?.reasoningTokens } };
}

export function toSdkMessages(messages: BaseMessage[], connection?: ChatModelOptions): ModelMessage[] {
    return messages.map(message => {
        const type = message._getType();
        if (type === 'system') { return { role: 'system', content: String(message.content) }; }
        if (type === 'tool') {
            const tool = message as ToolMessage;
            return { role: 'tool', content: [{ type: 'tool-result', toolCallId: tool.tool_call_id,
                toolName: tool.name || 'unknown', output: { type: tool.status === 'error' ? 'error-text' : 'text', value: String(tool.content) } }] };
        }
        if (type === 'ai') {
            const ai = message as AIMessage;
            const stored = ai.additional_kwargs.ai_sdk_content;
            const source = ai.additional_kwargs.ai_sdk_connection as { baseUrl: string; model: string } | undefined;
            const matches = !source || !connection || (source.baseUrl === (connection.baseUrl || 'https://api.openai.com/v1')
                && source.model === connection.model);
            if (matches && Array.isArray(stored)) {
                const calls = stored.filter(part => part.type === 'tool-call');
                if (calls.length === (ai.tool_calls || []).length
                    && calls.every(call => ai.tool_calls?.some(actual => actual.id === call.toolCallId))) {
                    return { role: 'assistant', content: stored } as ModelMessage;
                }
            }
            return { role: 'assistant', content: [
                ...(typeof ai.content === 'string' && ai.content ? [{ type: 'text' as const, text: ai.content }] : []),
                ...(ai.tool_calls || []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id!, toolName: call.name, input: call.args })),
            ] };
        }
        return { role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map(part => {
            if (typeof part === 'string') { return { type: 'text' as const, text: part }; }
            if (part.type === 'text') { return { type: 'text' as const, text: String(part.text) }; }
            if (part.type === 'image_url') {
                const image = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
                return { type: 'image' as const, image };
            }
            throw new Error(`不支持的用户消息内容类型：${part.type}`);
        }) };
    });
}
