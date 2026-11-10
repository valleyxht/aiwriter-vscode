import { createEvidenceHandoff } from '../../ai/runtime/evidence-context';
import { HumanMessage } from '../../ai/messages';
import { randomUUID } from 'node:crypto';
import { AIConfig, IFileSystem } from '../../types';
import { FileWriteApprover } from '../../features/file-approval';
import { RagManager } from '../../memory/rag';
import { TokenCounter } from '../../memory/token-counter';
import { createFileTools, createReadOnlyFileTools, createRagTools } from '../../ai/tools/tools';
import { defineTool, ToolDef, toolError, toolSuccess } from '../../ai/tools/contract';
import { EvidenceLedger } from '../../ai/tools/retrieval-evidence';
import { createWritingAssistantAgent, getVisibleMessageText } from '../../ai/runtime/agent';
import { RequestLogSink } from '../../ai/runtime/request-logger';
import { currentRequestTelemetry } from '../../ai/runtime/request-telemetry';
import prompts from './prompts.json';
import { FileTransactionManager } from '../../history';
import type { FileMutationSummary } from '../../ai/runtime/file-mutations';
import { createResearchNavigation } from '../../memory/research/navigation';

export interface SpecialistDescriptor {
  id: string;
  description: string;
  mode: 'agent';
  examples: string[];
}

interface SpecialistOptions {
  enableDecomposition?: boolean;
  parserConfig: AIConfig;
  reviewConfig: AIConfig;
  fileSystem: IFileSystem;
  approver: FileWriteApprover;
  transactionManager?: FileTransactionManager;
  rag?: RagManager;
  logger?: RequestLogSink;
  logRoot?: string;
  agentFactory?: typeof createWritingAssistantAgent;
}

/** Isolated specialists return only their final result; research and decomposition are read-only. */
type SpecialistName = 'decomposeScene' | 'reviewWriting' | 'researchWorkspace';

export function createSpecialistTools(options: SpecialistOptions): ToolDef[] {
  const names: SpecialistName[] = ['decomposeScene', 'reviewWriting', 'researchWorkspace'];
  return names
    .filter(name => name !== 'decomposeScene' || options.enableDecomposition !== false)
    .map(name => createSpecialistTool(name, options));
}

function createSpecialistTool(name: SpecialistName, options: SpecialistOptions): ToolDef {
  return defineTool({
    name,
    description: prompts[name].description,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, description: '本次专业任务和必须保留的设计；不要重写用户原始要求。' },
        sourcePaths: { type: 'array', items: { type: 'string' }, description: '已知原文、设定和人物资料路径；可自行查找其他必要资料。' },
        ...(name === 'researchWorkspace' ? {
          knownContext: { type: 'string' as const, description: '已确认的任务背景、目录信息和已有结论；只传必要内容，不复制完整对话或全文。' },
        } : {}),
        ...(name === 'reviewWriting' ? {
          proposedText: { type: 'string' as const, minLength: 1, description: '可选的完整拟写正文；审核已有文件时可省略。' },
          filepath: { type: 'string' as const, minLength: 1, description: '需要审核或修改的目标文件路径。' },
        } : {}),
      },
      required: ['task'],
    },
    progressMessage: () => prompts[name].description,
    func: (params, signal, context) => runSpecialist(name, options, params, signal, context),
  });
}

