import { performance } from 'perf_hooks';
import { chunkFile, stableHash } from './chunker';
import { RetrievalResult } from './types';

export interface CLongEvalDocument {
  id: string;
  content: string;
}

export interface CLongEvalCase {
  id: string;
  documentId: string;
  query: string;
  answer: string;
  referredChunk: string;
  evidenceStartToken?: number;
  evidenceEndToken?: number;
  contextTokenLength?: number;
  split: string;
  positionBucket: 'front' | 'middle' | 'back' | 'unknown';
}

export interface CLongEvalDataset {
  sourceHash: string;
  split: string;
  documents: CLongEvalDocument[];
  cases: CLongEvalCase[];
  invalidLines: number;
  skippedWithoutEvidence: number;
}

export interface CLongEvalChunkCaseResult {
  id: string;
  located: boolean;
  singleChunkContained: boolean;
  boundaryCut: boolean;
  chunksPerEvidence: number;
  evidenceCoverage: number;
  contextWasteRatio: number;
  evidenceCharStart?: number;
  evidenceCharEnd?: number;
}

export interface CLongEvalChunkingReport {
  cases: number;
  locatedCases: number;
  unlocatedCases: number;
  singleChunkContainmentRate: number;
  boundaryCutRate: number;
  averageChunksPerEvidence: number;
  averageEvidenceCoverage: number;
  averageContextWasteRatio: number;
  results: CLongEvalChunkCaseResult[];
}

export interface CLongEvalRetrievalCaseResult {
  id: string;
  query: string;
  documentId: string;
  split: string;
  positionBucket: CLongEvalCase['positionBucket'];
  hit: boolean;
  firstRelevantRank?: number;
  evidenceRecallAtK: number;
  latencyMs: number;
  retrieved: Array<{
    rank: number;
    chunkId: string;
    headingPath: string;
    source: RetrievalResult['source'];
    score: number;
    relevant: boolean;
    contentPreview: string;
  }>;
}

export interface CLongEvalRetrievalReport {
  cases: number;
  evaluatedCases: number;
  skippedUnlocatedEvidence: number;
  topK: number;
  hitRateAtK: number;
  meanReciprocalRank: number;
  averageEvidenceRecallAtK: number;
  latencyMs: { p50: number; p95: number; average: number };
  failures: Array<{ id: string; query: string; documentId: string }>;
  slices: Record<string, {
    cases: number;
    hitRateAtK: number;
    meanReciprocalRank: number;
    averageEvidenceRecallAtK: number;
  }>;
  results: CLongEvalRetrievalCaseResult[];
}

export interface CLongEvalBenchmarkReport {
  benchmark: 'CLongEval-long_story_qa';
  createdAt: string;
  dataset: {
    sourceFile: string;
    sourceHash: string;
    split: string;
    documents: number;
    availableCases: number;
    sampledCases: number;
    invalidLines: number;
    skippedWithoutEvidence: number;
  };
  configuration: {
    embeddingModel: string;
    chunkSize: number;
    chunkOverlap: number;
    retrieval: 'hybrid-rrf';
    topK: number;
    queryTransformation: false;
    hyde: false;
  };
  chunking: CLongEvalChunkingReport;
  retrieval: CLongEvalRetrievalReport;
}

export function parseCLongEvalJsonl(text: string, sourceName = 'small.jsonl'): CLongEvalDataset {
  const documents = new Map<string, CLongEvalDocument>();
  const cases: CLongEvalCase[] = [];
  let invalidLines = 0;
  let skippedWithoutEvidence = 0;
  const split = inferSplit(sourceName);

  for (const [index, rawLine] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (!isRecord(value)) {
        invalidLines++;
        continue;
      }
      record = value;
    } catch {
      invalidLines++;
      continue;
    }
    const context = readString(record, 'context');
    const query = readString(record, 'query');
    const evidence = readString(record, 'refered_chunk', 'referred_chunk');
    if (!context || !query) {
      invalidLines++;
      continue;
    }
    if (!evidence) {
      skippedWithoutEvidence++;
      continue;
    }
    const documentId = stableHash(context);
    documents.set(documentId, { id: documentId, content: context });
    const evidenceStartToken = readNumber(record, 'chunk_start_token_idx');
    const evidenceEndToken = readNumber(record, 'chunk_end_token_idx');
    const contextTokenLength = readNumber(record, 'internlm2_length', 'qwen_length', 'chatglm_length');
    cases.push({
      id: readString(record, 'id') || `line-${index + 1}`,
      documentId,
      query,
      answer: readString(record, 'answer') || '',
      referredChunk: evidence,
      evidenceStartToken,
      evidenceEndToken,
      contextTokenLength,
      split,
      positionBucket: positionBucket(evidenceStartToken, contextTokenLength),
    });
  }

  return {
    sourceHash: stableHash(text),
    split,
    documents: Array.from(documents.values()),
    cases,
    invalidLines,
    skippedWithoutEvidence,
  };
}

