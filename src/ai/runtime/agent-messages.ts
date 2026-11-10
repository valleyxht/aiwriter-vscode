import { AIMessage, AIMessageChunk } from '../messages';
import { decodeToolArguments } from '../tools/contract';
import agentPrompts from './prompts/agent.json';

export function accumulateAIMessageChunk(
    current: AIMessageChunk | undefined,
    next: AIMessageChunk
): AIMessageChunk {
    return current ? current.concat(next) : next;
}

export function extractToolCalls(lastMessage: any): any[] {
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return lastMessage.tool_calls;
    }
    if (lastMessage.additional_kwargs?.tool_calls) {
        return lastMessage.additional_kwargs.tool_calls;
    }
    if (lastMessage.additional_kwargs?.function_call) {
        return [lastMessage.additional_kwargs.function_call];
    }
    return [];
}

/**
 * Extract only user-visible answer text. Reasoning/thinking blocks are
 * intentionally ignored so providers cannot accidentally expose hidden work.
 */

export function extractVisibleText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(extractVisibleText).filter(Boolean).join('');
    }
    if (!content || typeof content !== 'object') {
        return '';
    }
    const block = content as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
    if (/reasoning|thinking|analysis/.test(type)) {
        return '';
    }
    if (typeof block.text === 'string' && (!type || type === 'text' || type === 'output_text')) {
        return block.text;
    }
    if (block.text && typeof block.text === 'object') {
        const value = (block.text as Record<string, unknown>).value;
        if (typeof value === 'string' && (!type || type === 'text' || type === 'output_text')) {
            return value;
        }
    }
    if (typeof block.output_text === 'string') {
        return block.output_text;
    }
    return '';
}

export function getVisibleMessageText(message: any): string {
    const content = extractVisibleText(message?.content);
    if (content) {
        return content;
    }
    const additional = message?.additional_kwargs;
    if (typeof additional?.output_text === 'string') {
        return additional.output_text;
    }
    return '';
}

export function normalizeVisibleMessage(response: any): any {
    const visible = getVisibleMessageText(response);
    if (!visible || typeof response?.content === 'string') {
        return response;
    }
    return new AIMessage({
        content: visible,
        tool_calls: response.tool_calls || [],
        invalid_tool_calls: response.invalid_tool_calls || [],
        additional_kwargs: response.additional_kwargs || {},
        response_metadata: response.response_metadata || {},
        usage_metadata: response.usage_metadata,
        id: response.id,
        name: response.name,
    } as any);
}

export function extractToolName(call: any): string | undefined {
    return call.name || call.function?.name;
}

export function extractToolArgs(call: any): unknown {
    return decodeToolArguments(call.args ?? call.arguments ?? call.function?.arguments ?? {});
}

// Classifies tool capabilities, never the user's intent.

export function extractToolArgsSafely(call: any): unknown {
    try {
        return extractToolArgs(call);
    } catch {
        return {};
    }
}

export function getSystemPrompt(workspacePath?: string): string {
    return agentPrompts.main.join('\n') + (workspacePath ? `\n\n当前工作区路径：${workspacePath}` : '');
}
