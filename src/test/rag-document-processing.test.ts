import * as assert from 'assert';
import { chunkFile } from '../memory/rag/chunker';
import { createEmbeddingText } from '../memory/rag/manager';
import { rankKeywordDocuments, tokenizeForKeywordSearch } from '../memory/rag/keyword-search';
import { addRankedHits } from '../memory/rag/retriever';
import { analyzeChunkQuality } from '../memory/rag/quality';
import { evaluateRagRetrieval, evidenceMatches } from '../memory/rag/evaluation';
import { parseNovelQaEvaluationCases, sampleNovelQaCases } from '../memory/rag/novelqa';
import {
  analyzeCLongEvalChunking,
  evaluateCLongEvalRetrieval,
  parseCLongEvalJsonl,
  sampleCLongEvalCases,
} from '../memory/rag/clongeval';
import { ChunkMetadata, RetrievalResult } from '../memory/rag/types';
import { resolveEmbeddingBatchSize } from '../memory/rag/embedder';

suite('RAG document processing quality', () => {
  test('caps embedding batches for known Bailian models', () => {
    assert.strictEqual(resolveEmbeddingBatchSize('qwen3.7-text-embedding', 64), 20);
    assert.strictEqual(resolveEmbeddingBatchSize('text-embedding-v4', 64), 10);
    assert.strictEqual(resolveEmbeddingBatchSize('text-embedding-v2', 64), 25);
    assert.strictEqual(resolveEmbeddingBatchSize('private-embedding-model', 64), 64);
    assert.strictEqual(resolveEmbeddingBatchSize('text-embedding-v4', Number.NaN), 10);
  });

  test('preserves heading hierarchy and exact body offsets', () => {
    const text = '# 第一卷\n卷首文字\n## 第一章 雨夜\n沈砚推开了门。\n';
    const chunks = chunkFile('story.md', text, { chunkSize: 800, chunkOverlap: 100 });
    assert.strictEqual(chunks[0].metadata.headingPath, '第一卷');
    assert.strictEqual(chunks[0].metadata.charStart, text.indexOf('卷首文字'));
    assert.strictEqual(chunks[1].metadata.headingPath, '第一卷 > 第一章 雨夜');
    assert.strictEqual(chunks[1].metadata.charStart, text.indexOf('沈砚推开了门'));
    assert.match(createEmbeddingText(chunks[1]), /^章节：第一卷 > 第一章 雨夜/);
  });

  test('ranks exact Chinese names through the independent BM25 channel', () => {
    assert.ok(tokenizeForKeywordSearch('沈砚在雨夜抵达').includes('沈砚'));
    const ranked = rankKeywordDocuments('沈砚 雨夜', [
      { value: 'a', text: '沈砚在雨夜抵达旧宅。' },
      { value: 'b', text: '顾临川在清晨离开码头。' },
    ], 2);
    assert.strictEqual(ranked[0].value, 'a');
    assert.strictEqual(ranked.length, 1);
  });

  test('uses reciprocal-rank fusion across vector and keyword lists', () => {
    const fused = new Map<string, any>();
    const a = vectorHit('a', 'vector result');
    const b = vectorHit('b', 'shared result');
    addRankedHits(fused, [a, b], 'vector');
    addRankedHits(fused, [b], 'keyword');
    assert.ok(fused.get('b').score > fused.get('a').score);
    assert.deepStrictEqual(Array.from(fused.get('b').channels).sort(), ['keyword', 'vector']);
  });

  test('reports suspiciously small and garbled chunks', () => {
    const report = analyzeChunkQuality(['短', '正常正文'.repeat(100), '\uFFFD'.repeat(10)], 800);
    assert.strictEqual(report.totalChunks, 3);
    assert.ok(report.smallChunkCount >= 2);
    assert.strictEqual(report.garbledChunkCount, 1);
    assert.ok(report.warnings.length > 0);
  });

  test('calculates hit rate, MRR and recall for story evaluation cases', async () => {
    const result = vectorResult('target', 'story/chapter-1.md', '第一卷 > 第一章');
    const summary = await evaluateRagRetrieval([
      { name: '角色初登场', query: '沈砚第一次出现', expectedChunkIds: ['target'] },
      { name: '不存在的线索', query: '银色怀表', expectedChunkIds: ['missing'] },
    ], async () => [result], 5);
    assert.strictEqual(summary.hitRateAtK, 0.5);
    assert.strictEqual(summary.meanReciprocalRank, 0.5);
    assert.strictEqual(summary.failures.length, 1);
  });

  test('matches NovelQA evidence despite whitespace and punctuation changes', () => {
    assert.ok(evidenceMatches(
      'Robert wrote to his sister for the ninth time.',
      'Later, Robert wrote to his sister—for the ninth time—before leaving.'
    ));
    assert.ok(!evidenceMatches(
      'Robert wrote to his sister for the ninth time.',
      'Elizabeth closed the window and left the room.'
    ));
  });

  test('imports QID-indexed NovelQA records and skips test questions without evidence', () => {
    const imported = parseNovelQaEvaluationCases({
      Q0001: {
        Aspect: 'plot',
        Complexity: 'sh',
        Question: 'What did Robert discover?',
        Evidences: ['Robert discovered the sealed letter beneath the floorboards.'],
      },
      Q0002: {
        Aspect: 'times',
        Complexity: 'mh',
        Question: 'How many letters were sent?',
        Options: { A: 'one', B: 'two' },
      },
    });
    assert.strictEqual(imported.cases.length, 1);
    assert.strictEqual(imported.skippedWithoutEvidence, 1);
    assert.strictEqual(imported.cases[0].name, 'Q0001');
    assert.deepStrictEqual(imported.cases[0].dimensions, { aspect: 'plot', complexity: 'sh' });
  });

  test('creates a deterministic stratified NovelQA sample', () => {
    const cases = ['plot', 'plot', 'role', 'role'].map((aspect, index) => ({
      name: `Q${index}`,
      query: `question ${index}`,
      expectedEvidence: [`evidence passage ${index}`],
      dimensions: { aspect, complexity: index % 2 ? 'mh' : 'sh' },
    }));
    assert.deepStrictEqual(
      sampleNovelQaCases(cases, 3).map(item => item.name),
      sampleNovelQaCases(cases, 3).map(item => item.name)
    );
    assert.strictEqual(sampleNovelQaCases(cases, 3).length, 3);
  });

  test('parses CLongEval JSONL, deduplicates contexts and records invalid rows', () => {
    const context = `第一章\n${'故事正文'.repeat(40)}`;
    const rows = [
      JSON.stringify({
        id: 'front', context, query: '问题一', answer: '答案一',
        refered_chunk: '故事正文'.repeat(5), chunk_start_token_idx: 10, internlm2_length: 100,
      }),
      JSON.stringify({
        id: 'back', context, query: '问题二', answer: '答案二',
        refered_chunk: '故事正文'.repeat(6), chunk_start_token_idx: 80, internlm2_length: 100,
      }),
      JSON.stringify({ id: 'missing', context, query: '没有证据' }),
      '{broken json',
    ].join('\n');
    const dataset = parseCLongEvalJsonl(rows, 'small.jsonl');
    assert.strictEqual(dataset.documents.length, 1);
    assert.strictEqual(dataset.cases.length, 2);
    assert.strictEqual(dataset.skippedWithoutEvidence, 1);
    assert.strictEqual(dataset.invalidLines, 1);
    assert.deepStrictEqual(dataset.cases.map(item => item.positionBucket), ['front', 'back']);
    assert.strictEqual(sampleCLongEvalCases(dataset.cases, 1).length, 1);
  });

  test('measures CLongEval evidence containment without embeddings', () => {
    const evidence = '关键证据说明怀表属于沈砚';
    const context = `${'前文'.repeat(10)}${evidence}${'后文'.repeat(10)}`;
    const dataset = parseCLongEvalJsonl(JSON.stringify({
      id: 'case-1', context, query: '怀表属于谁？', answer: '沈砚', refered_chunk: evidence,
    }), 'small.jsonl');
    const report = analyzeCLongEvalChunking(dataset, dataset.cases, { chunkSize: 200, chunkOverlap: 20 });
    assert.strictEqual(report.locatedCases, 1);
    assert.strictEqual(report.singleChunkContainmentRate, 1);
    assert.strictEqual(report.averageEvidenceCoverage, 1);
  });

  test('evaluates isolated CLongEval retrieval by evidence offsets', async () => {
    const evidence = '这一段是必须召回的关键证据';
    const context = `无关开头。${evidence}。无关结尾。`;
    const dataset = parseCLongEvalJsonl(JSON.stringify({
      id: 'case-1', context, query: '关键证据是什么？', answer: '答案', refered_chunk: evidence,
    }), 'small.jsonl');
    const evidenceStart = context.indexOf(evidence);
    const summary = await evaluateCLongEvalRetrieval(
      dataset,
      dataset.cases,
      async () => [{
        content: evidence,
        metadata: {
          ...metadata('hit'),
          charStart: evidenceStart,
          charEnd: evidenceStart + evidence.length,
        },
        score: 1,
        source: 'hybrid',
      }],
      5
    );
    assert.strictEqual(summary.hitRateAtK, 1);
    assert.strictEqual(summary.meanReciprocalRank, 1);
    assert.strictEqual(summary.averageEvidenceRecallAtK, 1);
  });
});

function metadata(chunkId: string, filepath = 'story.md', headingPath = '第一章'): ChunkMetadata {
  return {
    chunkId,
    filepath,
    filepathHash: 'hash',
    chapterIndex: 0,
    title: '第一章',
    headingPath,
    charStart: 0,
    charEnd: 10,
    seq: 0,
  };
}

function vectorHit(chunkId: string, content: string) {
  return { metadata: metadata(chunkId), content, score: 1 };
}

function vectorResult(chunkId: string, filepath: string, headingPath: string): RetrievalResult {
  return {
    metadata: metadata(chunkId, filepath, headingPath),
    content: '正文',
    score: 1,
    source: 'hybrid',
  };
}
