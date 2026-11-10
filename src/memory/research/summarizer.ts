import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage } from '../../ai/messages';
import { AIConfig } from '../../types';
import { classifyModelError, createChatModel, createModelRunConfig, executeChatModelCall } from '../../ai/models';
import { contentHash, ResearchCatalogStore } from './catalog';
import { ResearchCatalog } from './types';
import { formatSummary, summaryFilename } from './summary-files';
import prompts from './prompts.json';

/** Diagnostic metadata only: never log chapter text, summaries or credentials. */
export function logSummary(event: string, details: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const line = `[ResearchSummary] ${JSON.stringify({ time: new Date().toISOString(), event, ...details })}`;
  if (level === 'warn') { console.warn(line); } else { console.log(line); }
}

export interface GenerationProgress {
  runId?: string;
  completed: number;
  total: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  missingUsage: number;
  message: string;
}
export type SummaryCall = (text: string, merge: boolean, signal: AbortSignal) => Promise<string>;

/** No source truncation: oversized sections are summarized in ordered parts, then merged. */
export function splitSummaryInput(text: string, size: number): string[] {
  const parts: string[] = [];
  while (text.length > size) {
    const newline = text.lastIndexOf('\n', size);
    let end = newline > size / 2 ? newline + 1 : size;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) { end--; }
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) { parts.push(text); }
  return parts;
}

export function createSummaryCall(config: AIConfig, progress: GenerationProgress, maxChars: number): SummaryCall {
  if (!config.apiKey.trim() || !config.model.trim()) { throw new Error('请先配置 AI 模型'); }
  const model = createChatModel({ ...config, streaming: false });
  return async (text, merge, signal) => {
    const callId = randomUUID();
    const started = Date.now();
    const context = { runId: progress.runId, callId, chapter: progress.message, stage: merge ? 'merge' : 'summarize' };
    logSummary('call.start', { ...context, model: config.model, inputChars: text.length });
    try {
      const response = await executeChatModelCall(() => model.invoke([
        new SystemMessage(merge ? prompts.merge : prompts.summarize), new HumanMessage(text),
      ], { ...createModelRunConfig('research_summary', undefined, signal),
      }), { operation: 'research_summary', signal });
      const usage = response.usage_metadata;
      if (usage) { progress.inputTokens += usage.input_tokens; progress.outputTokens += usage.output_tokens; }
      else { progress.missingUsage++; }
      const result = typeof response.content === 'string' ? response.content.trim() : response.content
        .filter(part => part.type === 'text').map(part => 'text' in part ? part.text : '').join('\n').trim();
      const finishReason = response.response_metadata?.finish_reason;
      const diagnostics = { ...context, elapsedMs: Date.now() - started, finishReason: finishReason ?? 'unknown',
        outputChars: result.length, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
        reasoningTokens: usage?.output_token_details?.reasoning ?? null,
        reasoningChars: (response.additional_kwargs.ai_sdk_content || [])
          .filter((part: { type: string }) => part.type === 'reasoning')
          .reduce((total: number, part: { text?: string }) => total + (part.text?.length || 0), 0) };
      const rejection = finishReason === 'length' ? 'output_truncated' : !result ? 'empty_output'
        : result.length > maxChars / 2 ? 'output_too_long' : undefined;
      logSummary('call.response', { ...diagnostics, validation: rejection || 'accepted' }, rejection ? 'warn' : 'info');
      if (rejection === 'output_truncated') { throw new Error('模型输出达到上限，摘要被截断（finish_reason=length），下次可重试'); }
      if (rejection === 'empty_output') { throw new Error(`模型未返回摘要正文（finish_reason=${finishReason || 'unknown'}），下次可重试`); }
      // Reject an unusable output explicitly; never persist a silently clipped summary.
      if (result.length > maxChars / 2) { throw new Error('模型摘要过长，未覆盖已有摘要，请重试'); }
      return result;
    } catch (error) {
      const failure = classifyModelError(error);
      logSummary('call.failed', { ...context, elapsedMs: Date.now() - started,
        reason: failure.reason, status: failure.status, aborted: signal.aborted }, 'warn');
      throw error;
    }
  };
}

