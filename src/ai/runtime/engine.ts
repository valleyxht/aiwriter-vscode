/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/engine.ts - AI 引擎
 * 功能：处理 AI 对话和流式响应
 * 包含：
 *   - AI SDK Agent 执行循环
 *   - 历史消息管理
 *   - 流式响应处理
 *   - LangSmith tracing 集成
 *   - Token 用量统计
 */
import { ChatMessage, AIConfig, IFileSystem, AIRequestStatus, HistorySummary } from '../../types';
import { FileWriteApprover } from '../../features/file-approval';
import { createWritingAssistantAgent, getVisibleMessageText, getSystemPrompt, AgentProgressCallbacks, AgentState } from './agent';
import { StreamHandler } from './stream-handler';
import type { TaskOutcome } from './task-outcome';
import { configureLangSmith } from '../models/langsmith';
import { TokenCounter, TokenStats } from '../../memory/token-counter';
import { RagManager } from '../../memory/rag';
import { FileTransactionManager } from '../../history';
import { ToolDef } from '../tools/contract';
import { HumanMessage, AIMessage, BaseMessage } from '../messages';
import { cleanBaseUrl, createChatModel, createModelRunConfig, executeChatModelCall } from '../models/model-policy';
import { compactHistory, summaryMessages, validHistorySummary } from './history-summary';
import { currentRequestTelemetry } from './request-telemetry';
import {
    calculateCompletionTokenBudget,
    ModelUsageSummary,
    normalizeUsageMetadata,
} from './token-budget';
import { ResponseDelivery } from './response-delivery';
import {
    getRequestLogPath,
    RequestJsonlLogger,
    summarizeText,
} from './request-logger';
import { collectFileMutationSummaries } from './file-mutations';

export interface AIResponse {
    content: string;
    success: boolean;
    error?: string;
}

export interface AIStreamCallback {
    (content: string, done: boolean): void;
}

export interface AIProgressCallback {
    (stage: string, message: string): void;
}

export interface AIRequestContext {
    requestId: string;
    controller: AbortController;
    projectMemory?: string;
}

export interface AIRequestResult extends Partial<TaskOutcome> {
    requestId: string;
    status: Exclude<AIRequestStatus, 'RUNNING'>;
    finishReason?: string;
    error?: string;
}

export interface TokenStatsCallback {
    (stats: TokenStats): void;
}

export const AI_STAGES = {
    MODEL_INVOKE: 'model_invoke',
    TOOL_CALL: 'tool_call',
    TOOL_EXECUTING: 'tool_executing',
    WAITING_RESPONSE: 'waiting_response',
    PROCESSING_RESULT: 'processing_result',
    COMPLETED: 'completed',
    ERROR: 'error'
} as const;

export class AIEngine {
    private _config: AIConfig;
    private _fileSystem: IFileSystem;
    private _fileWriteApprover: FileWriteApprover;
    private _history: ChatMessage[] = [];
    private _historySummary?: HistorySummary;
    private _onHistorySummary?: (summary: HistorySummary) => Promise<void>;
    private _historyRevision = 0;
    private _agent: ReturnType<typeof createWritingAssistantAgent> | null = null;
    private _progressCallback?: AIProgressCallback;
    private _tokenStatsCallback?: TokenStatsCallback;
    private _activeTimers = new Map<string, Set<any>>();
    private _tokenCounter: TokenCounter;
    private _ragManager?: RagManager;
    private _transactionManager?: FileTransactionManager;
    private _requestLogger = new RequestJsonlLogger();
    private _logRoot?: string;
    private _additionalTools: ToolDef[];

    constructor(
        config: AIConfig,
        fileSystem: IFileSystem,
        fileWriteApprover: FileWriteApprover,
        ragManager?: RagManager,
        transactionManager?: FileTransactionManager,
        logRoot?: string,
        additionalTools: ToolDef[] = [],
        private readonly _summaryModelFactory: typeof createChatModel = createChatModel
    ) {
        this._config = config;
        this._fileSystem = fileSystem;
        this._fileWriteApprover = fileWriteApprover;
        this._ragManager = ragManager;
        this._transactionManager = transactionManager;
        this._logRoot = logRoot;
        this._additionalTools = additionalTools;
        this._tokenCounter = new TokenCounter(config.model, config.contextWindowSize);
        this._configureLangSmith();
        this._initAgent();
        console.log(`[AIEngine] Token counter initialized for model: ${config.model}, context window: ${config.contextWindowSize}k`);
    }