export function sampleCLongEvalCases(cases: CLongEvalCase[], limit: number): CLongEvalCase[] {
  if (limit <= 0 || cases.length <= limit) {
    return [...cases];
  }
  const buckets = new Map<string, CLongEvalCase[]>();
  for (const item of cases) {
    const key = `${item.split}:${item.positionBucket}`;
    const bucket = buckets.get(key) || [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const groups = Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b));
  const selected: CLongEvalCase[] = [];
  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const [, group] of groups) {
      if (group[offset] && selected.length < limit) {
        selected.push(group[offset]);
        added = true;
      }
    }
    if (!added) {
      break;
    }
    offset++;
  }
  return selected;
}

export function analyzeCLongEvalChunking(
  dataset: Pick<CLongEvalDataset, 'documents'>,
  cases: CLongEvalCase[],
  options: { chunkSize: number; chunkOverlap: number }
): CLongEvalChunkingReport {
  const documents = new Map(dataset.documents.map(document => [document.id, document.content]));
  const chunksByDocument = new Map<string, ReturnType<typeof chunkFile>>();
  const results: CLongEvalChunkCaseResult[] = [];

  for (const item of cases) {
    const context = documents.get(item.documentId) || '';
    const evidenceRange = locateEvidence(context, item.referredChunk);
    if (!evidenceRange) {
      results.push({
        id: item.id,
        located: false,
        singleChunkContained: false,
        boundaryCut: false,
        chunksPerEvidence: 0,
        evidenceCoverage: 0,
        contextWasteRatio: 0,
      });
      continue;
    }
    let chunks = chunksByDocument.get(item.documentId);
    if (!chunks) {
      chunks = chunkFile(`clongeval-${item.documentId}.txt`, context, options);
      chunksByDocument.set(item.documentId, chunks);
    }
    const intersecting = chunks.filter(chunk => overlapLength(
      chunk.metadata.charStart,
      chunk.metadata.charEnd,
      evidenceRange.start,
      evidenceRange.end
    ) > 0);
    const evidenceLength = Math.max(1, evidenceRange.end - evidenceRange.start);
    const evidenceCoverage = unionLength(intersecting.map(chunk => ({
      start: Math.max(chunk.metadata.charStart, evidenceRange.start),
      end: Math.min(chunk.metadata.charEnd, evidenceRange.end),
    }))) / evidenceLength;
    const retrievedSpanLength = unionLength(intersecting.map(chunk => ({
      start: chunk.metadata.charStart,
      end: chunk.metadata.charEnd,
    })));
    const coveredLength = evidenceCoverage * evidenceLength;
    const singleChunkContained = intersecting.some(chunk =>
      chunk.metadata.charStart <= evidenceRange.start && chunk.metadata.charEnd >= evidenceRange.end
    );
    results.push({
      id: item.id,
      located: true,
      singleChunkContained,
      boundaryCut: !singleChunkContained && intersecting.length > 1,
      chunksPerEvidence: intersecting.length,
      evidenceCoverage,
      contextWasteRatio: retrievedSpanLength > 0
        ? Math.max(0, retrievedSpanLength - coveredLength) / retrievedSpanLength
        : 0,
      evidenceCharStart: evidenceRange.start,
      evidenceCharEnd: evidenceRange.end,
    });
  }

  const located = results.filter(result => result.located);
  return {
    cases: results.length,
    locatedCases: located.length,
    unlocatedCases: results.length - located.length,
    singleChunkContainmentRate: average(located.map(result => result.singleChunkContained ? 1 : 0)),
    boundaryCutRate: average(located.map(result => result.boundaryCut ? 1 : 0)),
    averageChunksPerEvidence: average(located.map(result => result.chunksPerEvidence)),
    averageEvidenceCoverage: average(located.map(result => result.evidenceCoverage)),
    averageContextWasteRatio: average(located.map(result => result.contextWasteRatio)),
    results,
  };
}

