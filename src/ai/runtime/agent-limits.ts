import { AIMessage } from '../messages';
import type { AgentState, AgentLimits, AgentTextSink } from './agent-state';
import { DEFAULT_AGENT_LIMITS } from './agent-state';

export function getAgentLimitReason(
    state: { haltReason?: string; agentTurns?: number; toolCallCount?: number; usage?: { totalTokens: number } },
    limits: AgentLimits = DEFAULT_AGENT_LIMITS,
    contextWindowTokens = 20_000
): string | undefined {
    if (state.haltReason) {
        return state.haltReason;
    }
    if ((state.agentTurns || 0) >= limits.maxModelTurns) {
        return `模型轮数已达到上限（${limits.maxModelTurns} 轮）`;
    }
    if ((state.toolCallCount || 0) >= limits.maxToolCalls) {
        return `工具调用次数已达到上限（${limits.maxToolCalls} 次）`;
    }
    const cumulativeLimit = contextWindowTokens * limits.maxCumulativeTokensMultiplier;
    if ((state.usage?.totalTokens || 0) >= cumulativeLimit) {
        return `累计 Token 已达到单请求上限（${cumulativeLimit} tokens）`;
    }
    return undefined;
}

export function createStopStep(
    limits: AgentLimits,
    contextWindowTokens: number,
    streamHandler?: AgentTextSink
) {
    return async (state: AgentState) => {
        const reason = getAgentLimitReason(state, limits, contextWindowTokens) || '触发治理限制';
        const content = `为避免重复调用或费用失控，本次 Agent 已停止：${reason}。请缩小任务范围或调整指令后重试。`;
        if (streamHandler) {
            await streamHandler.handleLLMNewToken(content);
        }
        return {
            messages: [new AIMessage({
                content,
                additional_kwargs: { governance_halt: true },
                response_metadata: { finish_reason: 'stop' },
            })],
        };
    };
}
