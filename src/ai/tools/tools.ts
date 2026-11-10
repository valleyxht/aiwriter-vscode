import { defineTools, ToolDef, ToolResult, toolSuccess, toolError, toolRejected } from './contract';
export type { ToolDef } from './contract';
import { SEARCH_MAX_BYTES, utf8Prefix } from './search-context';
import { currentRequestTelemetry } from '../runtime/request-telemetry';
import { EvidenceLedger, EvidencePiece } from './retrieval-evidence';
import { stableHash } from '../../memory/rag/chunker';
import { boundedFileExcerpt } from './file-excerpt';
/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/tools.ts - AI 工具定义
 * 功能：定义 AI 可以调用的工具
 * 包含：
 *   - 读取文件
 *   - 创建文件
 *   - 编辑文件
 *   - 列出目录
*/
import { IFileSystem, SearchResult } from '../../types';
import { FileWriteApprover } from '../../features/file-approval';
import { RagManager } from '../../memory/rag';
import { FileTransactionManager } from '../../history';
import { summarizeToolArguments } from '../runtime/request-logger';
import { createHash } from 'node:crypto';
import type { FileMutationSummary } from '../runtime/file-mutations';
import { createWritingPreferenceTool } from '../../memory/project/writing-preferences';

export interface ToolExecutionContext {
    agentInput?: { originalRequest: string; suppliedContext?: string; projectMemory?: string; workspacePath?: string };
    evidence?: EvidenceLedger;
    onRetrieval?: (stats: { candidates: number; selected: number; duplicates: number; added: number; verified: boolean }) => void;
    requestId?: string;
    onFileMutation?: (mutation: FileMutationSummary) => void;
}

export type ModifyFileOperation =
    | { type: 'append'; content: string }
    | { type: 'replace'; oldText: string; newText: string; replaceAll?: boolean };

export interface ModifyFileApplicationResult {
    success: boolean;
    content: string;
    appliedOperations: number;
    error?: string;
    edits?: NonNullable<FileMutationSummary['edits']>;
}

export function applyModifyFileOperations(
    originalContent: string,
    operations: ModifyFileOperation[]
): ModifyFileApplicationResult {
    if (!Array.isArray(operations) || operations.length === 0) {
        return { success: false, content: originalContent, appliedOperations: 0, error: 'operations 不能为空' };
    }
    if (operations.length > 20) {
        return { success: false, content: originalContent, appliedOperations: 0, error: '单次最多执行 20 个修改操作' };
    }

    let content = originalContent;
    const edits: NonNullable<FileMutationSummary['edits']> = [];
    for (let index = 0; index < operations.length; index++) {
        const operation = operations[index] as ModifyFileOperation;
        if (operation?.type === 'append') {
            if (typeof operation.content !== 'string' || operation.content.length === 0) {
                return {
                    success: false,
                    content: originalContent,
                    appliedOperations: 0,
                    error: `operations[${index}].content 不能为空`,
                };
            }
            const start = content.length;
            content += operation.content;
            edits.push({
                kind: 'append',
                startBefore: start,
                endBefore: start,
                startAfter: start,
                endAfter: content.length,
                insertedText: operation.content,
            });
            continue;
        }
        if (operation?.type === 'replace') {
            if (typeof operation.oldText !== 'string' || operation.oldText.length === 0) {
                return {
                    success: false,
                    content: originalContent,
                    appliedOperations: 0,
                    error: `operations[${index}].oldText 不能为空`,
                };
            }
            if (typeof operation.newText !== 'string') {
                return {
                    success: false,
                    content: originalContent,
                    appliedOperations: 0,
                    error: `operations[${index}].newText 必须是字符串`,
                };
            }
            if (!content.includes(operation.oldText)) {
                return {
                    success: false,
                    content: originalContent,
                    appliedOperations: 0,
                    error: `operations[${index}] 未找到完全匹配的 oldText，文件未修改`,
                };
            }
            let searchFrom = 0;
            do {
                const start = content.indexOf(operation.oldText, searchFrom);
                if (start < 0) {
                    break;
                }
                const endBefore = start + operation.oldText.length;
                content = content.slice(0, start) + operation.newText + content.slice(endBefore);
                edits.push({
                    kind: 'replace',
                    startBefore: start,
                    endBefore,
                    startAfter: start,
                    endAfter: start + operation.newText.length,
                    insertedText: operation.newText,
                });
                searchFrom = start + operation.newText.length;
                if (!operation.replaceAll) {
                    break;
                }
            } while (searchFrom <= content.length);
            continue;
        }
        return {
            success: false,
            content: originalContent,
            appliedOperations: 0,
            error: `operations[${index}].type 只支持 append 或 replace`,
        };
    }
    return { success: true, content, appliedOperations: operations.length, edits };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        throw error;
    }
}

