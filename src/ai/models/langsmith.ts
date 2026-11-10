/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/langsmith.ts - LangSmith 集成
 * 功能：管理 LangSmith tracing 配置和初始化
 * 包含：
 *   - 环境变量配置
 *   - Tracer 管理
 *   - 动态启用/禁用
*/
import { Client } from 'langsmith';
import { traceable } from 'langsmith/traceable';
import { LangSmithConfig } from '../../types';
import * as ai from 'ai';
import { wrapAISDK, createLangSmithProviderOptions } from 'langsmith/experimental/vercel';

let modelSDK: Pick<typeof ai, 'generateText' | 'streamText'> = ai;
let isConfigured = false;
let currentClient: Client | undefined;
let currentProject = "aiwriter";

export function configureLangSmith(config: LangSmithConfig | undefined): void {
    if (!config || !config.enabled || !config.tracingEnabled) {
        disableLangSmith();
        return;
    }

    if (!config.apiKey) {
        disableLangSmith();
        console.warn('[LangSmith] 已启用但未提供 API Key，跳过配置');
        return;
    }

    try {
        if (config.tracingEnabled) {
            process.env.LANGSMITH_TRACING = 'true';
        } else {
            delete process.env.LANGSMITH_TRACING;
        }

        process.env.LANGSMITH_API_KEY = config.apiKey;

        if (config.endpoint) {
            process.env.LANGSMITH_ENDPOINT = config.endpoint;
        } else {
            delete process.env.LANGSMITH_ENDPOINT;
        }

        if (config.project) {
            process.env.LANGSMITH_PROJECT = config.project;
        } else {
            delete process.env.LANGSMITH_PROJECT;
        }

        if (config.workspaceId) {
            process.env.LANGSMITH_WORKSPACE_ID = config.workspaceId;
        } else {
            delete process.env.LANGSMITH_WORKSPACE_ID;
        }

        currentProject = config.project || 'aiwriter';
        currentClient = new Client({ apiKey: config.apiKey, apiUrl: config.endpoint || 'https://api.smith.langchain.com',
            workspaceId: config.workspaceId || undefined, autoBatchTracing: config.callbacksBackground !== false, hideInputs: false, hideOutputs: false });
        modelSDK = wrapAISDK(ai, { client: currentClient, project_name: currentProject, tracingEnabled: true });
        isConfigured = true;
        console.log(`[LangSmith] 已配置 - Project: ${config.project || 'default'}, Endpoint: ${config.endpoint || 'default'}`);
    } catch (error) {
        console.error('[LangSmith] 配置失败:', error);
        disableLangSmith();
    }
}

export function disableLangSmith(): void {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGSMITH_ENDPOINT;
    delete process.env.LANGSMITH_PROJECT;
    delete process.env.LANGSMITH_WORKSPACE_ID;

    modelSDK = ai;
    currentClient = undefined;
    isConfigured = false;
    console.log('[LangSmith] 已禁用');
}

export function getLangSmithClient(): Client | null { return isConfigured ? currentClient || null : null; }

/** Return native SDK calls unless the user explicitly enabled tracing. */
export function getModelSDK(): Pick<typeof ai, 'generateText' | 'streamText'> { return modelSDK; }

export function getModelTracingOptions(options: { metadata?: Record<string, unknown>; tags?: string[] }) {
    return isConfigured ? { langsmith: createLangSmithProviderOptions({ metadata: options.metadata, tags: options.tags }) } : {};
}


export function isLangSmithEnabled(): boolean {
    return isConfigured;
}

export function getLangSmithEnvVars(): Record<string, string> {
    const envVars: Record<string, string> = {};
    if (process.env.LANGSMITH_TRACING) {envVars.LANGSMITH_TRACING = process.env.LANGSMITH_TRACING;}
    if (process.env.LANGSMITH_API_KEY) {envVars.LANGSMITH_API_KEY = '***hidden***';}
    if (process.env.LANGSMITH_ENDPOINT) {envVars.LANGSMITH_ENDPOINT = process.env.LANGSMITH_ENDPOINT;}
    if (process.env.LANGSMITH_PROJECT) {envVars.LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT;}
    if (process.env.LANGSMITH_WORKSPACE_ID) {envVars.LANGSMITH_WORKSPACE_ID = process.env.LANGSMITH_WORKSPACE_ID;}
    return envVars;
}

/** One parent span across planning, retrieval, writing and editing. */
export function traceWritingRequest<T>(requestId: string, input: unknown, action: () => Promise<T>): Promise<T> {
    if (!isConfigured || !currentClient) { return action(); }
    return traceable(async (_input: unknown) => action(), {
        name: 'aiwriter.request', run_type: 'chain', client: currentClient,
        project_name: currentProject, tracingEnabled: true,
        metadata: { requestId }, tags: ['aiwriter'],
    })(input);
}