export async function evaluateCLongEvalRetrieval(
  dataset: Pick<CLongEvalDataset, 'documents'>,
  cases: CLongEvalCase[],
  search: (document: CLongEvalDocument, item: CLongEvalCase) => Promise<RetrievalResult[]>,
  topK: number,
  onProgress?: (completed: number, total: number) => void
): Promise<CLongEvalRetrievalReport> {
  const documents = new Map(dataset.documents.map(document => [document.id, document]));
  const results: CLongEvalRetrievalCaseResult[] = [];
  let skippedUnlocatedEvidence = 0;

  for (const item of cases) {
    const document = documents.get(item.documentId);
    const evidenceRange = document && locateEvidence(document.content, item.referredChunk);
    if (!document || !evidenceRange) {
      skippedUnlocatedEvidence++;
      onProgress?.(results.length + skippedUnlocatedEvidence, cases.length);
      continue;
    }
    const started = performance.now();
    const retrieved = (await search(document, item)).slice(0, Math.max(1, topK));
    const latencyMs = performance.now() - started;
    const relevant = retrieved.map(result => isRelevantRange(result, evidenceRange));
    const first = relevant.findIndex(Boolean);
    const evidenceLength = Math.max(1, evidenceRange.end - evidenceRange.start);
    const evidenceRecallAtK = unionLength(retrieved.map(result => ({
      start: Math.max(result.metadata.charStart, evidenceRange.start),
      end: Math.min(result.metadata.charEnd, evidenceRange.end),
    })).filter(range => range.end > range.start)) / evidenceLength;
    results.push({
      id: item.id,
      query: item.query,
      documentId: item.documentId,
      split: item.split,
      positionBucket: item.positionBucket,
      hit: first >= 0,
      firstRelevantRank: first >= 0 ? first + 1 : undefined,
      evidenceRecallAtK,
      latencyMs,
      retrieved: retrieved.map((result, index) => ({
        rank: index + 1,
        chunkId: result.metadata.chunkId,
        headingPath: result.metadata.headingPath || result.metadata.title,
        source: result.source,
        score: result.score,
        relevant: relevant[index],
        contentPreview: result.content.replace(/\s+/g, ' ').trim().slice(0, 200),
      })),
    });
    onProgress?.(results.length + skippedUnlocatedEvidence, cases.length);
  }

  const latencies = results.map(result => result.latencyMs).sort((a, b) => a - b);
  return {
    cases: cases.length,
    evaluatedCases: results.length,
    skippedUnlocatedEvidence,
    topK,
    hitRateAtK: average(results.map(result => result.hit ? 1 : 0)),
    meanReciprocalRank: average(results.map(result => result.firstRelevantRank ? 1 / result.firstRelevantRank : 0)),
    averageEvidenceRecallAtK: average(results.map(result => result.evidenceRecallAtK)),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      average: average(latencies),
    },
    failures: results.filter(result => !result.hit).map(result => ({
      id: result.id,
      query: result.query,
      documentId: result.documentId,
    })),
    slices: buildRetrievalSlices(results),
    results,
  };
}

export function renderCLongEvalMarkdown(report: CLongEvalBenchmarkReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    '# CLongEval RAG 评测报告',
    '',
    `- 创建时间：${report.createdAt}`,
    `- 数据文件：${report.dataset.sourceFile}`,
    `- 数据哈希：${report.dataset.sourceHash}`,
    `- 分组：${report.dataset.split}`,
    `- 文档数：${report.dataset.documents}`,
    `- 评测题数：${report.dataset.sampledCases}/${report.dataset.availableCases}`,
    `- Embedding：${report.configuration.embeddingModel}`,
    `- Chunk：${report.configuration.chunkSize} / overlap ${report.configuration.chunkOverlap}`,
    `- 检索：Hybrid RRF，原始查询，Top-${report.configuration.topK}`,
    '',
    '## 切片指标',
    '',
    `- Evidence 定位成功：${report.chunking.locatedCases}/${report.chunking.cases}`,
    `- 单块完整容纳率：${percent(report.chunking.singleChunkContainmentRate)}`,
    `- 边界切断率：${percent(report.chunking.boundaryCutRate)}`,
    `- 平均覆盖块数：${report.chunking.averageChunksPerEvidence.toFixed(2)}`,
    `- Evidence 平均覆盖率：${percent(report.chunking.averageEvidenceCoverage)}`,
    `- 平均上下文浪费率：${percent(report.chunking.averageContextWasteRatio)}`,
    '',
    '## 检索指标',
    '',
    `- HitRate@${report.retrieval.topK}：${percent(report.retrieval.hitRateAtK)}`,
    `- MRR：${report.retrieval.meanReciprocalRank.toFixed(3)}`,
    `- Evidence Recall@${report.retrieval.topK}：${percent(report.retrieval.averageEvidenceRecallAtK)}`,
    `- 延迟 P50 / P95：${report.retrieval.latencyMs.p50.toFixed(0)} / ${report.retrieval.latencyMs.p95.toFixed(0)} ms`,
    `- 失败：${report.retrieval.failures.length}/${report.retrieval.evaluatedCases}`,
    '',
    '## 分层结果',
    '',
    '| 分层 | 题数 | HitRate | MRR | Evidence Recall |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(report.retrieval.slices).map(([key, value]) =>
      `| ${key} | ${value.cases} | ${percent(value.hitRateAtK)} | ${value.meanReciprocalRank.toFixed(3)} | ${percent(value.averageEvidenceRecallAtK)} |`
    ),
    '',
    '## 失败样例（最多 30 条）',
    '',
    ...report.retrieval.failures.slice(0, 30).map(failure =>
      `- ${failure.id}：${failure.query}（document ${failure.documentId}）`
    ),
    '',
    '> 报告仅保留问题、短片段预览和哈希，不包含完整小说或完整 gold evidence。',
  ];
  return lines.join('\n');
}