/**
 * Read-only workspace tools for specialized workers. Mutation tools are not
 * constructed at all, so a worker cannot reach them through prompt mistakes.
 */
function deliverRead(result: { content?: string; filepath?: string; version?: string }, filepath: string, params: any, context?: ToolExecutionContext): string {
    context = { ...context, evidence: context?.evidence || currentRequestTelemetry()?.evidence };
    const text = result.content || '';
    if (!context?.evidence) { return boundedFileExcerpt(text, params?.offset, params?.maxChars); }
    const start = Number.isSafeInteger(params?.offset) && params.offset >= 0 ? params.offset : 0;
    const size = Number.isSafeInteger(params?.maxChars) && params.maxChars > 0 ? Math.min(params.maxChars, 30000) : 6000;
    if (start >= text.length) { return text.length ? '起始位置已超出文件末尾。' : '文件为空'; }
    const end = Math.min(text.length, start + size);
    const scope = `[文件片段：字符 ${start}～${end}（末端不含），共 ${text.length} 字符。${end === text.length ? '已到文件末尾。' : `尚有未读内容；下一页 offset=${end}。仅在任务仍缺必要证据时补读。`}]`;
    return `${scope}\n${context.evidence.deliver([{ filepath: result.filepath || filepath, version: result.version || stableHash(text),
        start, end, content: text.slice(start, end) }], size)}`;
}

function deliverSearch(result: SearchResult & { content?: string }, context?: ToolExecutionContext): ToolResult {
    context = { ...context, evidence: context?.evidence || currentRequestTelemetry()?.evidence };
    if (!result.success) { return toolError('search_failed', `搜索内容失败: ${result.message}`); }
    const suffix = '\n结果达到 50 KiB 上限，部分内容未返回；如缺少必要证据，请缩小文件范围或减少上下文行数。';
    let output: string;
    if (!context?.evidence || !result.matches?.every(m => m.charStart !== undefined && m.charEnd !== undefined && m.version)) {
        output = result.content || result.message;
    } else {
        output = context.evidence.deliver(result.matches.map(m => ({ filepath: m.filepath, version: m.version!,
            start: m.charStart!, end: m.charEnd!, content: m.text })), Number.MAX_SAFE_INTEGER, SEARCH_MAX_BYTES - 1024);
    }
    const truncated = result.truncated || Buffer.byteLength(output, 'utf8') > SEARCH_MAX_BYTES - 1024;
    return toolSuccess(utf8Prefix(output, SEARCH_MAX_BYTES - 1024) + (truncated ? suffix : ''));
}

