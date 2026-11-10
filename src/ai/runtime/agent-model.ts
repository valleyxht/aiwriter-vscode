import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, BaseMessage } from '../messages';
import type { AIConfig } from '../../types';
import type { ToolDef } from '../tools/contract';
import type { TokenCounter } from '../../memory/token-counter';
import { createChatModel, createModelRunConfig, executeChatModelCall, openChatModelStream, MODEL_POLICY } from '../models/model-policy';
import { RequestJsonlLogger, summarizeText, summarizeToolArguments, type RequestLogSink } from './request-logger';
import { normalizeUsageMetadata, prepareMessagesForModel, type CompletionTokenBudget } from './token-budget';
import type { AgentState, AgentRunOptions, AgentProgressCallbacks, AgentOptions, AgentTextSink } from './agent-state';
import { currentRequestTelemetry } from './request-telemetry';
import { projectMessagesWithNormalizedEvidence } from './evidence-normalizer';
import { evidenceBudget, evidenceText, projectEvidenceContext } from './evidence-context';
import { EvidenceLedger } from '../tools/retrieval-evidence';
import { applyTextToolCallCompatibility } from './tool-call-compat';
import { VisibleTextStream } from './visible-text-stream';
import { accumulateAIMessageChunk, extractToolCalls, extractToolName, extractToolArgsSafely,
    getVisibleMessageText, getSystemPrompt, normalizeVisibleMessage } from './agent-messages';
import agentPrompts from './prompts/agent.json';
type ChatModelFactory = typeof createChatModel;

export function createModelWithTools(
    config: AIConfig,
    tools: ToolDef[],
    modelFactory: ChatModelFactory = createChatModel
) {
    const model = modelFactory({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.temperature,
        streaming: true,
        timeoutMs: MODEL_POLICY.toolChatTimeoutMs,
    });
    if (tools.length === 0) {
        return model;
    }
    return model.bind({
        tools: tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.schema
            }
        }))
    });
}

