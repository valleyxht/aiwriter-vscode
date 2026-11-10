import { BaseMessage, ToolMessage } from '../messages';
import { createHash } from 'node:crypto';
import type { ToolDef, ToolResult } from '../tools/contract';
import { executeTool, toolError, toolResultMessage } from '../tools/contract';
import { EvidenceLedger } from '../tools/retrieval-evidence';
import type { IFileSystem } from '../../types';
import type { TokenCounter } from '../../memory/token-counter';
import { currentRequestTelemetry } from './request-telemetry';
import { summarizeText, summarizeToolArguments, type RequestLogSink } from './request-logger';
import type { AgentState, AgentRunOptions, AgentLimits, AgentProgressCallbacks, AgentToolResult } from './agent-state';
import { extractToolCalls, extractToolName, extractToolArgs, extractVisibleText } from './agent-messages';
import agentPrompts from './prompts/agent.json';

function createToolMap(tools: ToolDef[]): Map<string, ToolDef> {
    return new Map(tools.map(tool => [tool.name, tool]));
}

export function isRetrievalTool(name: string): boolean {
    return ['readFile', 'searchFiles', 'searchInFiles', 'listFiles', 'searchStory', 'searchWeb', 'listResearchCatalog', 'readChapterSummary'].includes(name);
}