export function createReadOnlyFileTools(fileSystem: IFileSystem): ToolDef[] {
    return defineTools([
        {
            name: 'readFile',
            description: '分页读取文本，默认最多 6000 字符，最多 30000。人物或情节问题优先 searchStory/searchInFiles 定位，禁止为局部问题逐页遍历整本小说。offset 是从 0 开始的字符偏移。',
            schema: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', minLength: 1, pattern: '\\S', description: '文件路径' },
                    expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$', description: '使用摘要目录给出的字符位置时必须携带其原文版本；变化则停止使用旧位置' },
                    offset: { type: 'integer', minimum: 0, description: '字符起始偏移，默认 0' },
                    maxChars: { type: 'integer', minimum: 1, maximum: 30000, description: '本次最多字符数，默认 6000' }
                },
                required: ['filepath']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const filepath = extractStringParam(params, 'filepath');
                if (!filepath) {
                    return toolError('invalid_arguments', `参数错误: filepath 为空或无效`);
                }
                const result = await fileSystem.readFile(filepath);
                throwIfAborted(signal);
                if (result.success && params.expectedSha256 && createHash('sha256').update(result.content || '').digest('hex') !== params.expectedSha256) {
                    return toolError('source_changed', '正文版本已变化，未按旧位置读取。请重新读取章节摘要核对位置，或用 searchInFiles 定位当前正文。');
                }
                return result.success ? toolSuccess(deliverRead(result, filepath, params, context)) : toolError('read_failed', `读取失败: ${result.message}`);
            }
        },
        {
            name: 'listFiles',
            description: '列出当前工作区某个目录中的文件。参数: directory (相对工作区或完整路径)',
            schema: {
                type: 'object',
                properties: {
                    directory: { type: 'string', minLength: 1, pattern: '\\S', description: '目录路径；工作区根目录可使用 .' }
                },
                required: ['directory']
            },
            maxCallsPerRequest: 2,
            func: async (params: any, signal?: AbortSignal, _context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const directory = extractStringParam(params, 'directory');
                if (!directory) {
                    return toolError('invalid_arguments', `参数错误: directory 为空或无效`);
                }
                const result = await fileSystem.listFiles(directory);
                return result.success ? toolSuccess(result.content || '目录为空') : toolError('list_failed', `列出目录失败: ${result.message}`);
            }
        },
        {
            name: 'searchFiles',
            description: '按 glob 搜索当前工作区的文件名。参数: baseDirectory, pattern',
            schema: {
                type: 'object',
                properties: {
                    baseDirectory: { type: 'string', minLength: 1, pattern: '\\S', description: '搜索目录；工作区根目录可使用 .' },
                    pattern: { type: 'string', minLength: 1, pattern: '\\S', description: 'glob 模式，例如 **/*.md' }
                },
                required: ['baseDirectory', 'pattern']
            },
            maxCallsPerRequest: 2,
            func: async (params: any, signal?: AbortSignal, _context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const baseDirectory = extractStringParam(params, 'baseDirectory');
                const pattern = extractStringParam(params, 'pattern');
                if (!baseDirectory || !pattern) {
                    return toolError('invalid_arguments', `参数错误: baseDirectory 或 pattern 为空`);
                }
                const result = await fileSystem.searchFiles(baseDirectory, pattern);
                return result.success ? toolSuccess(result.content || '未找到匹配的文件') : toolError('search_failed', `搜索文件失败: ${result.message}`);
            }
        },
        {
            name: 'searchInFiles',
            description: '有明确名称、术语或原句时优先精确搜索正文。有明确缺口才用 searchStory。',
            schema: {
                type: 'object',
                properties: {
                    baseDirectory: { type: 'string', minLength: 1, pattern: '\\S', description: '搜索目录；工作区根目录可使用 .' },
                    searchText: { type: 'string', minLength: 1, pattern: '\\S', description: '要搜索的文本' },
                    filePattern: { type: 'string', description: '可选文件模式，例如 *.md' },
                    contextLines: { type: 'integer', minimum: 0, description: '每处命中前后各返回多少行，默认 0（完整命中行）。按需要选择；重叠范围合并，单次最多 50 KiB。' }
                },
                required: ['baseDirectory', 'searchText']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const baseDirectory = extractStringParam(params, 'baseDirectory');
                const searchText = extractStringParam(params, 'searchText');
                const filePattern = extractStringParam(params, 'filePattern');
                if (!baseDirectory || !searchText) {
                    return toolError('invalid_arguments', `参数错误: baseDirectory 或 searchText 为空`);
                }
                const result = await fileSystem.searchInFiles(
                    baseDirectory,
                    searchText,
                    filePattern || undefined,
                    params.contextLines ?? 0
                );
                const searchResult = result as SearchResult & { content?: string };
                return deliverSearch(searchResult, context);
            }
        }
    ]);
}

