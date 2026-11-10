import { RagEvaluationCase } from './evaluation';

export interface NovelQaImportResult {
  cases: RagEvaluationCase[];
  skippedWithoutEvidence: number;
}

/** Convert both the legacy list format and the current QID-indexed NovelQA JSON format. */
export function parseNovelQaEvaluationCases(input: unknown): NovelQaImportResult {
  const cases: RagEvaluationCase[] = [];
  let skippedWithoutEvidence = 0;

  visit(input, undefined, (record, inheritedId) => {
    const question = readString(record, 'Question', 'question');
    if (!question) {
      return;
    }
    const qid = readString(record, 'QID', 'qid') || inheritedId || `case-${cases.length + skippedWithoutEvidence + 1}`;
    const evidenceValue = readValue(record, 'Evidences', 'evidences', 'Evidence', 'evidence');
    const evidence = uniqueStrings(flattenStrings(evidenceValue)
      .map(value => value.trim())
      .filter(value => value.length >= 12));
    if (evidence.length === 0) {
      skippedWithoutEvidence++;
      return;
    }
    const aspect = readString(record, 'Aspect', 'aspect');
    const complexity = readString(record, 'Complexity', 'complexity', 'Complex', 'complex');
    cases.push({
      name: qid,
      query: question,
      expectedEvidence: evidence,
      dimensions: Object.fromEntries([
        aspect ? ['aspect', aspect] : undefined,
        complexity ? ['complexity', complexity] : undefined,
      ].filter((entry): entry is [string, string] => !!entry)),
    });
  });

  return { cases, skippedWithoutEvidence };
}

/** Deterministic round-robin sample that keeps aspect/complexity coverage. */
export function sampleNovelQaCases(cases: RagEvaluationCase[], limit: number): RagEvaluationCase[] {
  if (limit <= 0 || cases.length <= limit) {
    return [...cases];
  }
  const groups = new Map<string, RagEvaluationCase[]>();
  for (const item of cases) {
    const key = `${item.dimensions?.aspect || 'unknown'}:${item.dimensions?.complexity || 'unknown'}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const orderedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  const sampled: RagEvaluationCase[] = [];
  let offset = 0;
  while (sampled.length < limit) {
    let added = false;
    for (const [, group] of orderedGroups) {
      if (group[offset] && sampled.length < limit) {
        sampled.push(group[offset]);
        added = true;
      }
    }
    if (!added) {
      break;
    }
    offset++;
  }
  return sampled;
}

function visit(
  value: unknown,
  inheritedId: string | undefined,
  onRecord: (record: Record<string, unknown>, inheritedId?: string) => void
): void {
  if (Array.isArray(value)) {
    value.forEach(item => visit(item, inheritedId, onRecord));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (readString(value, 'Question', 'question')) {
    onRecord(value, inheritedId);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(child, /^Q\w+/i.test(key) ? key : inheritedId, onRecord);
  }
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = readValue(record, ...keys);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenStrings);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(flattenStrings);
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