export async function generateSummaries(
  store: ResearchCatalogStore, catalog: ResearchCatalog, call: SummaryCall,
  options: { sectionIds?: ReadonlySet<string>; maxChars: number; signal: AbortSignal; progress: GenerationProgress; report: () => void },
): Promise<void> {
  const { signal, progress, report, maxChars } = options;
  const jobs = catalog.files.flatMap(file => file.error ? [] : file.sections
    .filter(section => options.sectionIds ? options.sectionIds.has(section.id) : !section.summary)
    .map(section => ({ file, section })));
  progress.runId ??= randomUUID();
  progress.total = jobs.length;
  logSummary('generation.plan', { runId: progress.runId, mode: options.sectionIds ? 'selected' : 'missing',
    files: catalog.files.length, totalSections: catalog.files.reduce((total, file) => total + file.sections.length, 0),
    pendingSections: jobs.length, maxInputChars: maxChars });
  for (const { file, section } of jobs) {
    signal.throwIfAborted();
    const chapterStarted = Date.now();
    const chapterContext = { runId: progress.runId, file: file.path, sectionId: section.id, chapter: section.title };
    logSummary('chapter.start', chapterContext);
    progress.message = `${file.path} · ${section.title}`;
    report();
    try {
      const relative = section.summary || summaryFilename(file, section);
      const before = await store.summarySnapshot(relative);
      if (!options.sectionIds && before !== undefined) { throw new Error('摘要已存在，未覆盖；请从更新入口选择章节'); }
      const source = await store.readSource(file.path);
      if (contentHash(source) !== file.hash) { throw new Error('正文已变化，本次跳过；刷新后重试'); }
      const parts = splitSummaryInput(source.slice(section.start, section.end), maxChars);
      logSummary('chapter.parts', { ...chapterContext, sourceChars: section.end - section.start, parts: parts.length });
      let summaries: string[] = parts.length ? [] : ['空文件，暂无可提取内容。'];
      for (let i = 0; i < parts.length; i++) {
        signal.throwIfAborted();
        progress.message = `${file.path} · ${section.title}（${i + 1}/${parts.length} 段）`;
        report();
        summaries.push(await call(`文件：${file.path}\n章节：${section.title}\n连续分段：${i + 1}/${parts.length}\n\n${parts[i]}`, false, signal));
      }
      while (summaries.length > 1) {
        const groups = splitSummaryInput(summaries.join('\n\n---\n\n'), maxChars);
        const merged: string[] = [];
        for (const group of groups) { signal.throwIfAborted(); merged.push(await call(group, true, signal)); }
        if (merged.length >= summaries.length) { throw new Error('摘要合并未收敛，请重试'); }
        summaries = merged;
      }
      signal.throwIfAborted();
      if (!summaries[0]) { throw new Error('原文为空，没有生成摘要'); }
      if (contentHash(await store.readSource(file.path)) !== file.hash) { throw new Error('生成期间正文变化，已保留旧摘要，请刷新后重试'); }
      if (await store.summarySnapshot(relative) !== before) { throw new Error('生成期间摘要被手动修改，已保留作者内容，请重新选择更新'); }
      const document = formatSummary(file, section, summaries[0]);
      if (before === undefined) {
        await fs.mkdir(path.dirname(path.join(store.directory, relative)), { recursive: true });
        await fs.writeFile(path.join(store.directory, relative), document, { encoding: 'utf8', flag: 'wx' });
      } else { await store.writeAtomic(path.join(store.directory, relative), document); }
      section.summary = relative;
      section.description = summaries[0].split('\n')[0];
      section.generatedHash = section.hash;
      section.updatedAt = new Date().toISOString();
      delete section.needsRefresh;
      delete section.error;
      logSummary('chapter.complete', { ...chapterContext, elapsedMs: Date.now() - chapterStarted, summaryChars: summaries[0].length });
    } catch (error) {
      if (signal.aborted) {
        logSummary('chapter.cancelled', { ...chapterContext, elapsedMs: Date.now() - chapterStarted }, 'warn');
        throw error;
      }
      section.error = String(error);
      progress.failed++;
      const failure = classifyModelError(error);
      logSummary('chapter.failed', { ...chapterContext, elapsedMs: Date.now() - chapterStarted,
        reason: failure.reason, status: failure.status }, 'warn');
      if (failure.reason === 'insufficient_quota' || [401, 403, 404, 429].includes(failure.status || 0)) {
        await store.save(catalog);
        throw error; // Credentials/quota/model availability affect every remaining chapter.
      }
    }
    await store.save(catalog);
    progress.completed++;
    report();
  }
}
