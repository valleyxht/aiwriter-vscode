import { defineTool, executeTool, toolSuccess, toolError, toolResultMessage } from '../../ai/tools/contract';
import * as path from 'path';
import { AIMessage, HumanMessage, SystemMessage } from '../../ai/messages';
import type { ToolSchema } from '../../ai/tools/contract';

function tool<T>(run: (args: T) => Promise<string> | string, fields: { name: string; description: string; schema: ToolSchema }) {
  return { ...fields, invoke: async (args: T) => run(args) };
}
import { createChatModel, createModelRunConfig, executeChatModelCall, MODEL_POLICY } from '../../ai/models';
import { applyTextToolCallCompatibility } from '../../ai/runtime/tool-call-compat';
import { exactRangeForLines, validateLosslessCoverage } from './analyzer';
import {
  AIConfigProvider, MarkdownDocument, ORGANIZATION_DIRECTORIES,
  OrganizationOperation, OrganizationPlan, SkippedDocument,
} from './types';

type Log = (message: string) => void;

export class MarkdownOrganizationAgent {
  constructor(private readonly configProvider: AIConfigProvider) {}

  async organize(
    sourceRoot: string,
    documents: MarkdownDocument[],
    signal?: AbortSignal,
    log: Log = () => undefined
  ): Promise<OrganizationPlan> {
    const config = this.configProvider();
    if (!config.apiKey.trim() || !config.model.trim()) {
      throw new Error('请先配置 AI 模型，整理 Agent 需要自行查看并判断 Markdown 文件');
    }
    const state = new OrganizationToolState(documents, log);
    const tools = state.createTools();
    const definitions = tools.map(item => defineTool({
      name: item.name, description: item.description, schema: item.schema,
      func: async (args) => {
        const result = await item.invoke(args);
        return toolSuccess(typeof result === 'string' ? result : JSON.stringify(result));
      },
    }));
    const toolByName = new Map(definitions.map(item => [item.name, item]));
    const model = createChatModel({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model,
      temperature: 0, streaming: false, timeoutMs: MODEL_POLICY.chatTimeoutMs });
    const modelWithTools = model.bind({ tools: definitions.map(item => ({ type: 'function' as const, function: { name: item.name, description: item.description, parameters: item.schema } })) });
    const messages: any[] = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(
      `整理源目录中的全部 Markdown 文件。源目录名称：${path.basename(sourceRoot)}。` +
      '先调用 listMarkdownDirectory，从根目录开始逐层检查；每个文件最终必须完整切分或明确跳过。'
    )];
    let toolCallCount = 0;
    let finished = false;
    for (let turn = 0; turn < 80; turn++) {
      const rawResponse = await executeChatModelCall(
        () => modelWithTools.invoke(messages, createModelRunConfig('markdown_organization_agent', undefined, signal)),
        { operation: 'markdown_organization_agent', signal, maxRetries: 1 }
      ) as AIMessage;
      const response = applyTextToolCallCompatibility(rawResponse, definitions);
      messages.push(response);
      const calls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
      if (calls.length === 0) {
        finished = true;
        break;
      }
      for (const call of calls) {
        toolCallCount++;
        if (toolCallCount > 300) {throw new Error('整理 Agent 工具调用次数超过安全上限');}
        const selectedTool = toolByName.get(call.name);
        const result = selectedTool
          ? await executeTool(selectedTool, call.args, signal)
          : toolError('unknown_tool', `未知工具 ${call.name}`);
        messages.push(toolResultMessage(result, call.id || `organization_${toolCallCount}`, call.name));
      }
    }
    if (!finished) {
      throw new Error('整理 Agent 在安全轮次上限内未能完成，请缩小所选目录后重试');
    }
    return state.finalize(sourceRoot);
  }
}

export class OrganizationToolState {
  private readonly documents = new Map<string, MarkdownDocument>();
  private readonly folders = new Set<string>();
  private readonly operations: OrganizationOperation[] = [];
  private readonly skipped = new Map<string, string>();
  private readonly targets = new Set<string>();

  constructor(documents: MarkdownDocument[], private readonly log: Log) {
    documents.forEach(document => this.documents.set(normalizeRelative(document.relativePath), document));
  }

