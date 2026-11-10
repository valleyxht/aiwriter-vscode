import { RetrievalResult } from './types';

export interface RagEvaluationCase {
  name: string;
  query: string;
  expectedChunkIds?: string[];
  expectedFilepaths?: string[];
  expectedHeadingPaths?: string[];
  /** Gold passages copied from the source novel (for example NovelQA evidences). */
  expectedEvidence?: string[];
  /** Dimensions used for sliced reports, such as aspect=plot and complexity=mh. */
  dimensions?: Record<string, string>;
}

export interface RagEvaluationCaseResult {
  name: string;
  query: string;
  hit: boolean;
  firstRelevantRank?: number;
  recallAtK: number;
  dimensions?: Record<string, string>;
  retrieved: Array<{
    rank: number;
    filepath: string;
    headingPath: string;
    chunkId: string;
    source: RetrievalResult['source'];
    score: number;
    contentPreview: string;
  }>;
}

export interface RagEvaluationSummary {
  cases: number;
  hitRateAtK: number;
  meanReciprocalRank: number;
  averageRecallAtK: number;
  failures: Array<{ name: string; query: string }>;
  results: RagEvaluationCaseResult[];
  slices: Record<string, {
    cases: number;
    hitRateAtK: number;
    meanReciprocalRank: number;
    averageRecallAtK: number;
  }>;
}

export async function evaluateRagRetrieval(
  cases: RagEvaluationCase[],
  retrieve: (query: string) => Promise<RetrievalResult[]>,
  topK: number
): Promise<RagEvaluationSummary> {
  let hits = 0;
  let reciprocalRankTotal = 0;
  let recallTotal = 0;
  const failures: Array<{ name: string; query: string }> = [];
  const caseResults: RagEvaluationCaseResult[] = [];

  for (const testCase of cases) {
    const results = (await retrieve(testCase.query)).slice(0, Math.max(1, topK));
    const expectations = collectExpectations(testCase);
    if (expectations.length === 0) {
      throw new Error(`RAG evaluation case "${testCase.name}" has no gold locator or evidence`);
    }
    const matched = results.map(result => expectations.some(expected => expectationMatches(expected, result)));
    const firstRank = matched.findIndex(Boolean);
    if (firstRank >= 0) {
      hits++;
      reciprocalRankTotal += 1 / (firstRank + 1);
    } else {
      failures.push({ name: testCase.name, query: testCase.query });
    }
    const matchedExpectations = new Set<number>();
    for (const result of results) {
      expectations.forEach((expected, index) => {
        if (expectationMatches(expected, result)) {
          matchedExpectations.add(index);
        }
      });
    }
    const recallAtK = matchedExpectations.size / expectations.length;
    recallTotal += recallAtK;
    caseResults.push({
      name: testCase.name,
      query: testCase.query,
      hit: firstRank >= 0,
      firstRelevantRank: firstRank >= 0 ? firstRank + 1 : undefined,
      recallAtK,
      dimensions: testCase.dimensions,
      retrieved: results.map((result, index) => ({
        rank: index + 1,
        filepath: result.metadata.filepath,
        headingPath: result.metadata.headingPath || result.metadata.title,
        chunkId: result.metadata.chunkId,
        source: result.source,
        score: result.score,
        contentPreview: result.content.replace(/\s+/g, ' ').trim().slice(0, 240),
      })),
    });
  }

  const count = cases.length;
  return {
    cases: count,
    hitRateAtK: count > 0 ? hits / count : 0,
    meanReciprocalRank: count > 0 ? reciprocalRankTotal / count : 0,
    averageRecallAtK: count > 0 ? recallTotal / count : 0,
    failures,
    results: caseResults,
    slices: buildSlices(caseResults),
  };
}

type Expectation = { type: 'key'; value: string } | { type: 'evidence'; value: string };

function collectExpectations(testCase: RagEvaluationCase): Expectation[] {
  const keys = [
    ...(testCase.expectedChunkIds || []).map(value => `chunk:${value}`),
    ...(testCase.expectedFilepaths || []).map(value => `file:${normalize(value)}`),
    ...(testCase.expectedHeadingPaths || []).map(value => `heading:${normalize(value)}`),
  ];
  return [
    ...Array.from(new Set(keys)).map(value => ({ type: 'key' as const, value })),
    ...Array.from(new Set((testCase.expectedEvidence || []).map(normalizeEvidence).filter(Boolean)))
      .map(value => ({ type: 'evidence' as const, value })),
  ];
}

function expectationMatches(expectation: Expectation, result: RetrievalResult): boolean {
  if (expectation.type === 'key') {
    return resultKeys(result).includes(expectation.value);
  }
  return evidenceMatches(expectation.value, result.content);
}

function resultKeys(result: RetrievalResult): string[] {
  return [
    `chunk:${result.metadata.chunkId}`,
    `file:${normalize(result.metadata.filepath)}`,
    `heading:${normalize(result.metadata.headingPath || result.metadata.title)}`,
  ];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/');
}

function normalizeEvidence(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Evidence annotations are sometimes a sentence and sometimes a longer excerpt.
 * Exact containment is preferred; token recall tolerates punctuation and whitespace changes.
 */
export function evidenceMatches(expectedEvidence: string, retrievedContent: string, threshold = 0.6): boolean {
  const expected = normalizeEvidence(expectedEvidence);
  const actual = normalizeEvidence(retrievedContent);
  if (!expected || !actual) {
    return false;
  }
  if (actual.includes(expected)) {
    return true;
  }
  const expectedTokens = expected.split(' ').filter(Boolean);
  const actualTokens = new Set(actual.split(' ').filter(Boolean));
  if (expectedTokens.length < 4) {
    return false;
  }
  const covered = expectedTokens.filter(token => actualTokens.has(token)).length;
  return covered / expectedTokens.length >= threshold;
}

function buildSlices(results: RagEvaluationCaseResult[]): RagEvaluationSummary['slices'] {
  const buckets = new Map<string, RagEvaluationCaseResult[]>();
  for (const result of results) {
    for (const [dimension, value] of Object.entries(result.dimensions || {})) {
      const key = `${dimension}:${value}`;
      const bucket = buckets.get(key) || [];
      bucket.push(result);
      buckets.set(key, bucket);
    }
  }
  return Object.fromEntries(Array.from(buckets.entries()).map(([key, bucket]) => [key, {
    cases: bucket.length,
    hitRateAtK: average(bucket.map(item => item.hit ? 1 : 0)),
    meanReciprocalRank: average(bucket.map(item => item.firstRelevantRank ? 1 / item.firstRelevantRank : 0)),
    averageRecallAtK: average(bucket.map(item => item.recallAtK)),
  }]));
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