export function createToolStep(
    toolResolver: (state: AgentState) => ToolDef[],
    limits: AgentLimits,
    progressCallbacks: AgentProgressCallbacks | undefined,
    fileSystem: IFileSystem,
    tokenCounter: TokenCounter,
    requestLogger: RequestLogSink,
    localEvidence?: EvidenceLedger
) {
    return async (
        state: AgentState,
        runnableConfig?: AgentRunOptions
    ) => {
        const toolMap = createToolMap(toolResolver(state));
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1];
        const toolResults: AgentToolResult[] = [];
        const newMessages: BaseMessage[] = [];
        const newSignatures: string[] = [];
        const resultTexts: string[] = [];
        let executedCalls = 0;
        let haltReason = '';
        let finalizationReason = '';
        let retrievalStopped = !!state.retrievalStopped;
        const evidence = state.evidenceLedger || localEvidence || currentRequestTelemetry()?.evidence || new EvidenceLedger(state.evidenceRecords || []);
        const evidenceStart = evidence.added, duplicateStart = evidence.duplicates;
        let retrievalCalls = 0;
        const retrievalStats: unknown[] = [];

        const toolCalls = extractToolCalls(lastMessage);

        const outputs: { messages: BaseMessage[]; results: AgentToolResult[]; texts: string[] }[] = [];
        const pending: (() => Promise<void>)[] = [];
        const flush = async () => {
            const settled = await Promise.allSettled(pending.splice(0).map(run => run()));
            const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
            if (failed) { throw failed.reason; }
        };

        for (const call of toolCalls) {
            const funcName = extractToolName(call);
            // Mutations, specialists and unknown tools are barriers between read batches.
            if (!funcName || !isRetrievalTool(funcName)) { await flush(); }
            const newMessages: BaseMessage[] = [], toolResults: any[] = [], resultTexts: string[] = [];
            outputs.push({ messages: newMessages, results: toolResults, texts: resultTexts });
            if (runnableConfig?.signal?.aborted) {
                const abortError = new Error('请求已取消');
                abortError.name = 'AbortError';
                throw abortError;
            }
            console.log('原始工具调用:', JSON.stringify({ id: call.id, name: extractToolName(call) }));

            if ((state.toolCallCount || 0) + executedCalls >= limits.maxToolCalls) {
                finalizationReason = `工具调用次数已达到上限（${limits.maxToolCalls} 次），请基于已有证据完成回答，明确尚未核实之处。`;
                newMessages.push(createToolErrorMessage(call, '本次检索阶段已结束；此调用未执行，请使用已取得的资料。', 'budget_exhausted', 'tool_limit'));
                continue;
            }

            if (!funcName) {
                const result = '工具调用缺少工具名称，无法执行。请修正工具调用后重试。';
                newMessages.push(createToolErrorMessage(call, result, 'unknown_tool', 'unknown_tool'));
                resultTexts.push(result);
                executedCalls++;
                continue;
            }

            if (retrievalStopped && isRetrievalTool(funcName)) {
                newMessages.push(createToolErrorMessage(call, (toolResolver(state).some(tool => !isRetrievalTool(tool.name))
                    ? agentPrompts.retrievalStopped : agentPrompts.retrievalStoppedReadOnly).join('\n'), funcName, 'retrieval_stopped'));
                executedCalls++;
                continue;
            }

            let args: any;
            try {
                args = extractToolArgs(call);
            } catch (error) {
                const result = `工具参数解析失败: ${error instanceof Error ? error.message : String(error)}`;
                newMessages.push(createToolErrorMessage(call, result, funcName));
                resultTexts.push(result);
                executedCalls++;
                continue;
            }
            const effectiveArgs = args;
            const signature = createToolCallSignature(funcName, effectiveArgs);
            const previousCount = (state.toolSignatures || []).filter((item: string) => item === signature).length;
            const currentCount = newSignatures.filter(item => item === signature).length;
            if (previousCount + currentCount >= limits.maxRepeatedToolCalls) {
                const result = `工具 ${funcName} 使用相同参数已执行 ${limits.maxRepeatedToolCalls} 次，本次不再重复执行。请使用已有结果完成任务；需要创作、审核或文件交付时仍可调用相应工具。`;
                newMessages.push(createToolErrorMessage(call, result, funcName, 'tool_limit'));
                resultTexts.push(result);
                if (isRetrievalTool(funcName)) { retrievalStopped = true; }
                else { finalizationReason ||= result; }
                executedCalls++;
                continue;
            }
            const tool = toolMap.get(funcName);
            if (!tool) {
                const result = `未找到工具 ${funcName}。请只使用系统提供的工具。`;
                console.error(result);
                newMessages.push(createToolErrorMessage(call, result, funcName, 'unknown_tool'));
                resultTexts.push(result);
                executedCalls++;
                continue;
            }
            const previousToolCalls = (state.toolSignatures || [])
                .filter((item: string) => item.startsWith(`${funcName}:`)).length;
            const currentToolCalls = newSignatures
                .filter(item => item.startsWith(`${funcName}:`)).length;
            if (tool.maxCallsPerRequest && previousToolCalls + currentToolCalls >= tool.maxCallsPerRequest) {
                const result = `工具 ${funcName} 已达到本次请求的 ${tool.maxCallsPerRequest} 次调用额度，本次不再执行该调用。请使用已有结果完成任务；需要创作、审核或文件交付时仍可调用相应工具。`;
                console.warn(`[Agent] ${funcName} quota exhausted; skipping this tool`);
                newMessages.push(createToolErrorMessage(call, result, funcName, 'tool_limit'));
                resultTexts.push(result);
                if (!isRetrievalTool(funcName)) { finalizationReason ||= result; }
                executedCalls++;
                continue;
            }
            newSignatures.push(signature);
            console.log(`执行工具: ${funcName}, 参数摘要:`, JSON.stringify(summarizeToolArguments(args, tokenCounter)));

            const callNumber = (state.toolCallCount || 0) + executedCalls + 1;
            pending.push(async () => {
                if (runnableConfig?.signal?.aborted) {
                    const error = new Error('请求已取消'); error.name = 'AbortError'; throw error;
                }
                const requestId = runnableConfig?.metadata?.requestId as string | undefined;
                const startedAt = Date.now();
                const fileBefore = isMutationTool(funcName)
                    ? await captureFileSnapshot(fileSystem, effectiveArgs?.filepath, tokenCounter)
                    : undefined;
                await requestLogger.write(state.logRoot, requestId, {
                    event: 'tool_call_start',
                    node: 'tools',
                    data: {
                        callId: call.id,
                        tool: funcName,
                        callNumber,
                        arguments: summarizeToolArguments(effectiveArgs, tokenCounter),
                        writeMode: mutationMode(funcName),
                        fileBefore,
                    },
                });

                try {
                    if (progressCallbacks?.onToolStart) {
                        progressCallbacks.onToolStart(funcName, tool.progressMessage?.(effectiveArgs));
                    }

                    let reportedMutation: unknown;
                    const delegatedMutations: unknown[] = [];
                    if (['readFile', 'searchInFiles', 'searchStory'].includes(funcName)) { retrievalCalls++; }
                    const result = await executeTool(tool, effectiveArgs, runnableConfig?.signal, {
                        evidence,
                        agentInput: {
                            originalRequest: extractVisibleText([...state.messages].reverse().find((message: BaseMessage) => message._getType() === 'human')?.content),
                            suppliedContext: state.collectedTexts,
                            projectMemory: state.projectMemory,
                            workspacePath: state.workspacePath,
                        },
                        onRetrieval: (stats: unknown) => { retrievalStats.push(stats); },
                        requestId: runnableConfig?.metadata?.requestId as string | undefined,
                        onFileMutation: (mutation: unknown) => { reportedMutation = mutation; delegatedMutations.push(mutation); },
                    });
                    const toolMsg = toolResultMessage(result, call.id || `${funcName}_${Date.now()}`, funcName);

                    newMessages.push(toolMsg);
                    const resultText = result.content;
                    resultTexts.push(resultText);
                    toolResults.push({
                        tool: funcName,
                        args: effectiveArgs,
                        result,
                        ...(funcName === 'reviewWriting' ? { fileMutations: delegatedMutations } : {}),
                    });
                    const fileAfter = isMutationTool(funcName)
                        ? await captureFileSnapshot(fileSystem, effectiveArgs?.filepath, tokenCounter)
                        : undefined;
                    if (isMutationTool(funcName) && result.status === 'success') {
                        const lastResult = toolResults[toolResults.length - 1];
                        lastResult.mutation = reportedMutation || {
                            filepath: fileAfter?.filepath || fileBefore?.filepath,
                            changed: !!fileAfter?.exists && (
                                !fileBefore?.exists || fileBefore.text?.sha256 !== fileAfter.text?.sha256
                            ),
                            beforeExists: fileBefore?.exists,
                            afterExists: fileAfter?.exists,
                            beforeChars: fileBefore?.text?.chars,
                            afterChars: fileAfter?.text?.chars,
                            beforeSha256: fileBefore?.text?.sha256,
                            afterSha256: fileAfter?.text?.sha256,
                        };
                    }
                    await requestLogger.write(state.logRoot, requestId, {
                        event: 'tool_call_complete',
                        node: 'tools',
                        data: {
                            callId: call.id,
                            tool: funcName,
                            durationMs: Date.now() - startedAt,
                            outcome: result.status,
                            errorCode: result.code,
                            result: summarizeText(resultText, tokenCounter),
                            fileAfter,
                            fileDeltaChars: fileBefore?.text && fileAfter?.text
                                ? fileAfter.text.chars - fileBefore.text.chars
                                : undefined,
                            contentChanged: fileBefore && fileAfter
                                ? fileBefore.text?.sha256 !== fileAfter.text?.sha256
                                : undefined,
                        },
                    });
                } catch (executionError) {
                    if (runnableConfig?.signal?.aborted || (executionError instanceof Error && executionError.name === 'AbortError')) {
                        throw executionError;
                    }
                    console.error(`工具 ${funcName} 执行失败:`, executionError);
                    const result = `工具执行失败: ${executionError instanceof Error ? executionError.message : String(executionError)}`;
                    const errorMsg = toolResultMessage(toolError('tool_execution_failed', result), call.id || `${funcName}_${Date.now()}`, funcName);
                    newMessages.push(errorMsg);
                    resultTexts.push(result);
                    await requestLogger.write(state.logRoot, requestId, {
                        event: 'tool_call_failed',
                        node: 'tools',
                        data: {
                            callId: call.id,
                            tool: funcName,
                            durationMs: Date.now() - startedAt,
                            error: executionError instanceof Error ? executionError.message : String(executionError),
                        },
                    });
                } finally {
                    if (progressCallbacks?.onToolEnd) {
                        progressCallbacks.onToolEnd(funcName);
                    }
                }
            });
            executedCalls++;
            if (pending.length >= 3 || !isRetrievalTool(funcName)) { await flush(); }
        }
        await flush();
        for (const output of outputs) {
            newMessages.push(...output.messages);
            toolResults.push(...output.results);
            resultTexts.push(...output.texts);
        }

        if ((state.toolCallCount || 0) + executedCalls >= limits.maxToolCalls) {
            finalizationReason = '本次工具额度已用完，请基于已有证据回答，并明确尚未核实之处。';
        }

        const resultFingerprint = resultTexts.length > 0
            ? createHash('sha256').update(resultTexts.join('\n---\n')).digest('hex')
            : '';
        const noProgressCount = retrievalCalls > 0
            ? (evidence.added > evidenceStart ? 0 : (state.noProgressCount || 0) + 1)
            : (state.noProgressCount || 0);
        if (!haltReason && retrievalCalls > 0 && noProgressCount >= limits.maxNoProgressRounds) {
            retrievalStopped = true;
        }
        if (retrievalStopped && !state.retrievalStopped) {
            await requestLogger.write(state.logRoot, state.requestId, {
                event: 'retrieval_stopped', node: 'tools',
                data: { reasonCode: 'retrieval_no_progress', noProgressCount, deliveryToolsAvailable: true },
            });
        }

        if (retrievalCalls > 0) {
            await requestLogger.write(state.logRoot, runnableConfig?.metadata?.requestId as string | undefined, {
                event: 'retrieval_progress', node: 'tools', data: { added: evidence.added - evidenceStart, duplicates: evidence.duplicates - duplicateStart,
                    noProgressCount, reviews: retrievalStats },
            });
        }
        return {
            retrievalStopped,
            evidenceRecords: evidence.records,
            messages: newMessages,
            toolResults,
            toolCallCount: executedCalls,
            toolSignatures: newSignatures,
            noProgressCount,
            lastToolResultFingerprint: resultFingerprint,
            haltReason,
            finalizationReason,
        };
    };
}