export function createModelStep(
    runtimeResolver: (state: AgentState) => { model: ReturnType<typeof createModelWithTools>; tools: ToolDef[]; toolSchemaText: string },
    tokenCounter: TokenCounter,
    completionBudget: CompletionTokenBudget,
    streamHandler?: AgentTextSink,
    finalAnswerOnly = false,
    requestLogger: RequestLogSink = new RequestJsonlLogger(),
    progressCallbacks?: AgentProgressCallbacks,
    options: AgentOptions = {}
) {
    return async (
        state: AgentState,
        runnableConfig?: AgentRunOptions
    ) => {
        const { model, tools, toolSchemaText } = runtimeResolver(state);
        const finalizationInstruction = finalAnswerOnly
            ? `\n\n工具使用阶段已经结束。原因：${state.finalizationReason || '工具调用额度已经用完'}\n你必须立即基于对话中已有的工具结果回答用户。不得请求、描述或模拟任何新的工具调用；明确区分已有证据、推断和尚未核实的部分；不得把未执行的调用说成已完成。`
            : '';
        const systemPrompt = (options.systemPrompt || getSystemPrompt(state.workspacePath)) + finalizationInstruction;
        const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

        if (state.projectMemory) {
            messages.push(new SystemMessage(
                `以下是工作区根目录 AIWRITER.md 中的长期项目说明。它用于帮助你定位资料，不代替原始文件；当前任务依赖且尚无可靠原文证据的具体事实才需要调用文件工具核实，已有对话证据无矛盾或变更迹象时不必重复查询。\n\n${state.projectMemory}`
            ));
        }

        if (options.referenceContext) { messages.push(new SystemMessage(options.referenceContext)); }

        // Attach request-scoped material to the latest user turn, before this
        // request's tool evidence. Project a copy so repeated model calls do not
        // accumulate attachments in agent state or alter conversation history.
        const requestMessages: BaseMessage[] = [...state.messages];
        if (state.collectedTexts) {
            for (let index = requestMessages.length - 1; index >= 0; index--) {
                const message = requestMessages[index];
                if (message._getType() !== 'human') { continue; }
                const attachment = `以下是本次用户请求的附件/选中文本（作为参考材料）：\n${state.collectedTexts}`;
                requestMessages[index] = new HumanMessage({
                    ...message,
                    content: typeof message.content === 'string'
                        ? `${message.content}\n\n${attachment}`
                        : [...message.content, { type: 'text', text: attachment }],
                });
                break;
            }
        }

        const ledger = state.evidenceLedger || options.evidence || currentRequestTelemetry()?.evidence || new EvidenceLedger(state.evidenceRecords);
        const sourceBudget = evidenceBudget(tokenCounter, options.evidenceTokenBudget);
        const projection = projectEvidenceContext(requestMessages, ledger, tokenCounter, sourceBudget, options.inheritedEvidence);
        messages.push(...projectMessagesWithNormalizedEvidence(projection.messages));
        if (state.retrievalStopped && !finalAnswerOnly) {
            messages.push(new SystemMessage((tools.length ? agentPrompts.retrievalStopped
                : agentPrompts.retrievalStoppedReadOnly).join('\n')));
        }

        // Keep this reminder transient: no history growth or extra model call.
        if (!finalAnswerOnly && state.agentTurns > 0
            && state.messages?.[state.messages.length - 1]?._getType() === 'tool') {
            messages.push(new SystemMessage(
                `本次请求已执行 ${state.toolCallCount || 0} 次工具调用。现在先做简短的充分性判断：已有材料是否足以完成用户当前要求？足够就直接完成回答。` +
                '若仍需工具，只针对会影响答案或执行结果的具体未决问题选择下一批操作；不要重新分析整个任务或预写最终答案。' +
                '新增文本不等于需要继续检索，也不要仅为增加引用、扩展背景或确认已有结论而补查。' +
                '确有证据缺口、矛盾、失败操作或尚未完成的用户要求时可以继续；全书任务仍须保证必要覆盖，文件操作仍须完成必要验证。'
            ));
        }

        const prepared = prepareMessagesForModel(messages, tokenCounter, {
            contextWindowTokens: tokenCounter.getContextWindowSize(),
            maxOutputTokens: completionBudget.requestMaxTokens,
            fixedOverheadText: toolSchemaText,
        });
        const actualInput = prepared.messages.map(message => String(message.content)).join('\n\n');
        ledger.importVisible(options.inheritedEvidence || [], actualInput);
        ledger.retainVisible(actualInput);
        const telemetry = currentRequestTelemetry();
        await requestLogger.write(state.logRoot, state.requestId || runnableConfig?.metadata?.requestId as string | undefined, {
            event: 'model_input', data: { operation: options.operation || 'agent', agentTurn: state.agentTurns + 1,
                estimatedInputTokens: prepared.inputTokens, evidenceTokenBudget: sourceBudget,
                sourceEvidenceTokens: projection.sourceTokens,
                carriedEvidenceTokens: ledger.records.reduce((total, record) => total + tokenCounter.countTokens(evidenceText(record)), 0),
                carriedEvidencePieces: ledger.records.length, omittedEvidencePieces: projection.omittedPieces,
                protectedOverflowTokens: projection.protectedOverflowTokens,
            },
        });
        if (prepared.droppedMessages || prepared.truncatedMessages) {
            console.warn(
                `[Agent] Token budget applied: dropped=${prepared.droppedMessages}, truncated=${prepared.truncatedMessages}, input=${prepared.inputTokens}/${prepared.inputBudget}`
            );
        }

        console.log('[Agent] 开始调用 AI 模型...');

        let response: AIMessage;
        const visibleStream = new VisibleTextStream();
        let streamedText = false;
        let structuredToolCall = false;
        let streamedTurn = false;
        let usageMetadata: AIMessage['usage_metadata'];
        const requestId = runnableConfig?.metadata?.requestId as string | undefined;
        const operation = options.operation || 'agent';
        const runConfig = createModelRunConfig(operation, requestId, runnableConfig?.signal);
        const modelStartedAt = Date.now();
        let firstTextAt: number | undefined;
        const emitText = async (text: string) => {
            if (!streamHandler) { return; }
            const first = text.trim() && firstTextAt === undefined;
            await streamHandler.handleLLMNewToken(text);
            if (first) { firstTextAt = Date.now(); }
        };

        if (streamHandler) {
            // 有 streamHandler 说明需要流式输出，使用 stream 而不是 invoke
            console.log('[Agent] Using streaming mode');
            const lease = await openChatModelStream(
                () => model.stream(prepared.messages, runConfig),
                { operation: `${operation}.stream.connect`, signal: runnableConfig?.signal }
            );
            let accumulatedChunk: AIMessageChunk | undefined;

            try {
                // Do not retry after streaming has started: replaying would duplicate tokens.
                for await (const chunk of lease.stream) {
                    if (runnableConfig?.signal?.aborted) {
                        const abortError = new Error('请求已取消');
                        abortError.name = 'AbortError';
                        throw abortError;
                    }
                    accumulatedChunk = accumulateAIMessageChunk(accumulatedChunk, chunk as AIMessageChunk);
                    usageMetadata = chunk.usage_metadata || usageMetadata;
                    structuredToolCall ||= extractToolCalls(chunk).length > 0
                        || !!chunk.tool_call_chunks?.length;
                    const text = visibleStream.push(getVisibleMessageText(chunk));
                    if (text && !structuredToolCall) {
                        if (!streamedTurn && state.agentTurns > 0
                            && state.messages.slice(state.messages.map((message: BaseMessage) => message._getType()).lastIndexOf('human') + 1)
                                .some((message: BaseMessage) => message._getType() === 'ai' && getVisibleMessageText(message).trim())) {
                            await emitText('\n\n');
                        }
                        streamedTurn = true;
                        streamedText = true;
                        await emitText(text);
                    }
                }
            } finally {
                lease.release();
            }

            response = new AIMessage({
                content: accumulatedChunk?.content || '',
                tool_calls: accumulatedChunk?.tool_calls || [],
                additional_kwargs: accumulatedChunk?.additional_kwargs || {},
                response_metadata: accumulatedChunk?.response_metadata || {},
                usage_metadata: accumulatedChunk?.usage_metadata
            });
        } else {
            // 不需要流式输出，直接 invoke
            console.log('[Agent] Using non-streaming mode');
            response = await executeChatModelCall(
                () => model.invoke(prepared.messages, runConfig),
                { operation: `${operation}.invoke`, signal: runnableConfig?.signal }
            );
            usageMetadata = response.usage_metadata;
        }

        response = normalizeVisibleMessage(response);
        const compatibleResponse = applyTextToolCallCompatibility(response, tools);
        if (compatibleResponse !== response) {
            console.warn('[Agent] Provider returned text-form tool calls; using compatibility parser');
            response = compatibleResponse;
        }
        if (streamHandler && extractToolCalls(response).length === 0) {
            // Keep the stored response and recovery path consistent with the
            // display filter, including incomplete compatibility tool blocks.
            const filter = new VisibleTextStream();
            response.content = filter.push(getVisibleMessageText(response)) + filter.push('', true);
        }

        const providerFinishReason = response.response_metadata?.finish_reason
            || response.response_metadata?.finishReason;
        const reasoningOnlyExhausted = isReasoningOnlyLengthResponse(
            response,
            usageMetadata || response.usage_metadata
        );
        if (!finalAnswerOnly && reasoningOnlyExhausted) {
            response = new AIMessage({
                content: '',
                additional_kwargs: {
                    ...(response.additional_kwargs || {}),
                    empty_response_failure: true,
                    reasoning_only_exhausted: true,
                },
                response_metadata: response.response_metadata || {},
                usage_metadata: response.usage_metadata,
            } as any);
        }
        if (finalAnswerOnly) {
            const content = getVisibleMessageText(response).trim();
            if (extractToolCalls(response).length > 0 || !content) {
                if (hasUsableToolResults(state.toolResults)) {
                    response = new AIMessage({
                        content: buildToolResultsFallback(
                            state.toolResults,
                            tokenCounter,
                            completionBudget.visibleOutputTokens
                        ),
                        additional_kwargs: { empty_response_recovered: true, governance_fallback: true },
                        response_metadata: { finish_reason: 'stop', provider_finish_reason: providerFinishReason },
                    });
                } else {
                    response = new AIMessage({
                        content: '',
                        additional_kwargs: { empty_response_failure: true },
                        response_metadata: {
                            ...(response.response_metadata || {}),
                            finish_reason: providerFinishReason || 'empty',
                        },
                    });
                }
            }
        }

        const visibleContent = getVisibleMessageText(response);
        const emptyWithoutToolCall = extractToolCalls(response).length === 0 && !visibleContent.trim();
        if (!finalAnswerOnly && emptyWithoutToolCall) {
            console.warn(reasoningOnlyExhausted
                ? '[Agent] Model exhausted its provider completion limit on hidden reasoning; skipping duplicate finalizer'
                : '[Agent] Model returned no visible content; switching to final answer recovery');
            if (!reasoningOnlyExhausted) {
                progressCallbacks?.onRecovery?.('模型未返回可显示内容，正在自动重新生成最终回答...');
            }
            await requestLogger.write(state.logRoot, requestId, {
                event: reasoningOnlyExhausted
                    ? 'reasoning_only_completion_exhausted'
                    : 'empty_response_detected',
                node: 'agent',
                data: {
                    agentTurn: (state.agentTurns || 0) + 1,
                    finishReason: providerFinishReason,
                    contentType: describeContentType(response.content),
                    toolResultCount: state.toolResults?.length || 0,
                    usage: summarizeUsageDetails(usageMetadata || response.usage_metadata),
                },
            });
        }
        if (finalAnswerOnly && emptyWithoutToolCall) {
            console.error('[Agent] Final answer recovery also returned no visible content');
            await requestLogger.write(state.logRoot, requestId, {
                event: 'empty_response_recovery_failed',
                node: 'finalize',
                data: {
                    agentTurn: (state.agentTurns || 0) + 1,
                    finishReason: providerFinishReason,
                    contentType: describeContentType(response.content),
                    usage: summarizeUsageDetails(usageMetadata || response.usage_metadata),
                },
            });
        }
        if (finalAnswerOnly && state.emptyResponseRecovery && !emptyWithoutToolCall) {
            await requestLogger.write(state.logRoot, requestId, {
                event: 'empty_response_recovered',
                node: 'finalize',
                data: {
                    agentTurn: (state.agentTurns || 0) + 1,
                    source: response.additional_kwargs?.empty_response_recovered
                        ? 'tool_results_fallback'
                        : 'model',
                    finishReason: response.response_metadata?.finish_reason
                        || response.response_metadata?.finishReason,
                    output: summarizeText(visibleContent, tokenCounter),
                },
            });
        }

        // Flush a split markup prefix without replaying text already delivered.
        if (streamHandler && extractToolCalls(response).length === 0) {
            const tail = visibleStream.push('', true);
            if (tail && !structuredToolCall) {
                await emitText(tail);
                streamedText = true;
            }
            const finalContent = getVisibleMessageText(response);
            if (finalContent && !streamedText) {
                await emitText(finalContent);
            }
        }

        console.log('[Agent] AI 模型调用完成');

        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('AI 决定调用工具:', response.tool_calls.map((tc: any) => tc.name));
        }

        const outputContent = getVisibleMessageText(response);
        if (!extractToolCalls(response).length && firstTextAt !== undefined && outputContent.trim()
            && !operation.startsWith('specialist.')) {
            telemetry?.markFinalAnswerStart(firstTextAt, state.agentTurns + 1);
        }
        const usage = normalizeUsageMetadata(
            usageMetadata || response.usage_metadata,
            prepared.inputTokens,
            tokenCounter.countTokens(outputContent)
        );
        await requestLogger.write(state.logRoot, requestId, {
            event: 'model_turn_complete',
            node: finalAnswerOnly ? 'finalize' : 'agent',
            data: {
                agentTurn: (state.agentTurns || 0) + 1,
                finalAnswerOnly,
                operation,
                firstTextElapsedMs: firstTextAt === undefined ? null : firstTextAt - modelStartedAt,
                finishReason: response.response_metadata?.finish_reason
                    || response.response_metadata?.finishReason,
                providerFinishReason,
                contentType: describeContentType(response.content),
                hasVisibleContent: !!outputContent.trim(),
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                usageDetails: summarizeUsageDetails(usageMetadata || response.usage_metadata),
                tokenBudget: completionBudget,
                output: summarizeText(outputContent, tokenCounter),
                toolCalls: extractToolCalls(response).map(call => ({
                    id: call.id,
                    name: extractToolName(call),
                    arguments: summarizeToolArguments(extractToolArgsSafely(call), tokenCounter),
                })),
            },
        });
        return {
            messages: [response],
            usage,
            agentTurns: 1,
            finalizationReason: !finalAnswerOnly && emptyWithoutToolCall
                && !reasoningOnlyExhausted
                ? '模型上一轮没有返回可显示内容，需要在不调用工具的情况下重新生成最终回答。'
                : undefined,
            emptyResponseRecovery: !finalAnswerOnly && emptyWithoutToolCall && !reasoningOnlyExhausted,
        };
    };
}