export function createFileTools(
    fileSystem: IFileSystem,
    fileWriteApprover: FileWriteApprover,
    transactionManager?: FileTransactionManager
): ToolDef[] {
    return defineTools([
        createWritingPreferenceTool(fileSystem, fileWriteApprover, transactionManager),
        {
            name: 'readFile',
            description: '分页读取文本，默认最多 6000 字符，最多 30000。人物或情节问题优先 searchStory/searchInFiles 定位，禁止为局部问题逐页遍历整本小说。offset 是从 0 开始的字符偏移。',
            schema: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', minLength: 1, pattern: '\\S', description: '文件的完整路径' },
                    offset: { type: 'integer', minimum: 0, description: '字符起始偏移，默认 0' },
                    maxChars: { type: 'integer', minimum: 1, maximum: 30000, description: '本次最多字符数，默认 6000' }
                },
                required: ['filepath']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                // 容错处理
                let filepath = extractStringParam(params, 'filepath');
                if (!filepath) {
                    return toolError('invalid_arguments', `参数错误: filepath 为空或无效`);
                }
                const result = await fileSystem.readFile(filepath);
                throwIfAborted(signal);
                return result.success ? toolSuccess(deliverRead(result, filepath, params, context)) : toolError('read_failed', `读取失败: ${result.message}`);
            }
        },
        {
            name: 'createNewFile',
            description: '创建新文件。如果父目录不存在会自动创建。只用于新建文件，不要用于编辑已有文件。参数: filepath (文件完整路径), content (文件内容)',
            schema: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', minLength: 1, pattern: '\\S', description: '新文件的完整路径，包含文件名' },
                    content: { type: 'string', description: '文件内容' }
                },
                required: ['filepath', 'content']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                console.log('createNewFile 收到参数摘要:', JSON.stringify(summarizeToolArguments(params)));

                // 容错处理
                let filepath = extractStringParam(params, 'filepath');
                const content = params.content as string;

                if (!filepath) {
                    return toolError('invalid_arguments', `参数错误: filepath 为空或无效`);
                }

                const pathValidation = await fileSystem.validatePath(filepath);
                if (!pathValidation.success || !pathValidation.content) {
                    return toolError('invalid_path', `创建失败: ${pathValidation.message}`);
                }
                filepath = pathValidation.content;

                const exists = await fileSystem.fileExists(filepath);
                if (exists) {
                    return toolError('file_exists', `文件已存在: ${filepath}，请使用 modifyFile 修改该文件`);
                }
                const approved = await fileWriteApprover.confirmFileWrite(filepath, 'create', '', content, signal, {
                    requestId: context?.requestId,
                });
                throwIfAborted(signal);
                if (!approved) {
                    return toolRejected('user_rejected', `用户已拒绝创建文件: ${filepath}`);
                }
                const result = await transactionManager?.executeWrite(
                    context?.requestId,
                    filepath,
                    content,
                    () => fileSystem.createFile(filepath, content)
                ) || await fileSystem.createFile(filepath, content);
                if (result.success) {
                    const afterSha256 = createHash('sha256').update(content).digest('hex');
                    context?.onFileMutation?.({
                        tool: 'createNewFile',
                        filepath,
                        mode: 'create',
                        changed: true,
                        beforeExists: false,
                        afterExists: true,
                        beforeChars: 0,
                        afterChars: content.length,
                        afterSha256,
                        edits: [{
                            kind: 'create',
                            startBefore: 0,
                            endBefore: 0,
                            startAfter: 0,
                            endAfter: content.length,
                            insertedText: content,
                        }],
                    });
                }
                return result.success ? toolSuccess(`成功创建文件: ${filepath}`) : toolError('write_failed', `创建失败: ${result.message}`);
            }
        },
        {
            name: 'modifyFile',
            description: '原子修改已有文件。长篇续写使用 append；局部编辑使用 replace 精确替换 oldText。可一次提交多个 operations，任一操作校验失败则整个文件不修改。不要传入完整文件覆盖。参数: filepath, operations, expectedSha256 (可选)',
            schema: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', minLength: 1, pattern: '\\S', description: '文件的完整路径' },
                    expectedSha256: { type: 'string', description: '可选：读取文件时获得的 SHA-256；不一致时拒绝修改' },
                    operations: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 20,
                        description: '按顺序执行的修改操作',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['append', 'replace'] },
                                content: { type: 'string', description: 'append 时必填：追加到文件末尾的内容' },
                                oldText: { type: 'string', description: 'replace 时必填：必须与文件现有内容完全匹配' },
                                newText: { type: 'string', description: 'replace 时必填：替换后的内容；空字符串表示删除' },
                                replaceAll: { type: 'boolean', description: 'replace 时可选：是否替换全部匹配，默认 false' }
                            },
                            required: ['type'],
                            allOf: [
                                { if: { properties: { type: { const: 'append' } } }, then: { required: ['content'], properties: { content: { minLength: 1 } } } },
                                { if: { properties: { type: { const: 'replace' } } }, then: { required: ['oldText', 'newText'], properties: { oldText: { minLength: 1 } } } },
                            ],
                        }
                    }
                },
                required: ['filepath', 'operations']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                console.log('modifyFile 收到参数摘要:', JSON.stringify(summarizeToolArguments(params)));

                let filepath = extractStringParam(params, 'filepath');
                if (!filepath) {
                    return toolError('invalid_arguments', `参数错误: filepath 为空或无效`);
                }
                if (!Array.isArray(params?.operations)) {
                    return toolError('invalid_arguments', '参数错误: operations 必须是非空数组');
                }

                const pathValidation = await fileSystem.validatePath(filepath);
                if (!pathValidation.success || !pathValidation.content) {
                    return toolError('invalid_modification', `修改失败: ${pathValidation.message}`);
                }
                filepath = pathValidation.content;

                const originalResult = await fileSystem.readFile(filepath);
                if (!originalResult.success) {
                    return toolError('read_failed', `读取待修改文件失败: ${originalResult.message}。新文件请使用 createNewFile`);
                }
                const originalContent = originalResult.content || '';
                const actualSha256 = createHash('sha256').update(originalContent).digest('hex');
                const expectedSha256 = extractStringParam(params, 'expectedSha256').toLowerCase();
                if (expectedSha256 && expectedSha256 !== actualSha256) {
                    return toolError('file_conflict', `修改冲突: 文件内容已变化，expectedSha256=${expectedSha256}，actualSha256=${actualSha256}。请重新读取文件后再修改`);
                }

                const operations = params.operations.map((operation: any) => operation?.type === 'append'
                    ? { type: 'append', content: operation.content }
                    : {
                        type: operation?.type,
                        oldText: operation?.oldText,
                        newText: operation?.newText,
                        replaceAll: operation?.replaceAll === true,
                    }) as ModifyFileOperation[];
                const application = applyModifyFileOperations(originalContent, operations);
                if (!application.success) {
                    return toolError('invalid_modification', `修改失败: ${application.error}`);
                }
                if (application.content === originalContent) {
                    return toolSuccess(`文件无需修改: ${filepath}`);
                }

                const approved = await fileWriteApprover.confirmFileWrite(
                    filepath,
                    'edit',
                    originalContent,
                    application.content,
                    signal,
                    { requestId: context?.requestId }
                );
                throwIfAborted(signal);
                if (!approved) {
                    return toolRejected('user_rejected', `用户已拒绝修改文件: ${filepath}`);
                }

                // The approval dialog can stay open while the user or another
                // process edits the file. Re-read immediately before writing so
                // an approved diff can never overwrite a newer version.
                const latestResult = await fileSystem.readFile(filepath);
                if (!latestResult.success) {
                    return toolError('file_conflict', `修改冲突: 确认后无法重新读取文件，文件未修改: ${latestResult.message}`);
                }
                const latestContent = latestResult.content || '';
                const latestSha256 = createHash('sha256').update(latestContent).digest('hex');
                if (latestSha256 !== actualSha256) {
                    return toolError('file_conflict', `修改冲突: 文件在确认期间发生了变化，文件未修改。请重新读取后再修改`);
                }

                const writeResult = await transactionManager?.executeWrite(
                    context?.requestId,
                    filepath,
                    application.content,
                    () => fileSystem.editFile(filepath, application.content)
                ) || await fileSystem.editFile(filepath, application.content);
                if (!writeResult.success) {
                    return toolError('write_failed', `写入文件失败: ${writeResult.message}`);
                }

                const finalSha256 = createHash('sha256').update(application.content).digest('hex');
                context?.onFileMutation?.({
                    tool: 'modifyFile',
                    filepath,
                    mode: 'atomic-append-or-replace',
                    changed: true,
                    beforeExists: true,
                    afterExists: true,
                    beforeChars: originalContent.length,
                    afterChars: application.content.length,
                    beforeSha256: actualSha256,
                    afterSha256: finalSha256,
                    edits: application.edits,
                });
                return toolSuccess(`文件已修改: ${filepath}；已执行 ${application.appliedOperations} 个操作；SHA-256=${finalSha256}`);
            }
        },
        {
            name: 'listFiles',
            description: '列出目录下的文件。参数: directory (目录路径)',
            schema: {
                type: 'object',
                properties: {
                    directory: { type: 'string', minLength: 1, pattern: '\\S', description: '目录路径' }
                },
                required: ['directory']
            },
            func: async (params: any, signal?: AbortSignal, _context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const directory = extractStringParam(params, 'directory');
                if (!directory) {
                    return toolError('invalid_arguments', `参数错误: directory 为空或无效`);
                }
                const result = await fileSystem.listFiles(directory);
                return result.success ? toolSuccess(result.content || '目录为空') : toolError('list_failed', `列出目录失败: ${result.message}`);
            }
        },
        {
            name: 'searchFiles',
            description: '使用 glob 模式搜索文件。例如搜索 *.md 找到所有 Markdown 文件，**/*.ts 递归搜索所有 TypeScript 文件。参数: baseDirectory (基础目录), pattern (glob 搜索模式如 *.md, **/*.ts, **/test*.js)',
            schema: {
                type: 'object',
                properties: {
                    baseDirectory: { type: 'string', minLength: 1, pattern: '\\S', description: '搜索的基础目录' },
                    pattern: { type: 'string', minLength: 1, pattern: '\\S', description: 'glob 搜索模式，例如 *.md, **/*.ts, **/test*.js' }
                },
                required: ['baseDirectory', 'pattern']
            },
            func: async (params: any, signal?: AbortSignal, _context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const baseDirectory = extractStringParam(params, 'baseDirectory');
                const pattern = extractStringParam(params, 'pattern');
                if (!baseDirectory) {
                    return toolError('invalid_arguments', `参数错误: baseDirectory 为空`);
                }
                if (!pattern) {
                    return toolError('invalid_arguments', `参数错误: pattern 为空`);
                }
                const result = await fileSystem.searchFiles(baseDirectory, pattern);
                return result.success ? toolSuccess(result.content || '未找到匹配的文件') : toolError('search_failed', `搜索文件失败: ${result.message}`);
            }
        },
        {
            name: 'searchInFiles',
            description: '有明确名称、术语、称呼或原句时优先使用，返回正文命中及证据 ID。只有明确缺口才用 searchStory。',
            schema: {
                type: 'object',
                properties: {
                    baseDirectory: { type: 'string', minLength: 1, pattern: '\\S', description: '搜索的基础目录' },
                    searchText: { type: 'string', minLength: 1, pattern: '\\S', description: '要在文件内容中搜索的文本' },
                    filePattern: { type: 'string', description: '可选：限制搜索的文件类型，如 *.md, *.ts' },
                    contextLines: { type: 'integer', minimum: 0, description: '每处命中前后各返回多少行，默认 0（完整命中行）。按需要选择；重叠范围合并，单次最多 50 KiB。' }
                },
                required: ['baseDirectory', 'searchText']
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const baseDirectory = extractStringParam(params, 'baseDirectory');
                const searchText = extractStringParam(params, 'searchText');
                const filePattern = extractStringParam(params, 'filePattern');
                if (!baseDirectory) {
                    return toolError('invalid_arguments', `参数错误: baseDirectory 为空`);
                }
                if (!searchText) {
                    return toolError('invalid_arguments', `参数错误: searchText 为空`);
                }
                const result = await fileSystem.searchInFiles(
                    baseDirectory,
                    searchText,
                    filePattern || undefined,
                    params.contextLines ?? 0
                );
                const sr = result as SearchResult & { content?: string };
                return deliverSearch(sr, context);
            }
        }
    ]);
}