export function createToolErrorMessage(call: any, content: string, fallbackName: string, code = 'invalid_arguments'): ToolMessage {
    return toolResultMessage(toolError(code, content), call?.id || `${fallbackName}_${Date.now()}`, fallbackName);
}

export function createToolCallSignature(toolName: string, args: unknown): string {
    return `${toolName}:${stableStringify(args)}`;
}

export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function isMutationTool(toolName: string): boolean {
    return toolName === 'createNewFile' || toolName === 'modifyFile';
}

export function mutationMode(toolName: string): string | undefined {
    if (toolName === 'createNewFile') {
        return 'create';
    }
    if (toolName === 'modifyFile') {
        return 'atomic-append-or-replace';
    }
    return undefined;
}

export async function captureFileSnapshot(
    fileSystem: IFileSystem,
    filepath: unknown,
    counter: TokenCounter
): Promise<{
    filepath?: string;
    exists: boolean;
    text?: ReturnType<typeof summarizeText>;
    error?: string;
} | undefined> {
    if (typeof filepath !== 'string' || !filepath.trim()) {
        return undefined;
    }
    try {
        const validation = await fileSystem.validatePath(filepath);
        if (!validation.success || !validation.content) {
            return { filepath, exists: false, error: validation.message };
        }
        const resolved = validation.content;
        const read = await fileSystem.readFile(resolved);
        if (!read.success) {
            return { filepath: resolved, exists: false };
        }
        return {
            filepath: resolved,
            exists: true,
            text: summarizeText(read.content || '', counter),
        };
    } catch (error) {
        return {
            filepath,
            exists: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function classifyToolOutcome(result: ToolResult): ToolResult['status'] {
    return result.status;
}
