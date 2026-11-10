import Ajv from 'ajv';
import { ToolMessage } from '../messages';
import type { ToolExecutionContext } from './tools';

export interface ToolSchema {
  type?: string;
  description?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: ToolSchema[];
  allOf?: ToolSchema[];
  if?: ToolSchema;
  then?: ToolSchema;
}

/** Status is authoritative; content is never parsed to determine the outcome. */
export interface ToolResult {
  status: 'success' | 'error' | 'rejected';
  code: string;
  content: string;
  data?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ToolSchema;
  func: (params: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<ToolResult>;
  maxCallsPerRequest?: number;
  progressMessage?: (params: Record<string, unknown>) => string;
}

export function toolSuccess(content: string, data?: unknown, code = 'ok'): ToolResult {
  return { status: 'success', code, content, ...(data === undefined ? {} : { data }) };
}

export function toolError(code: string, content: string): ToolResult {
  return { status: 'error', code, content };
}

export function toolRejected(code: string, content: string): ToolResult {
  return { status: 'rejected', code, content };
}

// No coercion, defaults or removal: invalid model arguments must not become writes.
const validator = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, strictNumbers: true });
const schemas = new WeakMap<ToolSchema, Ajv.ValidateFunction>();

export function validateToolArguments(schema: ToolSchema, args: unknown): ToolResult | undefined {
  let validate = schemas.get(schema);
  if (!validate) {
    validate = validator.compile(schema);
    schemas.set(schema, validate);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return toolError('invalid_arguments', '工具参数必须是 JSON 对象。');
  }
  if (!validate(args)) {
    // Do not echo user-provided values (which can contain prose or credentials).
    const issues = (validate.errors || []).slice(0, 8).map(error =>
      `${error.dataPath || '$'}: ${error.keyword}${'missingProperty' in error.params ? ` ${String(error.params.missingProperty)}` : ''}`);
    return toolError('invalid_arguments', `工具参数不符合声明：${issues.join('; ')}`);
  }
  return undefined;
}

/** Wrap at definition time so direct calls and all agent loops share the boundary. */
export function defineTool(definition: ToolDef): ToolDef {
  const schema = closeObjectSchemas(definition.schema);
  // Invalid declarations fail during registration rather than silently skipping checks.
  schemas.set(schema, validator.compile(schema));
  const tool = { ...definition, schema };
  return { ...tool, func: (args, signal, context) => executeTool(tool, args, signal, context) };
}

export function defineTools(definitions: ToolDef[]): ToolDef[] {
  return definitions.map(defineTool);
}

/** Invalid JSON remains invalid input for validation; never repair or substitute {}. */
export function decodeToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') { return value; }
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

export async function executeTool(
  tool: ToolDef,
  args: unknown,
  signal?: AbortSignal,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  throwIfToolAborted(signal);
  const invalid = validateToolArguments(tool.schema, args);
  if (invalid) { return invalid; }
  try {
    const result = await tool.func(args as Record<string, unknown>, signal, context);
    throwIfToolAborted(signal);
    if (!isToolResult(result)) {
      return toolError('invalid_tool_result', '工具返回了不符合契约的结果。');
    }
    return result;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) { throw error; }
    return toolError('tool_execution_failed', `工具执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== 'object') { return false; }
  const result = value as Partial<ToolResult>;
  return ['success', 'error', 'rejected'].includes(result.status || '')
    && typeof result.code === 'string' && result.code.length > 0 && typeof result.content === 'string';
}

export function toolResultMessage(result: ToolResult, callId: string, name?: string): ToolMessage {
  return new ToolMessage({
    content: result.status === 'success' ? result.content : `[${result.status}:${result.code}] ${result.content}`,
    tool_call_id: callId,
    name,
    status: result.status === 'success' ? 'success' : 'error',
    artifact: result,
  });
}

function closeObjectSchemas(schema: ToolSchema): ToolSchema {
  return {
    ...schema,
    ...(schema.type === 'object' ? { additionalProperties: schema.additionalProperties ?? false } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, closeObjectSchemas(value)])) } : {}),
    ...(schema.items ? { items: closeObjectSchemas(schema.items) } : {}),
    ...(schema.oneOf ? { oneOf: schema.oneOf.map(closeObjectSchemas) } : {}),
    ...(schema.allOf ? { allOf: schema.allOf.map(closeObjectSchemas) } : {}),
  };
}

export function throwIfToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
  }
}