    private _configureLangSmith(): void {
        configureLangSmith(this._config.langsmith);
    }

    setAdditionalTools(tools: ToolDef[]): void {
        this._additionalTools = tools;
        this._initAgent();
    }

    private _initAgent(): void {
        if (!this._config.apiKey || !this._config.model.trim()) {
            return;
        }

        try {
            this._agent = createWritingAssistantAgent(
                this._config,
                this._fileSystem,
                this._fileWriteApprover,
                undefined,
                undefined,
                this._ragManager,
                this._tokenCounter,
                undefined,
                this._transactionManager,
                undefined,
                undefined,
                this._requestLogger,
                { additionalTools: this._additionalTools }
            );
        } catch (error) {
            console.error('初始化 Agent 失败:', error);
        }
    }

    updateConfig(config: AIConfig): void {
        this._config = config;
        this._configureLangSmith();
        this._tokenCounter.updateConfig(config.model, config.contextWindowSize);
        this._initAgent();
        console.log('[AIEngine] Token counter config updated');
    }

    async sendMessage(
        userMessage: string,
        collectedTexts?: string,
        workspacePath?: string,
        request?: AIRequestContext
    ): Promise<AIResponse> {
        if (!this._agent) {
            return {
                content: '',
                success: false,
                error: 'AI 模型未配置，请先配置 API Key'
            };
        }

        try {
            const requestContext = request || {
                requestId: `request_${Date.now()}`,
                controller: new AbortController(),
            };
            const requestId = requestContext.requestId;
            const inputMessages = await this._prepareHistory(userMessage, collectedTexts, workspacePath, requestContext);
            inputMessages.push(new HumanMessage(userMessage));
            const contextReserve = this._getExecutionCompletionBudget();
            await this._requestLogger.write(this._logRoot, requestId, {
                event: 'request_start',
                data: {
                    model: this._config.model,
                    contextWindowTokens: this._tokenCounter.getContextWindowSize(),
                    providerCompletionLimit: 'default',
                    contextOutputReserveTokens: contextReserve.requestMaxTokens,
                    instruction: summarizeText(userMessage, this._tokenCounter),
                },
            });
            const result = await this._agent.invoke(
                {
                    messages: inputMessages,
                    collectedTexts,
                    workspacePath,
                    logRoot: this._logRoot,
                    projectMemory: requestContext.projectMemory,
                    requestId,
                },
                {
                    signal: requestContext.controller?.signal,
                    metadata: { requestId, component: 'aiwriter', operation: 'agent.invoke' },
                    tags: ['aiwriter', 'agent.invoke'],
                }
            );

            const lastMessage = result.messages[result.messages.length - 1];
            const draftContent = getVisibleMessageText(lastMessage);
            if (!draftContent.trim()) {
                const error = lastMessage?.additional_kwargs?.reasoning_only_exhausted === true
                    ? '模型将本次输出全部用于隐藏推理，未生成可显示内容。插件已停止重复重试，请关闭该模型的思考模式或更换非推理模型。'
                    : '模型未返回可显示内容，请重新发送本次请求。';
                await this._requestLogger.write(this._logRoot, requestId, {
                    event: 'empty_response_terminal',
                    node: 'engine',
                    data: {
                        status: 'FAILED',
                        finishReason: lastMessage?.response_metadata?.finish_reason
                            || lastMessage?.response_metadata?.finishReason,
                        contentType: describeMessageContent(lastMessage?.content),
                    },
                });
                return { content: '', success: false, error };
            }
            const aiContent = draftContent;

            this._addMessage({
                role: 'user',
                content: userMessage,
                timestamp: new Date().toISOString()
            });
            await this._requestLogger.write(this._logRoot, requestId, {
                event: 'request_complete',
                data: { status: 'COMPLETED', finalOutput: summarizeText(aiContent, this._tokenCounter),
                    fileMutations: collectFileMutationSummaries(result.toolResults) },
            });
            this._addMessage({
                role: 'assistant',
                content: aiContent,
                timestamp: new Date().toISOString(),
                modelContext: this._modelContext(lastMessage),
            });

            return {
                content: aiContent,
                success: true
            };
        } catch (error) {
            return {
                content: '',
                success: false,
                error: `AI 调用失败: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    setProgressCallback(callback?: AIProgressCallback): void {
        this._progressCallback = callback;
    }

    setTokenStatsCallback(callback?: TokenStatsCallback): void {
        this._tokenStatsCallback = callback;
        console.log('[AIEngine] Token stats callback set');
    }

    private _reportProgress(stage: string, message: string): void {
        console.log(`[AI] [${stage}] ${message}`);
        if (this._progressCallback) {
            this._progressCallback(stage, message);
        }
    }

    async sendMessageStream(
        userMessage: string,
        callback: AIStreamCallback,
        collectedTexts?: string,
        workspacePath?: string,
        progressCallback?: AIProgressCallback,
        request?: AIRequestContext
    ): Promise<AIRequestResult> {
        const context = request || { requestId: `request_${Date.now()}`, controller: new AbortController() };
        if (progressCallback) {
            this._progressCallback = progressCallback;
        }

        if (!this._agent) {
            this._reportProgress(AI_STAGES.ERROR, 'AI 模型未配置');
            callback('', false);
            callback('AI 模型未配置，请先配置 API Key', true);
            return { requestId: context.requestId, status: 'FAILED', error: 'AI 模型未配置' };
        }

        console.log(`[AIEngine] Starting tool-capable agent request ${context.requestId}`);
        this._reportProgress(AI_STAGES.TOOL_CALL, '准备执行 AI 调用...');
        return await this._sendMessageStreamAgent(
            userMessage,
            callback,
            context,
            collectedTexts,
            workspacePath
        );
    }

    private _startProgressTimer(request: AIRequestContext, stage: string, intervalMs: number = 30000): any {
        if (request.controller.signal.aborted) {
            return null;
        }
        let waitCount = 0;
        const timer = setInterval(() => {
            if (request.controller.signal.aborted) {
                this._stopProgressTimer(request, timer);
                return;
            }
            waitCount++;
            const elapsed = (waitCount * intervalMs) / 1000;
            const messages = [
                `AI 正在处理中，请稍候... (已等待 ${elapsed} 秒)`,
                `模型响应较慢，继续等待中... (${elapsed} 秒)`,
                `还在处理，请耐心等待... (${elapsed} 秒)`,
                `AI 正在思考，这个过程可能需要几分钟... (${elapsed} 秒)`,
                `继续等待响应中... (${elapsed} 秒)`
            ];
            const msg = messages[waitCount % messages.length];
            this._reportProgress(stage, msg);
        }, intervalMs);
        const timers = this._activeTimers.get(request.requestId) || new Set<any>();
        timers.add(timer);
        this._activeTimers.set(request.requestId, timers);
        return timer;
    }

    private _stopProgressTimer(request: AIRequestContext, timer: any): void {
        if (timer) {
            clearInterval(timer);
            this._activeTimers.get(request.requestId)?.delete(timer);
        }
    }

    private _clearAllTimers(request: AIRequestContext): void {
        const timers = this._activeTimers.get(request.requestId) || [];
        for (const timer of timers) {
            clearInterval(timer);
        }
        this._activeTimers.delete(request.requestId);
    }

    private _createAbortError(): Error {
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        return error;
    }

    private async _withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        description: string,
        request: AIRequestContext
    ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`请求超时 (${description})，已等待 ${timeoutMs / 1000} 秒`);
                error.name = 'TimeoutError';
                request.controller.abort(error);
                reject(error);
            }, timeoutMs);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * 带工具调用的 AI SDK Agent 模式
     */
    private async _sendMessageStreamAgent(
        userMessage: string,
        callback: AIStreamCallback,
        request: AIRequestContext,
        collectedTexts?: string,
        workspacePath?: string
    ): Promise<AIRequestResult> {
        if (!this._agent) {
            this._reportProgress(AI_STAGES.ERROR, 'Agent 未初始化');
            callback('', false);
            callback('需要工具调用但 Agent 未初始化', true);
            return { requestId: request.requestId, status: 'FAILED', error: 'Agent 未初始化' };
        }

        const REQUEST_TIMEOUT = 600000;
        const PROGRESS_INTERVAL = 10000;
        const startTime = Date.now();
        let progressTimer: any = null;
        let streamHandler: StreamHandler | null = null;
        let localProgressTimer = progressTimer;
        let streamIterator: AsyncIterator<AgentState> | undefined;

        const cleanup = async () => {
            if (streamHandler) {
                streamHandler.disable();
            }
            this._stopProgressTimer(request, localProgressTimer);
            this._clearAllTimers(request);
            try {
                await streamIterator?.return?.();
            } catch {
                // The agent may already have closed the iterator.
            }
        };

        try {
            if (this._logRoot) {
                console.log(`[RequestLogger] 本次请求日志: ${getRequestLogPath(this._logRoot, request.requestId)}`);
            }
            const contextReserve = this._getExecutionCompletionBudget();
            await this._requestLogger.write(this._logRoot, request.requestId, {
                event: 'request_start',
                data: {
                    model: this._config.model,
                    contextWindowTokens: this._tokenCounter.getContextWindowSize(),
                    providerCompletionLimit: 'default',
                    contextOutputReserveTokens: contextReserve.requestMaxTokens,
                    instruction: summarizeText(userMessage, this._tokenCounter),
                },
            });
            this._reportProgress(AI_STAGES.MODEL_INVOKE, 'AI 正在思考中，请稍候...');

            const inputMessages = await this._prepareHistory(userMessage, collectedTexts, workspacePath, request);
            inputMessages.push(new HumanMessage(userMessage));

            const delivery = new ResponseDelivery(callback);
            let lastMessagesState: BaseMessage[] = [];
            let lastAgentState: AgentState | undefined;
            let gotFirstToken = false;
            let lastUsage: ModelUsageSummary | undefined;

            streamHandler = new StreamHandler({
                onToken: (token: string) => {
                    if (request.controller.signal.aborted) {
                        return;
                    }
                    if (!gotFirstToken) {
                        const firstTokenTime = Date.now();
                        this._reportProgress(AI_STAGES.PROCESSING_RESULT, `已收到第一个 token (耗时 ${firstTokenTime - startTime}ms)`);
                        gotFirstToken = true;
                        this._stopProgressTimer(request, localProgressTimer);
                    }
                    if (token) {
                        delivery.push(token);
                    }
                }
            });

            let activeToolCalls = 0;
            const agentProgressCallbacks: AgentProgressCallbacks = {
                onToolStart: (toolName: string, detail?: string) => {
                    if (request.controller.signal.aborted) {
                        return;
                    }
                    activeToolCalls++;
                    this._stopProgressTimer(request, localProgressTimer);
                    this._reportProgress(
                        AI_STAGES.TOOL_EXECUTING,
                        detail || `正在执行工具: ${toolName}`
                    );
                },
                onToolEnd: (toolName: string) => {
                    if (request.controller.signal.aborted) {
                        return;
                    }
                    activeToolCalls = Math.max(0, activeToolCalls - 1);
                    if (activeToolCalls > 0) {
                        this._reportProgress(AI_STAGES.TOOL_EXECUTING, `工具 ${toolName} 已完成，仍有 ${activeToolCalls} 项查询正在执行...`);
                        return;
                    }
                    this._reportProgress(AI_STAGES.PROCESSING_RESULT, `工具 ${toolName} 执行完成，AI 正在处理结果...`);
                    localProgressTimer = this._startProgressTimer(request, AI_STAGES.WAITING_RESPONSE, PROGRESS_INTERVAL);
                },
                onRecovery: (detail: string) => {
                    if (request.controller.signal.aborted) {
                        return;
                    }
                    this._reportProgress(AI_STAGES.PROCESSING_RESULT, detail);
                }
            };

            const agentWithStream = createWritingAssistantAgent(
                this._config,
                this._fileSystem,
                this._fileWriteApprover,
                streamHandler,
                agentProgressCallbacks,
                this._ragManager,
                this._tokenCounter,
                undefined,
                this._transactionManager,
                undefined,
                undefined,
                this._requestLogger,
                { additionalTools: this._additionalTools }
            );

            localProgressTimer = this._startProgressTimer(request, AI_STAGES.WAITING_RESPONSE, PROGRESS_INTERVAL);

            const stream = agentWithStream.stream(
                {
                    messages: inputMessages,
                    collectedTexts,
                    workspacePath,
                    logRoot: this._logRoot,
                    projectMemory: request.projectMemory,
                    requestId: request.requestId,
                },
                {
                    signal: request.controller.signal,
                    metadata: { requestId: request.requestId, component: 'aiwriter', operation: 'agent.loop' },
                    tags: ['aiwriter', 'agent.loop'],
                }
            );

            const iterator = stream[Symbol.asyncIterator]();
            streamIterator = iterator;

            while (true) {
                if (request.controller.signal.aborted) {
                    throw this._createAbortError();
                }

                const elapsed = Date.now() - startTime;
                if (elapsed > REQUEST_TIMEOUT) {
                    const error = new Error(`请求超时（工具调用），已等待 ${elapsed / 1000} 秒`);
                    request.controller.abort(error);
                    throw error;
                }

                const nextPromise = iterator.next();
                let result: IteratorResult<AgentState>;

                try {
                    result = await this._withTimeout(
                        nextPromise,
                        REQUEST_TIMEOUT - elapsed,
                        `等待响应数据（已等待 ${elapsed}ms）`,
                        request
                    ) as IteratorResult<AgentState>;
                } catch (timeoutError) {
                    throw timeoutError;
                }

                if (request.controller.signal.aborted) {
                    throw this._createAbortError();
                }

                if (result.done) {
                    break;
                }

                const state = result.value;
                lastAgentState = state;
                const messages = state.messages || [];
                lastUsage = state.usage || lastUsage;

                if (messages.length > lastMessagesState.length) {
                    this._stopProgressTimer(request, localProgressTimer);

                    const newMessages = messages.slice(lastMessagesState.length);
                    for (const msg of newMessages) {
                        if (msg._getType() === 'ai') {
                            if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
                                const toolNames = msg.tool_calls.map((tc: any) => tc.name).join(', ');
                                this._reportProgress(AI_STAGES.TOOL_EXECUTING, `准备执行工具: ${toolNames}`);
                            }
                        } else if (msg._getType() === 'tool') {
                            this._reportProgress(AI_STAGES.PROCESSING_RESULT, `工具执行完成，等待 AI 响应...`);
                            localProgressTimer = this._startProgressTimer(request, AI_STAGES.WAITING_RESPONSE, PROGRESS_INTERVAL);
                        }
                    }
                    lastMessagesState = messages;
                }
            }

            this._stopProgressTimer(request, localProgressTimer);
            this._clearAllTimers(request);

            if (!gotFirstToken && delivery.content === '') {
                const lastMessage = lastMessagesState[lastMessagesState.length - 1];
                if (lastMessage && lastMessage._getType() === 'ai') {
                    const content = getVisibleMessageText(lastMessage);
                    if (content.trim() !== '') {
                        this._reportProgress(AI_STAGES.PROCESSING_RESULT, '收到 AI 最终回复');
                        delivery.acceptCompleteResponse(content);
                    }
                }
            }

            const finalMessage = [...lastMessagesState].reverse().find(message => message?._getType?.() === 'ai');
            const finishReason = finalMessage?.response_metadata?.finish_reason
                || finalMessage?.response_metadata?.finishReason;
            await cleanup();

            let usage = lastUsage && lastUsage.totalTokens > 0
                ? lastUsage
                : normalizeUsageMetadata(
                    undefined,
                    this._tokenCounter.countMessageLike(inputMessages),
                    this._tokenCounter.countTokens(delivery.content)
                );

            if (finishReason === 'content_filter') {
                const error = '响应被内容安全策略终止';
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'request_complete',
                    data: { status: 'FAILED', finishReason, error },
                });
                callback(error, true);
                return { requestId: request.requestId, status: 'FAILED', finishReason, error };
            }

            if (!delivery.content.trim()) {
                const error = finalMessage?.additional_kwargs?.reasoning_only_exhausted === true
                    ? '模型将本次输出全部用于隐藏推理，未生成可显示内容。插件已停止重复重试，请关闭该模型的思考模式或更换非推理模型。'
                    : '模型未返回可显示内容，请重新发送本次请求。';
                this._reportProgress(AI_STAGES.ERROR, error);
                this._updateTokenStats(usage);
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'empty_response_terminal',
                    node: 'engine',
                    data: {
                        status: 'FAILED',
                        finishReason,
                        contentType: describeMessageContent(finalMessage?.content),
                        emptyResponseFailure: finalMessage?.additional_kwargs?.empty_response_failure === true,
                        agentTurns: lastAgentState?.agentTurns,
                        toolCallCount: lastAgentState?.toolCallCount,
                        toolResultCount: lastAgentState?.toolResults?.length || 0,
                        usage,
                    },
                });
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'request_complete',
                    data: { status: 'FAILED', finishReason, error, usage },
                });
                callback(error, true);
                return { requestId: request.requestId, status: 'FAILED', finishReason, error };
            }

            if (!finishReason) {
                const error = '工具调用响应未包含正常结束标记，已按中断处理';
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'request_complete',
                    data: { status: 'INTERRUPTED', error },
                });
                callback('', true);
                return { requestId: request.requestId, status: 'INTERRUPTED', error };
            }

            const finalContent = delivery.content;
            this._reportProgress(AI_STAGES.COMPLETED, `响应完成 (总耗时 ${Date.now() - startTime}ms)`);
            this._updateTokenStats(usage);
            this._addMessage({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });
            this._addMessage({ role: 'assistant', content: finalContent, timestamp: new Date().toISOString(),
                modelContext: this._modelContext(finalMessage) });
            await this._requestLogger.write(this._logRoot, request.requestId, {
                event: 'request_complete',
                data: {
                    status: 'COMPLETED',
                    finishReason,
                    fileMutations: collectFileMutationSummaries(lastAgentState?.toolResults),
                    usage,
                    finalOutput: summarizeText(finalContent, this._tokenCounter),
                },
            });
            callback('', true);
            return { requestId: request.requestId, status: 'COMPLETED', finishReason };
        } catch (error) {
            await cleanup();
            const termination = classifyRequestTermination(error, request.controller.signal);
            if (termination?.status === 'FAILED') {
                this._reportProgress(AI_STAGES.ERROR, termination.error);
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'request_complete',
                    data: {
                        status: 'FAILED',
                        error: termination.error,
                        errorName: error instanceof Error ? error.name : undefined,
                        abortReason: request.controller.signal.reason instanceof Error
                            ? request.controller.signal.reason.message
                            : request.controller.signal.reason,
                    },
                });
                callback(termination.error, true);
                return { requestId: request.requestId, ...termination };
            }
            if (termination?.status === 'INTERRUPTED') {
                this._reportProgress(AI_STAGES.ERROR, '工具模式请求已中断');
                await this._requestLogger.write(this._logRoot, request.requestId, {
                    event: 'request_complete',
                    data: {
                        status: 'INTERRUPTED',
                        error: termination.error,
                        abortReason: request.controller.signal.reason instanceof Error
                            ? request.controller.signal.reason.message
                            : request.controller.signal.reason,
                    },
                });
                callback('', true);
                return { requestId: request.requestId, ...termination };
            }

            this._reportProgress(AI_STAGES.ERROR, '工具模式调用失败');
            const errorMsg = this._formatError(error);
            await this._requestLogger.write(this._logRoot, request.requestId, {
                event: 'request_complete',
                data: { status: 'FAILED', error: errorMsg },
            });
            callback('', false);
            callback(errorMsg, true);
            return { requestId: request.requestId, status: 'FAILED', error: errorMsg };
        }
    }

    loadHistory(messages: ChatMessage[], summary?: HistorySummary,
        onSummary?: (summary: HistorySummary) => Promise<void>): void {
        this._historyRevision++;
        this._history = [...messages];
        this._historySummary = validHistorySummary(messages, summary) ? summary : undefined;
        this._onHistorySummary = onSummary;
    }

    getHistory(): ChatMessage[] {
        return [...this._history];
    }

    clearHistory(): void {
        this._historyRevision++;
        this._history = [];
        this._historySummary = undefined;
        this._onHistorySummary = undefined;
    }

    private _modelContext(message: any): ChatMessage['modelContext'] {
        const content = message?.additional_kwargs?.ai_sdk_content;
        if (!Array.isArray(content) || !content.some(part => part.type === 'reasoning')) { return undefined; }
        return { baseUrl: cleanBaseUrl(this._config.baseUrl || '') || 'https://api.openai.com/v1',
            model: this._config.model, content };
    }

    private _addMessage(message: ChatMessage): void {
        this._history.push(message);
    }

    private async _prepareHistory(userMessage: string, collectedTexts: string | undefined,
        workspacePath: string | undefined, request: AIRequestContext) {
        const history = [...this._history];
        const previous = this._historySummary;
        const revision = this._historyRevision;
        const persist = this._onHistorySummary;
        const counter = this._tokenCounter;
        const window = counter.getContextWindowSize();
        const outputReserve = this._getExecutionCompletionBudget().requestMaxTokens;
        const safetyMargin = Math.min(1024, Math.max(128, Math.floor(window * 0.05)));
        // Leave room for tool schemas and new evidence in addition to fixed input.
        const fixed = counter.countTokens(getSystemPrompt(workspacePath))
            + counter.countTokens(request.projectMemory || '') + 160
            + counter.countTokens(userMessage) + counter.countTokens(collectedTexts || '');
        const budget = Math.max(0, window - outputReserve - safetyMargin - fixed
            - Math.max(512, Math.floor(window * 0.15)));
        const summaryMaxTokens = Math.min(2048, Math.floor(budget * 0.2));
        let summary = previous;
        try {
            if (summaryMaxTokens >= 128) {
                let model: ReturnType<typeof createChatModel> | undefined;
                const llm = { invoke: async (prompt: string) => {
                    model ??= this._summaryModelFactory({ apiKey: this._config.apiKey, baseUrl: this._config.baseUrl,
                        model: this._config.model, temperature: 0, streaming: false, timeoutMs: 120_000 });
                    this._reportProgress('history_summary', '正在压缩较早对话，保留近期原文...');
                    const response = await executeChatModelCall(() => model!.invoke(prompt,
                        createModelRunConfig('history_summary', request.requestId, request.controller.signal)),
                    { operation: 'history_summary', signal: request.controller.signal });
                    if (response.response_metadata?.finish_reason === 'length') {
                        throw new Error('历史摘要未完整生成');
                    }
                    return getVisibleMessageText(response);
                } };
                summary = await compactHistory({ history, previous, counter, llm, historyBudget: budget,
                    summaryMaxTokens, summaryInputBudget: Math.max(0, window - outputReserve - safetyMargin),
                    signal: request.controller.signal });
                if (summary && summary !== previous && revision === this._historyRevision) {
                    await persist?.(summary);
                    if (revision === this._historyRevision) { this._historySummary = summary; }
                }
            }
        } catch (error) {
            if (request.controller.signal.aborted) { throw error; }
            console.warn('[AIEngine] 历史摘要失败，保留已有摘要并使用预算裁剪:', error);
            currentRequestTelemetry()?.degrade('history_summary_failed');
            this._reportProgress('history_summary', '历史摘要未完成，将使用已有摘要和近期对话继续。');
            summary = previous;
        }
        return summaryMessages(history, summary);
    }

    private _formatError(error: any): string {
        console.error('[AI] 详细错误:', error);

        if (error instanceof Error) {
            const errMsg = error.message;
            const errName = (error as any).name || '';
            const status = (error as any).status || (error as any).statusCode || (error as any).response?.status;

            console.error(`[AI] 错误诊断: name=${errName}, status=${status}, message=${errMsg}`);

            if (status === 429 || errName === 'RateLimitError' || errMsg.includes('429') || errMsg.includes('RateLimit')) {
                return 'API 调用频率超限或配额不足。请等待一段时间后重试，或检查您的 API 配额。';
            }

            if (status === 401 || errName === 'AuthenticationError' || errMsg.includes('401') || errMsg.includes('API key') || errMsg.includes('unauthorized')) {
                return 'API Key 无效或已过期。请在设置中检查您的 API Key 配置。';
            }

            if (status === 404 || errMsg.includes('404')) {
                return 'API 地址或路径配置错误。请检查 Base URL 配置（NVIDIA 应为 https://integrate.api.nvidia.com/v1）。';
            }

            if (errMsg.includes('model') && (errMsg.includes('not found') || errMsg.includes('不存在'))) {
                return '模型不存在。请检查模型名称配置（NVIDIA 模型格式如: nvidia/nemotron-3-super-120b-a12b）。';
            }

            if (status === 400 || errName === 'BadRequestError' || errMsg.includes('400')) {
                return `请求参数错误。原始错误: ${errMsg}`;
            }

            if (status >= 500 || errName === 'InternalServerError') {
                return 'AI 服务暂时不可用（服务器错误）。请稍后重试。';
            }

            if (errMsg.includes('超时') || errMsg.includes('timeout') || errMsg.includes('Timeout')) {
                return `请求超时，已超过最大等待时间。请检查网络连接或 API 服务状态。原始错误: ${errMsg}`;
            }

            if (errMsg.includes('network') || errMsg.includes('connect') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED')) {
                return `网络连接失败。请检查网络连接、代理设置和 Base URL 配置。原始错误: ${errMsg}`;
            }

            return `AI 调用失败: ${errMsg}`;
        }

        return `AI 调用失败: ${String(error)}`;
    }

    /**
     * 计算并更新 token 统计，发送回调
     */
    private _updateTokenStats(usage: ModelUsageSummary): void {
        const inputTokens = usage.inputTokens;
        const outputTokens = usage.outputTokens;
        const totalTokens = usage.totalTokens || inputTokens + outputTokens;
        const lastContextTokens = usage.lastInputTokens + usage.lastOutputTokens;
        const contextUsagePercent = this._tokenCounter.getUsagePercentage(lastContextTokens) * 100;
        const shouldWarn = this._tokenCounter.shouldWarn(lastContextTokens);

        const stats: TokenStats = {
            inputTokens,
            outputTokens,
            totalTokens,
            contextUsagePercent,
            shouldWarn,
        };

        console.log(`[AIEngine] Token stats: input=${inputTokens}, output=${outputTokens}, total=${totalTokens}, usage=${contextUsagePercent.toFixed(1)}%, warn=${shouldWarn}`);

        if (this._tokenStatsCallback) {
            this._tokenStatsCallback(stats);
        }
    }

    /**
     * 获取当前 token 统计
     */
    getCurrentTokenStats(outputTokens: number = 0): TokenStats {
        const inputTokens = this._tokenCounter.countMessages(this._history);
        const totalTokens = inputTokens + outputTokens;
        const contextUsagePercent = this._tokenCounter.getUsagePercentage(totalTokens) * 100;
        const shouldWarn = this._tokenCounter.shouldWarn(totalTokens);

        return {
            inputTokens,
            outputTokens,
            totalTokens,
            contextUsagePercent,
            shouldWarn,
        };
    }

    private _getExecutionCompletionBudget() {
        return calculateCompletionTokenBudget({
            visibleOutputTokens: this._config.maxTokens,
            contextWindowTokens: this._tokenCounter.getContextWindowSize(),
            modelMaxOutputTokens: this._config.contextWindowDetection?.maxOutputTokens,
        });
    }

    dispose(): void {
        this._tokenCounter.dispose();
        console.log('[AIEngine] Disposed token counter');
    }
}

export function classifyRequestTermination(
    error: unknown,
    signal: AbortSignal
): { status: 'FAILED' | 'INTERRUPTED'; error: string } | undefined {
    const abortReason = signal.reason;
    const timeout = isTimeoutLike(error) || isTimeoutLike(abortReason);
    if (timeout) {
        const message = error instanceof Error && error.message
            ? error.message
            : abortReason instanceof Error && abortReason.message
                ? abortReason.message
                : '模型响应超时';
        return { status: 'FAILED', error: message };
    }
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return { status: 'INTERRUPTED', error: '请求已中断' };
    }
    return undefined;
}

function isTimeoutLike(value: unknown): boolean {
    if (!(value instanceof Error)) {
        return false;
    }
    return value.name === 'TimeoutError' || /超时|timed? out|timeout/i.test(value.message);
}

function describeMessageContent(content: unknown): string {
    if (Array.isArray(content)) {
        return `array:${content.map(item => {
            if (!item || typeof item !== 'object') {
                return typeof item;
            }
            return String((item as Record<string, unknown>).type || 'object');
        }).join(',')}`;
    }
    return content === null ? 'null' : typeof content;
}

export type { TokenStats } from '../../memory/token-counter';
export { TokenCounter } from '../../memory/token-counter';
