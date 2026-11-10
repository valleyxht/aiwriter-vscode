import { EvidenceLedger } from '../tools/retrieval-evidence';
import { currentRequestTelemetry } from './request-telemetry';
import type { AIConfig, IFileSystem } from '../../types';
import type { FileWriteApprover } from '../../features/file-approval';
import type { RagManager } from '../../memory/rag';
import type { FileTransactionManager } from '../../history';
import type { ToolDef } from '../tools/contract';
import { createFileTools, createRagTools } from '../tools/tools';
import { createWebSearchTools } from '../tools/web-search';
import { createChatModel } from '../models/model-policy';
import { TokenCounter } from '../../memory/token-counter';
import { calculateCompletionTokenBudget, serializeToolSchemas } from './token-budget';
import { RequestJsonlLogger, type RequestLogSink } from './request-logger';
import { createModelStep, createModelWithTools } from './agent-model';
import { createToolStep, isRetrievalTool } from './agent-tools';
import { createStopStep, getAgentLimitReason } from './agent-limits';
import { extractToolCalls, getVisibleMessageText } from './agent-messages';
import { advanceAgentState, initialAgentState, DEFAULT_AGENT_LIMITS,
    type AgentInput, type AgentState, type AgentLimits, type AgentRunOptions,
    type AgentTextSink, type AgentProgressCallbacks, type AgentOptions } from './agent-state';

export * from './agent-state';
export { accumulateAIMessageChunk, getVisibleMessageText, getSystemPrompt,
    extractVisibleText } from './agent-messages';
export { createToolCallSignature, classifyToolOutcome } from './agent-tools';
export { getAgentLimitReason } from './agent-limits';
type ChatModelFactory = typeof createChatModel;

export interface WritingAssistantAgent {
    invoke(input: AgentInput, options?: AgentRunOptions): Promise<AgentState>;
    stream(input: AgentInput, options?: AgentRunOptions): AsyncGenerator<AgentState>;
}

/** AI SDK owns model generation/streaming. This small controller owns the
 * product's tool batches, approvals, evidence limits and delivery recovery. */
export function createWritingAssistantAgent(
    config: AIConfig,
    fileSystem: IFileSystem,
    fileWriteApprover: FileWriteApprover,
    streamHandler?: AgentTextSink,
    progressCallbacks?: AgentProgressCallbacks,
    ragManager?: RagManager,
    tokenCounter?: TokenCounter,
    limits: AgentLimits = DEFAULT_AGENT_LIMITS,
    transactionManager?: FileTransactionManager,
    modelFactory: ChatModelFactory = createChatModel,
    webSearchToolFactory: typeof createWebSearchTools = createWebSearchTools,
    requestLogger: RequestLogSink = new RequestJsonlLogger(),
    options: AgentOptions = {}
) {
    const contextWindowTokens = tokenCounter?.getContextWindowSize()
        ?? Math.max(1_000, config.contextWindowSize * 1_000);
    const modelMaxOutputTokens = config.contextWindowDetection?.maxOutputTokens;
    const executionCompletionBudget = calculateCompletionTokenBudget({
        visibleOutputTokens: config.maxTokens,
        contextWindowTokens,
        modelMaxOutputTokens,
    });
    console.log(
        `[Agent] Provider completion limit: default; context output reserve=${executionCompletionBudget.requestMaxTokens}`
    );
    const evidenceTools: ToolDef[] = [];
    if (ragManager && ragManager.isReady) {
        evidenceTools.push(...createRagTools(ragManager));
    }
    if (config.webSearch) {
        evidenceTools.push(...webSearchToolFactory(config.webSearch));
    }
    const generalTools = options.tools ?? [...createFileTools(fileSystem, fileWriteApprover, transactionManager), ...evidenceTools, ...(options.additionalTools || [])];
    const generalRuntime = {
        model: createModelWithTools(config, generalTools, modelFactory),
        tools: generalTools,
        toolSchemaText: serializeToolSchemas(generalTools),
    };
    // Bind only when retrieval actually stops; specialist and mutation tools remain available.
    let deliveryRuntime: typeof generalRuntime | undefined;
    const resolveRuntime = (state: AgentState) => {
        if (!state.retrievalStopped) { return generalRuntime; }
        if (!deliveryRuntime) {
            const tools = generalTools.filter(tool => !isRetrievalTool(tool.name));
            deliveryRuntime = { model: createModelWithTools(config, tools, modelFactory), tools,
                toolSchemaText: serializeToolSchemas(tools) };
        }
        return deliveryRuntime;
    };
    const finalizerModel = createModelWithTools(config, [], modelFactory);
    const counter = tokenCounter || new TokenCounter(config.model, config.contextWindowSize);

    const modelStep = createModelStep(
        resolveRuntime,
        counter, executionCompletionBudget, streamHandler, false, requestLogger, progressCallbacks, options
    );
    const finalizerStep = createModelStep(
        () => ({ model: finalizerModel, tools: [], toolSchemaText: '' }),
        counter, executionCompletionBudget, streamHandler, true, requestLogger, progressCallbacks, options
    );
    const toolStep = createToolStep(
        () => generalTools,
        limits, progressCallbacks, fileSystem, counter, requestLogger, options.evidence
    );
    const stopStep = createStopStep(limits, counter.getContextWindowSize(), streamHandler);


    async function* stream(input: AgentInput, runOptions: AgentRunOptions = {}): AsyncGenerator<AgentState> {
        let state = initialAgentState(input);
        state.evidenceLedger = options.evidence || currentRequestTelemetry()?.evidence || new EvidenceLedger(input.evidenceRecords);
        const controller = new AbortController();
        const signal = runOptions.signal ? AbortSignal.any([runOptions.signal, controller.signal]) : controller.signal;
        const context = { ...runOptions, signal };
        const advance = (update: Partial<AgentState>) => { state = advanceAgentState(state, update); };
        try {
            signal.throwIfAborted();
            yield state;
            while (true) {
                signal.throwIfAborted();
                advance(await modelStep(state, context));
                signal.throwIfAborted();
                yield state;
                const last = state.messages[state.messages.length - 1];
                if (!extractToolCalls(last).length) {
                    if (getVisibleMessageText(last).trim() || last.additional_kwargs?.reasoning_only_exhausted) { return; }
                    advance(await finalizerStep(state, context));
                    signal.throwIfAborted();
                    yield state;
                    return;
                }
                if (getAgentLimitReason(state, limits, counter.getContextWindowSize())) {
                    advance(await stopStep(state));
                    signal.throwIfAborted();
                    yield state;
                    return;
                }
                advance(await toolStep(state, context));
                signal.throwIfAborted();
                yield state;
                if (state.haltReason) {
                    advance(await stopStep(state));
                    yield state;
                    return;
                }
                if (state.finalizationReason) {
                    advance(await finalizerStep(state, context));
                    signal.throwIfAborted();
                    yield state;
                    return;
                }
            }
        } finally {
            controller.abort();
        }
    }

    return {
        stream,
        async invoke(input: AgentInput, runOptions?: AgentRunOptions): Promise<AgentState> {
            let result: AgentState | undefined;
            for await (const state of stream(input, runOptions)) { result = state; }
            return result!;
        },
    } satisfies WritingAssistantAgent;
}
