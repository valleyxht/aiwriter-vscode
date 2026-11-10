/** Application message records. These classes only carry data; model calls,
 * tool execution, retries and tracing belong to their respective adapters. */
export type MessageContent = string | Array<Record<string, any>>;
export interface ToolCall { id?: string; name: string; args: Record<string, any>; type?: 'tool_call' }
export interface ToolCallChunk { id?: string; name?: string; args?: string; index?: number; type?: 'tool_call_chunk' }
export interface UsageMetadata {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_token_details?: { reasoning?: number };
}
interface MessageFields {
    content: MessageContent;
    id?: string;
    name?: string;
    additional_kwargs?: Record<string, any>;
    response_metadata?: Record<string, any>;
    usage_metadata?: UsageMetadata;
    tool_calls?: ToolCall[];
    invalid_tool_calls?: unknown[];
    tool_call_chunks?: ToolCallChunk[];
    tool_call_id?: string;
    status?: 'success' | 'error';
    artifact?: any;
}

export class BaseMessage {
    content: MessageContent;
    id?: string;
    name?: string;
    additional_kwargs: Record<string, any>;
    response_metadata: Record<string, any>;
    usage_metadata?: UsageMetadata;
    constructor(input: string | MessageFields, private readonly kind: string = 'system') {
        const fields = typeof input === 'string' ? { content: input } : input;
        this.content = fields.content;
        this.id = fields.id; this.name = fields.name;
        this.additional_kwargs = fields.additional_kwargs || {};
        this.response_metadata = fields.response_metadata || {};
        this.usage_metadata = fields.usage_metadata;
    }
    _getType(): string { return this.kind; }
    getType(): string { return this.kind; }
}
export class HumanMessage extends BaseMessage { constructor(input: string | MessageFields) { super(input, 'human'); } }
export class SystemMessage extends BaseMessage { constructor(input: string | MessageFields) { super(input, 'system'); } }
export class AIMessage extends BaseMessage {
    tool_calls: ToolCall[];
    invalid_tool_calls: unknown[];
    constructor(input: string | MessageFields) {
        super(input, 'ai');
        this.tool_calls = typeof input === 'string' ? [] : input.tool_calls || [];
        this.invalid_tool_calls = typeof input === 'string' ? [] : input.invalid_tool_calls || [];
    }
}
export class ToolMessage extends BaseMessage {
    tool_call_id: string;
    status?: 'success' | 'error';
    artifact?: any;
    constructor(input: MessageFields & { tool_call_id: string }) {
        super(input, 'tool');
        this.tool_call_id = input.tool_call_id; this.status = input.status; this.artifact = input.artifact;
    }
    static isInstance(message: unknown): message is ToolMessage { return message instanceof ToolMessage; }
}

/** SDK tool argument deltas are accumulated by index and parsed only as valid
 * JSON; malformed arguments are never repaired into an executable operation. */
export class AIMessageChunk extends AIMessage {
    tool_call_chunks: ToolCallChunk[];
    constructor(input: string | MessageFields) {
        super(input);
        this.tool_call_chunks = typeof input === 'string' ? [] : input.tool_call_chunks || [];
        if (this.tool_call_chunks.length) {
            this.tool_calls = this.tool_call_chunks.flatMap(chunk => {
                try {
                    const args = JSON.parse(chunk.args || '');
                    return chunk.name ? [{ id: chunk.id, name: chunk.name, args }] : [];
                } catch { return []; }
            });
        }
    }
    concat(next: AIMessageChunk): AIMessageChunk {
        const chunks = this.tool_call_chunks.map(chunk => ({ ...chunk }));
        for (const part of next.tool_call_chunks) {
            const existing = chunks.find(chunk => part.index !== undefined && chunk.index === part.index);
            if (existing) {
                existing.args = (existing.args || '') + (part.args || '');
                existing.name = existing.name || part.name; existing.id = existing.id || part.id;
            } else { chunks.push({ ...part }); }
        }
        const content = typeof this.content === 'string' && typeof next.content === 'string'
            ? this.content + next.content
            : [...(typeof this.content === 'string' ? (this.content ? [{ type: 'text', text: this.content }] : []) : this.content),
                ...(typeof next.content === 'string' ? (next.content ? [{ type: 'text', text: next.content }] : []) : next.content)];
        return new AIMessageChunk({ content, tool_call_chunks: chunks,
            tool_calls: chunks.length ? [] : [...this.tool_calls, ...next.tool_calls],
            additional_kwargs: { ...this.additional_kwargs, ...next.additional_kwargs },
            response_metadata: { ...this.response_metadata, ...next.response_metadata },
            usage_metadata: next.usage_metadata || this.usage_metadata,
        });
    }
}
