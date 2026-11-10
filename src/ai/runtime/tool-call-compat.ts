import type { ToolDef } from '../tools/tools';
import { AIMessage } from '../messages';

export interface TextToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: 'tool_call';
}

export interface ParsedTextToolCalls {
  toolCalls: TextToolCall[];
  visibleContent: string;
}

export function applyTextToolCallCompatibility(message: AIMessage, tools: ToolDef[]): AIMessage {
  const additionalToolCalls = message.additional_kwargs?.tool_calls;
  const hasStructuredCalls = Boolean(
    message.tool_calls?.length
    || (Array.isArray(additionalToolCalls) ? additionalToolCalls.length : additionalToolCalls)
    || message.additional_kwargs?.function_call
  );
  if (hasStructuredCalls || typeof message.content !== 'string') {
    return message;
  }

  const parsed = parseTextToolCalls(message.content, tools);
  if (!parsed) {
    return message;
  }
  return new AIMessage({
    content: parsed.visibleContent,
    tool_calls: parsed.toolCalls,
    additional_kwargs: message.additional_kwargs || {},
    response_metadata: message.response_metadata || {},
    usage_metadata: message.usage_metadata,
  });
}

const TOOL_BLOCK_PATTERN = /<(tool|invoke)\s+name\s*=\s*(["'])([^"']+)\2\s*>([\s\S]*?)<\/\1\s*>/gi;
const PARAMETER_PATTERN = /<parameter\s+([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
const ATTRIBUTE_PATTERN = /([\w-]+)\s*=\s*(["'])(.*?)\2/g;

/**
 * Compatibility fallback for OpenAI-compatible providers that serialize tool
 * calls as XML-like assistant text instead of returning API-level tool_calls.
 * Only complete <Tool> blocks are accepted; actual execution still goes through
 * the normal tool allow-list, workspace boundary checks, and write confirmation.
 */
export function parseTextToolCalls(content: string, tools: ToolDef[]): ParsedTextToolCalls | undefined {
  if (!content || !/<(?:tool|invoke)\s/i.test(content)) {
    return undefined;
  }

  const toolByNormalizedName = new Map(
    tools.map(tool => [normalizeIdentifier(tool.name), tool])
  );
  const toolCalls: TextToolCall[] = [];
  let match: RegExpExecArray | null;

  TOOL_BLOCK_PATTERN.lastIndex = 0;
  while ((match = TOOL_BLOCK_PATTERN.exec(content)) !== null) {
    const rawName = decodeXml(match[3]).trim();
    const tool = toolByNormalizedName.get(normalizeIdentifier(rawName));
    const name = tool?.name || rawName;
    const args = parseParameters(match[4], tool);
    toolCalls.push({
      id: `text_tool_${toolCalls.length}_${Date.now()}`,
      name,
      args,
      type: 'tool_call',
    });
  }

  if (toolCalls.length === 0) {
    return undefined;
  }

  return {
    toolCalls,
    visibleContent: content
      .replace(TOOL_BLOCK_PATTERN, '')
      .replace(/<tool_calls?>\s*<\/tool_calls?>/gi, '')
      .trim(),
  };
}

function parseParameters(body: string, tool?: ToolDef): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let match: RegExpExecArray | null;

  PARAMETER_PATTERN.lastIndex = 0;
  while ((match = PARAMETER_PATTERN.exec(body)) !== null) {
    const attributes = parseAttributes(match[1]);
    const rawName = attributes.name;
    if (!rawName) {
      continue;
    }
    const parameterName = normalizeParameterName(decodeXml(rawName), tool);
    const value = decodeXml(match[2]).trim();
    args[parameterName] = parseParameterValue(value, tool?.schema?.properties?.[parameterName]?.type);
  }

  return args;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTRIBUTE_PATTERN.lastIndex = 0;
  while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

function normalizeParameterName(rawName: string, tool?: ToolDef): string {
  const properties = Object.keys(tool?.schema?.properties || {});
  const normalized = normalizeIdentifier(rawName);
  const exact = properties.find(property => normalizeIdentifier(property) === normalized);
  if (exact) {
    return exact;
  }

  const aliases: Record<string, string[]> = {
    filepath: ['path', 'file', 'targetfile'],
    directory: ['path', 'targetdirectory', 'directorypath', 'rootdirectory', 'basepath'],
    baseDirectory: ['targetdirectory', 'directory', 'directorypath', 'rootdirectory', 'basepath'],
    searchText: ['query', 'text', 'searchquery'],
    query: ['searchtext', 'text', 'searchquery'],
    pattern: ['glob', 'globpattern', 'filenamepattern'],
    filePattern: ['glob', 'globpattern', 'filenamepattern'],
  };

  for (const property of properties) {
    if (aliases[property]?.includes(normalized)) {
      return property;
    }
  }
  return rawName;
}

function parseParameterValue(value: string, type?: string): unknown {
  if (type === 'boolean') {
    return value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : value;
  }
  if (type === 'number' || type === 'integer') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