export function buildToolResultsFallback(toolResults: any[], tokenCounter: TokenCounter, maxOutputTokens: number): string {
    const successfulResults = (toolResults || [])
        .filter(item => item?.result?.status === 'success')
        .map((item, index) => `【资料 ${index + 1}：${item.tool || '工具'}】\n${item.result.content}`);
    if (successfulResults.length === 0) {
        return '本次资料检索已经结束，但没有获得可用于回答的有效结果。请换一个更明确的查询后重试。';
    }
    return tokenCounter.truncateText(
        `模型未能完成最后的资料整理。以下是本次已经取得的检索结果：\n\n${successfulResults.join('\n\n')}`,
        Math.max(256, maxOutputTokens)
    );
}

export function hasUsableToolResults(toolResults: any[]): boolean {
    return (toolResults || []).some(item => item?.result?.status === 'success');
}

export function describeContentType(content: unknown): string {
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

export function summarizeUsageDetails(metadata: any): Record<string, unknown> {
    return {
        inputTokens: metadata?.input_tokens ?? metadata?.prompt_tokens ?? metadata?.inputTokens,
        outputTokens: metadata?.output_tokens ?? metadata?.completion_tokens ?? metadata?.outputTokens,
        reasoningTokens: metadata?.output_token_details?.reasoning
            ?? metadata?.completion_tokens_details?.reasoning_tokens
            ?? metadata?.outputTokenDetails?.reasoning,
    };
}

export function isReasoningOnlyLengthResponse(response: any, metadata: any): boolean {
    const finishReason = response?.response_metadata?.finish_reason
        || response?.response_metadata?.finishReason;
    if (finishReason !== 'length' || getVisibleMessageText(response).trim()) {
        return false;
    }
    const usage = summarizeUsageDetails(metadata);
    const outputTokens = Number(usage.outputTokens);
    const reasoningTokens = Number(usage.reasoningTokens);
    return Number.isFinite(outputTokens)
        && outputTokens > 0
        && Number.isFinite(reasoningTokens)
        && reasoningTokens >= outputTokens;
}