function locateEvidence(context: string, evidence: string): { start: number; end: number } | undefined {
  const exact = context.indexOf(evidence);
  if (exact >= 0) {
    return { start: exact, end: exact + evidence.length };
  }
  const normalizedContext = normalizeWithOffsets(context);
  const normalizedEvidence = normalizeWithOffsets(evidence).text;
  const normalizedStart = normalizedContext.text.indexOf(normalizedEvidence);
  if (normalizedStart < 0 || normalizedEvidence.length === 0) {
    return undefined;
  }
  const start = normalizedContext.offsets[normalizedStart];
  const last = normalizedContext.offsets[normalizedStart + normalizedEvidence.length - 1];
  return { start, end: last + 1 };
}

function normalizeWithOffsets(value: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (/\s/u.test(char)) {
      continue;
    }
    text += char.toLowerCase();
    offsets.push(i);
  }
  return { text, offsets };
}

function isRelevantRange(result: RetrievalResult, evidence: { start: number; end: number }): boolean {
  const overlap = overlapLength(
    result.metadata.charStart,
    result.metadata.charEnd,
    evidence.start,
    evidence.end
  );
  const smaller = Math.max(1, Math.min(
    result.metadata.charEnd - result.metadata.charStart,
    evidence.end - evidence.start
  ));
  return overlap / smaller >= 0.5;
}

function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function unionLength(ranges: Array<{ start: number; end: number }>): number {
  const sorted = ranges.filter(range => range.end > range.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) {
    return 0;
  }
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const range of sorted.slice(1)) {
    if (range.start <= end) {
      end = Math.max(end, range.end);
    } else {
      total += end - start;
      start = range.start;
      end = range.end;
    }
  }
  return total + end - start;
}

function buildRetrievalSlices(results: CLongEvalRetrievalCaseResult[]): CLongEvalRetrievalReport['slices'] {
  const buckets = new Map<string, CLongEvalRetrievalCaseResult[]>();
  for (const result of results) {
    for (const key of [`split:${result.split}`, `position:${result.positionBucket}`]) {
      const bucket = buckets.get(key) || [];
      bucket.push(result);
      buckets.set(key, bucket);
    }
  }
  return Object.fromEntries(Array.from(buckets.entries()).map(([key, bucket]) => [key, {
    cases: bucket.length,
    hitRateAtK: average(bucket.map(result => result.hit ? 1 : 0)),
    meanReciprocalRank: average(bucket.map(result => result.firstRelevantRank ? 1 / result.firstRelevantRank : 0)),
    averageEvidenceRecallAtK: average(bucket.map(result => result.evidenceRecallAtK)),
  }]));
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function inferSplit(sourceName: string): string {
  const match = /(?:^|[\\/])(small|medium|large)\.jsonl$/i.exec(sourceName) || /(small|medium|large)/i.exec(sourceName);
  return match?.[1]?.toLowerCase() || 'unknown';
}

function positionBucket(start: number | undefined, total: number | undefined): CLongEvalCase['positionBucket'] {
  if (typeof start !== 'number' || typeof total !== 'number' || total <= 0) {
    return 'unknown';
  }
  const ratio = start / total;
  return ratio < 1 / 3 ? 'front' : ratio < 2 / 3 ? 'middle' : 'back';
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