  createTools(): any[] {
    return [
      tool(async ({ directory }: { directory?: string }) => this.listDirectory(directory || '.'), {
        name: 'listMarkdownDirectory',
        description: '列出源目录中某个相对目录的 Markdown 文件和子目录。只能读取，根目录使用 .。',
        schema: { type: 'object', properties: { directory: { type: 'string' } }, required: [] },
      } as any),
      tool(async ({ filepath, startLine, endLine }: { filepath: string; startLine?: number; endLine?: number }) =>
        this.readFile(filepath, startLine, endLine), {
        name: 'readMarkdownFile',
        description: '分页读取一个源 Markdown 文件，返回 metadata、Heading、总行数和带行号原文。每次最多读取 300 行。',
        schema: { type: 'object', properties: { filepath: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['filepath'] },
      } as any),
      tool(async ({ directory }: { directory: string }) => this.createFolder(directory), {
        name: 'createOrganizationFolder',
        description: '在整理结果中登记文件夹。第一层只能是 正文、人物、世界观、大纲、资料，可在其下建立分卷等子目录。',
        schema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] },
      } as any),
      tool(async (args: { sourcePath: string; startLine: number; endLine: number; targetPath: string }) =>
        this.splitFile(args), {
        name: 'splitMarkdownFile',
        description: '把源 Markdown 指定的连续原文行无损登记到新的 Markdown 文件。不会改写内容。一个源文件的全部调用最终必须从第1行连续覆盖到最后一行。目标父目录必须先创建。',
        schema: { type: 'object', properties: { sourcePath: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, targetPath: { type: 'string' } }, required: ['sourcePath', 'startLine', 'endLine', 'targetPath'] },
      } as any),
      tool(async ({ filepath, reason }: { filepath: string; reason: string }) => this.skipFile(filepath, reason), {
        name: 'skipMarkdownFile',
        description: '明确跳过不支持、混合或无法可靠整理的源 Markdown 文件，不生成任何内容。',
        schema: { type: 'object', properties: { filepath: { type: 'string' }, reason: { type: 'string' } }, required: ['filepath', 'reason'] },
      } as any),
    ];
  }

  finalize(sourceRoot: string): OrganizationPlan {
    const validOperations: OrganizationOperation[] = [];
    const skipped: SkippedDocument[] = [];
    for (const [relativePath, document] of this.documents) {
      const operations = this.operations.filter(operation => normalizeRelative(operation.sourceRelativePath) === relativePath);
      if (operations.length > 0) {
        if (validateLosslessCoverage(document, operations)) {validOperations.push(...operations);}
        else {skipped.push({ sourceRelativePath: document.relativePath, reason: 'AI 提交的切分存在遗漏、重叠或无法还原原文件，已拒绝' });}
      } else {
        skipped.push({ sourceRelativePath: document.relativePath, reason: this.skipped.get(relativePath) || 'AI 未处理该文件，已安全跳过' });
      }
    }
    return { sourceRoot, outputDirectoryName: 'AIWriter整理结果', operations: validOperations, skipped };
  }

  private listDirectory(directory: string): string {
    const normalizedDirectory = normalizeDirectory(directory);
    const prefix = normalizedDirectory ? `${normalizedDirectory}/` : '';
    const entries = new Map<string, 'directory' | 'markdown'>();
    for (const document of this.documents.values()) {
      const normalizedPath = normalizeRelative(document.relativePath);
      if (!normalizedPath.startsWith(prefix)) {continue;}
      const originalPath = document.relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
      const rest = originalPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      entries.set(slash >= 0 ? rest.slice(0, slash) : rest, slash >= 0 ? 'directory' : 'markdown');
    }
    const result = Array.from(entries, ([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
    this.log(`listMarkdownDirectory ${directory}: ${result.length} 项`);
    return JSON.stringify({ directory: normalizedDirectory || '.', entries: result });
  }

  private readFile(filepath: string, requestedStart?: number, requestedEnd?: number): string {
    const document = this.requireDocument(filepath);
    const startLine = requestedStart ?? 1;
    const endLine = Math.min(requestedEnd ?? (startLine + 299), startLine + 299, document.lineCount);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
      || startLine < 1 || startLine > document.lineCount || endLine < startLine) {
      throw new Error(`读取行号无效；文件共有 ${document.lineCount} 行`);
    }
    const lines = document.text.split(/\r\n|\n|\r/).slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`).join('\n');
    this.log(`readMarkdownFile ${document.relativePath} ${startLine}-${endLine}`);
    return JSON.stringify({ filepath: document.relativePath, metadata: document.metadata,
      headings: document.headings.map(({ level, line, text }) => ({ level, line, text })),
      totalLines: document.lineCount, returnedLines: [startLine, endLine], content: lines });
  }

  private createFolder(directory: string): string {
    const normalized = normalizeTarget(directory, false);
    this.folders.add(normalized.toLowerCase());
    this.log(`createOrganizationFolder ${normalized}`);
    return `已登记整理目录: ${normalized}`;
  }

  private splitFile(args: { sourcePath: string; startLine: number; endLine: number; targetPath: string }): string {
    const document = this.requireDocument(args.sourcePath);
    const sourceKey = normalizeRelative(document.relativePath);
    if (this.skipped.has(sourceKey)) {throw new Error('该文件已经标记为跳过');}
    const target = normalizeTarget(args.targetPath, true);
    const parent = path.posix.dirname(target).toLowerCase();
    if (!this.folders.has(parent)) {throw new Error(`目标父目录尚未创建，请先调用 createOrganizationFolder: ${path.posix.dirname(target)}`);}
    if (this.targets.has(target.toLowerCase())) {throw new Error(`目标文件重复: ${target}`);}
    const range = exactRangeForLines(document, args.startLine, args.endLine);
    const existing = this.operations.filter(operation => normalizeRelative(operation.sourceRelativePath) === sourceKey);
    if (existing.some(operation => range.startByte < operation.range.endByte && range.endByte > operation.range.startByte)) {
      throw new Error('该原文范围与已经登记的范围重叠');
    }
    this.operations.push({ sourcePath: document.sourcePath,
      sourceRelativePath: document.relativePath, sourceSha256: document.sourceSha256,
      targetRelativePath: target, range });
    this.targets.add(target.toLowerCase());
    this.log(`splitMarkdownFile ${document.relativePath}:${args.startLine}-${args.endLine} -> ${target}`);
    return `已登记无损切分: ${document.relativePath} 第${args.startLine}-${args.endLine}行 → ${target}`;
  }

  private skipFile(filepath: string, reason: string): string {
    const document = this.requireDocument(filepath);
    const key = normalizeRelative(document.relativePath);
    if (this.operations.some(operation => normalizeRelative(operation.sourceRelativePath) === key)) {
      throw new Error('该文件已经登记了切分操作，不能再跳过');
    }
    this.skipped.set(key, reason.slice(0, 300));
    this.log(`skipMarkdownFile ${document.relativePath}: ${reason}`);
    return `已跳过: ${document.relativePath}`;
  }

  private requireDocument(filepath: string): MarkdownDocument {
    const normalized = normalizeRelative(filepath);
    const document = this.documents.get(normalized);
    if (!document) {throw new Error(`找不到源 Markdown 文件: ${filepath}`);}
    return document;
  }
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(segment => segment === '.' || segment === '..')) {throw new Error(`无效相对路径: ${value}`);}
  return normalized.toLowerCase();
}
function normalizeDirectory(value: string): string {
  if (value === '.' || !value.trim()) {return '';}
  return normalizeRelative(value);
}
function normalizeTarget(value: string, requireMarkdown: boolean): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\u0000-\u001F]/.test(segment))) {
    throw new Error(`无效目标路径: ${value}`);
  }
  if (!ORGANIZATION_DIRECTORIES.some(directory => directory === segments[0])) {
    throw new Error(`第一层目录只能是: ${ORGANIZATION_DIRECTORIES.join('、')}`);
  }
  if (requireMarkdown && (!normalized.toLowerCase().endsWith('.md') || segments.length < 2)) {throw new Error('目标必须是固定分类目录下的 .md 文件');}
  return normalized;
}
const SYSTEM_PROMPT = `你是 Markdown 小说文件整理 Agent。你必须自己使用工具查看目录和文件，然后无损整理。
硬规则：
1. 只能处理现有 .md 文件；禁止改写、总结、补全、纠错或创造任何正文和设定。
2. 输出内容只能通过 splitMarkdownFile 从源文件连续行中复制。
3. 固定分类目录只有：正文、人物、世界观、大纲、资料；不要创建不存在内容的文件。
4. 每个支持的源文件必须从第1行到最后1行连续、无重叠、无遗漏地登记；整文件复制就使用 1 到 totalLines。
5. 不支持、混合或无法可靠判断的文件调用 skipMarkdownFile，不要勉强整理。
6. 先 listMarkdownDirectory，再按需 readMarkdownFile；长文件要分页读取。根据 metadata、Heading 和少量内容判断边界。
7. 先 createOrganizationFolder，再 splitMarkdownFile。目标文件名只能来自原文件名、已有 metadata 或已有 Heading，不得创造文学性标题。
8. 原文件永远保留。完成所有文件后停止调用工具。`;