async function runSpecialist(
  name: SpecialistName,
  options: SpecialistOptions,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  context?: Parameters<ToolDef['func']>[2],
) {
  const input = context?.agentInput;
  if (!input?.originalRequest) {
    return toolError('missing_original_request', '无法取得本次用户原始要求，未启动专业 Agent。');
  }
  const config = name === 'decomposeScene' ? options.parserConfig : options.reviewConfig;
  const counter = new TokenCounter(config.model, config.contextWindowSize);
  const evidence = new EvidenceLedger([], `${name}-${randomUUID().slice(0, 8)}-E`, context?.evidence?.cache);
  const telemetry = currentRequestTelemetry();
  await telemetry?.observe('specialist_started', { name });
  const fileMutations: FileMutationSummary[] = [];
  try {
    const inheritedEvidence = await createEvidenceHandoff(context?.evidence, options.fileSystem, counter, {
      sourcePaths: Array.isArray(params.sourcePaths) ? params.sourcePaths as string[] : params.filepath ? [String(params.filepath)] : undefined,
      workspacePath: input.workspacePath, signal,
    });
    await telemetry?.observe('evidence_handoff', { operation: `specialist.${name}`,
      availablePieces: context?.evidence?.cache.records.length || 0, suppliedPieces: inheritedEvidence.length,
      suppliedChars: inheritedEvidence.reduce((sum, item) => sum + item.content.length, 0) });
    const navigation = name === 'researchWorkspace'
      ? await createResearchNavigation(input.workspacePath, options.fileSystem) : { tools: [] };
    const fileTools = name === 'reviewWriting'
      ? createFileTools(options.fileSystem, options.approver, options.transactionManager)
          .filter(tool => tool.name !== 'rememberWritingPreference')
      : createReadOnlyFileTools(options.fileSystem);
    const tools = [
      ...fileTools.map(tool => ({
        ...tool,
        func: (args: Record<string, unknown>, toolSignal?: AbortSignal, toolContext?: Parameters<ToolDef['func']>[2]) =>
          tool.func(args, toolSignal, {
            ...toolContext,
            onFileMutation: mutation => {
              toolContext?.onFileMutation?.(mutation);
              fileMutations.push(mutation);
              context?.onFileMutation?.(mutation);
            },
          }),
      })),
      ...(options.rag ? createRagTools(options.rag) : []),
      ...navigation.tools,
    ];
    const agent = (options.agentFactory || createWritingAssistantAgent)(
      config, options.fileSystem, options.approver, undefined, undefined,
      undefined, counter, undefined, undefined, undefined, undefined,
      options.logger,
      { tools, operation: `specialist.${name}`, systemPrompt: prompts[name].system.join('\n'), referenceContext: navigation.context, evidence, inheritedEvidence }
    );
    // User context is supplied once, ahead of the latest original request.
    const task = [
      input.workspacePath ? `【工作区】\n${input.workspacePath}` : '',
      `【专业任务】\n${params.task}`,
      params.sourcePaths ? `【已知来源路径】\n${JSON.stringify(params.sourcePaths)}` : '',
      params.knownContext ? `【已知背景与已有结论】\n${params.knownContext}` : '',
      params.filepath ? `【目标文件】\n${params.filepath}` : '',
      params.proposedText ? `【待审核完整正文】\n${params.proposedText}` : '',
      `【本次用户原始要求，逐字保留】\n${input.originalRequest}`,
    ].filter(Boolean).join('\n\n');
    // Do not silently clip the proposed text or replace a failed review with a sample.
    const result: any = await agent.invoke({
      messages: [new HumanMessage(task)],
      collectedTexts: input.suppliedContext,
      projectMemory: input.projectMemory,
      workspacePath: input.workspacePath,
      requestId: context?.requestId,
      logRoot: options.logRoot,
    }, {
      signal, metadata: { requestId: context?.requestId, component: name, operation: `specialist.${name}` },
    });
    const receipt = fileMutations.length ? `\n\n【已执行的文件修改】\n${fileMutations.map(mutation => mutation.filepath).join('\n')}\n以上写入已执行，请勿再次重复应用。` : '';
    const content = getVisibleMessageText(result.messages?.[result.messages.length - 1]);
    const last = result.messages?.[result.messages.length - 1];
    if (result.haltReason || !content || last?.additional_kwargs?.empty_response_failure || last?.additional_kwargs?.governance_fallback
      || ['length', 'max_tokens'].includes(last?.response_metadata?.finish_reason)) {
      return toolError('specialist_incomplete', (result.haltReason || '专业 Agent 未完整返回结论，不能将部分正文视为审核完成。') + receipt);
    }
    // Main deduplication covers only verbatim evidence actually returned in the packet,
    // never all the prose the research agent read privately.
    const returnedEvidence = name === 'researchWorkspace' ? evidence.visibleIn(content) : [];
    if (name === 'researchWorkspace') { context?.evidence?.importVisible(evidence.records, content); }
    await telemetry?.observe('specialist_completed', {
      name, outputChars: content.length,
      ...(name === 'researchWorkspace' ? {
        acquiredEvidenceCount: evidence.records.length,
        returnedEvidenceCount: returnedEvidence.length,
        returnedEvidenceChars: returnedEvidence.reduce((sum, record) => sum + record.content.length, 0),
      } : {}),
    });
    return toolSuccess(content + receipt, {
      fileMutations,
      ...(name === 'researchWorkspace' ? {
        sources: returnedEvidence.map(({ id, filepath, start, end, version }) => ({ id, filepath, start, end, version })),
      } : {}),
    });
  } catch (error) {
    await telemetry?.observe('specialist_failed', { name, error: error instanceof Error ? error.message : String(error) });
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) { throw error; }
    return toolError('specialist_failed', `${error instanceof Error ? error.message : String(error)}${fileMutations.length ? `\n已经写入：${fileMutations.map(mutation => mutation.filepath).join('、')}。不要重复应用已完成的修改。` : ''}`);
  } finally {
    counter.dispose();
  }
}
