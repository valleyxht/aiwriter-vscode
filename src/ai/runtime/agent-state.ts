import type { BaseMessage } from '../messages';
import type { ToolDef, ToolResult } from '../tools/contract';
import type { EvidenceLedger, EvidencePiece } from '../tools/retrieval-evidence';
import type { ModelUsageSummary } from './token-budget';
import { addUsageSummaries, emptyUsageSummary } from './token-budget';

export interface AgentProgressCallbacks {
    onToolStart?: (toolName: string, detail?: string) => void;
    onToolEnd?: (toolName: string) => void;
    onRecovery?: (detail: string) => void;
}

export interface AgentLimits {
    maxModelTurns: number;
    maxToolCalls: number;
    maxRepeatedToolCalls: number;
    maxNoProgressRounds: number;
    maxCumulativeTokensMultiplier: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
    maxModelTurns: 12,
    maxToolCalls: 20,
    maxRepeatedToolCalls: 2,
    maxNoProgressRounds: 2,
    maxCumulativeTokensMultiplier: 3,
};

export interface AgentTextSink { handleLLMNewToken(text: string): Promise<unknown> }

export interface AgentRunOptions {
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    tags?: string[];
}

export interface AgentToolResult {
    tool: string;
    args: unknown;
    result: ToolResult;
    mutation?: unknown;
    fileMutations?: unknown[];
}

export interface AgentState {
    messages: BaseMessage[];
    collectedTexts?: string;
    workspacePath?: string;
    logRoot?: string;
    projectMemory?: string;
    requestId?: string;
    toolResults: AgentToolResult[];
    usage: ModelUsageSummary;
    agentTurns: number;
    toolCallCount: number;
    toolSignatures: string[];
    evidenceRecords: EvidencePiece[];
    evidenceLedger?: EvidenceLedger;
    retrievalStopped: boolean;
    noProgressCount: number;
    lastToolResultFingerprint: string;
    haltReason: string;
    finalizationReason: string;
    emptyResponseRecovery: boolean;
}

export type AgentInput = Pick<AgentState, 'messages'> & Partial<Omit<AgentState, 'messages'>>;

export interface AgentOptions {
    operation?: string;
    additionalTools?: ToolDef[];
    tools?: ToolDef[];
    systemPrompt?: string;
    referenceContext?: string;
    /** Specialist evidence is isolated from the main agent's already-read ledger. */
    evidence?: EvidenceLedger;
    inheritedEvidence?: EvidencePiece[];
    /** Source text carried per call, independent of the model's maximum window. */
    evidenceTokenBudget?: number;
}

export function initialAgentState(input: AgentInput): AgentState {
    return { toolResults: [], usage: emptyUsageSummary(), agentTurns: 0, toolCallCount: 0,
        toolSignatures: [], evidenceRecords: [], retrievalStopped: false, noProgressCount: 0,
        lastToolResultFingerprint: '', haltReason: '', finalizationReason: '', emptyResponseRecovery: false,
        ...input, messages: [...input.messages] };
}

/** Append protocol exchanges and cumulative counters; replace turn-local fields. */
export function advanceAgentState(state: AgentState, update: Partial<AgentState>): AgentState {
    return { ...state, ...update,
        messages: [...state.messages, ...(update.messages || [])],
        toolResults: [...state.toolResults, ...(update.toolResults || [])],
        toolSignatures: [...state.toolSignatures, ...(update.toolSignatures || [])],
        usage: addUsageSummaries(state.usage, update.usage),
        agentTurns: state.agentTurns + (update.agentTurns || 0),
        toolCallCount: state.toolCallCount + (update.toolCallCount || 0),
        retrievalStopped: state.retrievalStopped || !!update.retrievalStopped,
        finalizationReason: update.finalizationReason || state.finalizationReason,
        haltReason: update.haltReason || state.haltReason,
        emptyResponseRecovery: state.emptyResponseRecovery || !!update.emptyResponseRecovery,
    };
}