/**
 * 【RAG 技术点：Agentic RAG】
 * 把检索做成工具，而不是把长文预先塞进 prompt。
 * agent 循环（graph.ts）会自动加载这些工具，模型可以"搜 → 看结果 → 换查询再搜"，
 * 按需从百万字长篇里取回最相关的少量片段，从根本上避免长文本注意力稀释。
 */
export function createRagTools(ragManager: RagManager): ToolDef[] {
    return defineTools([
        {
            name: 'searchStory',
            description: '不知道原文措辞或已有证据仍有明确缺口时使用语义检索。有精确词先 searchInFiles；purpose 说明本次补查目标；重复片段不会重复返回。',
            schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', minLength: 1, pattern: '\\S', description: '检索内容的自然语言描述' },
                    purpose: { type: 'string', minLength: 1, pattern: '\\S', description: '本次要解决的信息缺口；首次查询说明需要的证据' },
                    maxEvidenceChars: { type: 'integer', minimum: 1000, maximum: 12000, description: '本轮证据阅读预算，默认 4000；仅在确实需要多个方面的证据时增加' },
                    basedOnEvidenceIds: { type: 'array', items: { type: 'string' }, description: '已有证据 ID' },
                    filepath: { type: 'string', minLength: 1, pattern: '\\S', description: '可选：限定来源文件的完整路径' },
                    beforeChapter: { type: 'integer', minimum: 0, description: '可选：只检索该章节序号（从0开始）之前的片段，用于防剧透' }
                },
                required: ['query', 'purpose']
            },
            progressMessage: (params: any) => {
                const query = extractStringParam(params, 'query').replace(/\s+/g, ' ').slice(0, 160);
                return query ? `正在检索故事索引：${query}` : '正在检索故事索引…';
            },
            func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
                throwIfAborted(signal);
                const query = extractStringParam(params, 'query');
                if (!query) {
                    return toolError('invalid_arguments', `参数错误: query 为空`);
                }
                if (!ragManager.isReady) {
                    return toolError('rag_unavailable', 'RAG 未就绪：请检查故事检索设置和索引状态，到创作工具选择文件并构建索引。');
                }
                const purpose = extractStringParam(params, 'purpose');
                if (!purpose.trim()) { return toolError('invalid_arguments', '参数错误: 请说明本次检索要补充什么证据（purpose）。'); }
                context = { ...context, evidence: context?.evidence || currentRequestTelemetry()?.evidence };
                if (params.basedOnEvidenceIds !== undefined && (!Array.isArray(params.basedOnEvidenceIds) || params.basedOnEvidenceIds.some((id: string) => !context?.evidence?.find(id)))) {
                    return toolError('invalid_arguments', '参数错误: 引用了不属于本次请求的证据 ID。');
                }
                const beforeChapter = typeof params.beforeChapter === 'number' ? params.beforeChapter : undefined;

                try {
                    const results = await ragManager.search({
                        selection: query,
                        intent: '',
                        beforeChapter,
                        useHyde: false,
                        transformQuery: false,
                        topK: 12,
                        filepath: typeof params.filepath === "string" ? params.filepath : undefined,
                        signal,
                    });
                    throwIfAborted(signal);
                    if (results.length === 0) {
                        return toolSuccess('未检索到相关片段。可能索引为空（请先构建索引）或查询过于宽泛。');
                    }
                    const ledger = context?.evidence || new EvidenceLedger();
                    const scoped = results.filter(r => !params.filepath || r.metadata.filepath === params.filepath);
                    const fresh = scoped.filter(r => ledger.fresh({ filepath: r.metadata.filepath,
                        version: r.metadata.contentVersion || `legacy:${r.metadata.chunkId}`, start: r.metadata.charStart,
                        end: r.metadata.charStart + r.content.length, content: r.content }).length > 0);
                    const reviewed = await ragManager.reviewCandidates(query, purpose, fresh, signal);
                    const before = ledger.added;
                    const pieces: EvidencePiece[] = reviewed.results.map(r => ({ filepath: r.metadata.filepath,
                        version: r.metadata.contentVersion || `legacy:${r.metadata.chunkId}`, chunkId: r.metadata.chunkId,
                        start: r.metadata.charStart, end: r.metadata.charStart + r.content.length, content: r.content }));
                    const coveredIds = ledger.records.filter(old => scoped.some(r => r.metadata.filepath === old.filepath
                        && r.metadata.contentVersion === old.version && r.metadata.charStart < old.end
                        && r.metadata.charEnd > old.start)).map(old => old.id);
                    const budget = Number.isSafeInteger(params.maxEvidenceChars) ? Math.max(1000, Math.min(12000, params.maxEvidenceChars)) : 4000;
                    const output = ledger.deliver(pieces, budget) + (coveredIds.length
                        ? `\n已返回资料可参考：${[...new Set(coveredIds)].join(', ')}。` : '');
                    context?.onRetrieval?.({ candidates: scoped.length, selected: pieces.length,
                        duplicates: scoped.length - fresh.length, added: ledger.added - before, verified: reviewed.verified });
                    return toolSuccess(`${reviewed.verified ? '已按查询目的复核候选相关性。' : '相关性复核暂不可用，以下仅为待核实候选，不能视为已确认事实。'}\n${output}`);

                } catch (error) {
                    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                        throw error;
                    }
                    return toolError('retrieval_failed', `检索失败: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    ]);
}

/**
 * 安全地从参数对象中提取字符串参数
 */
function extractStringParam(params: Record<string, unknown>, key: string, defaultValue = ''): string {
    return typeof params?.[key] === 'string' ? (params[key] as string).trim() : defaultValue;
}
