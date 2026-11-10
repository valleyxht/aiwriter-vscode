export interface KeywordDocument<T> {
  value: T;
  text: string;
}

export interface KeywordHit<T> {
  value: T;
  score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function tokenizeForKeywordSearch(text: string): string[] {
  const runs = text.toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || [];
  const tokens: string[] = [];
  for (const run of runs) {
    if (/^[\p{Script=Han}]+$/u.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) {
        tokens.push(chars[0]);
      } else {
        for (let i = 0; i < chars.length - 1; i++) {
          tokens.push(chars.slice(i, i + 2).join(''));
        }
        if (chars.length <= 6) {
          tokens.push(run);
        }
      }
    } else if (run.length > 1) {
      tokens.push(run);
    }
  }
  return tokens;
}

export function rankKeywordDocuments<T>(
  query: string,
  documents: KeywordDocument<T>[],
  topK: number
): KeywordHit<T>[] {
  return new KeywordIndex(documents).search(query, topK);
}

/** Derived in-memory data: build once per index revision, never persist a second source of truth. */
export class KeywordIndex<T> {
  private readonly documents: { value: T; length: number; frequencies: Map<string, number> }[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(documents: KeywordDocument<T>[]) {
    this.documents = documents.map(document => {
      const tokens = tokenizeForKeywordSearch(document.text);
      const frequencies = new Map<string, number>();
      for (const term of tokens) { frequencies.set(term, (frequencies.get(term) || 0) + 1); }
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
      }
      return { value: document.value, length: tokens.length, frequencies };
    });
    this.averageLength = this.documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  }

  search(query: string, topK: number, eligible?: (value: T) => boolean): KeywordHit<T>[] {
    const documents = eligible ? this.documents.filter(document => eligible(document.value)) : this.documents;
    if (documents.length === 0 || topK <= 0) {
      return [];
    }
    const queryTerms = Array.from(new Set(tokenizeForKeywordSearch(query)));
    if (queryTerms.length === 0) {
      return [];
    }
    // Filtered queries must use statistics from their eligible corpus, just like the original implementation.
    const averageLength = eligible
      ? documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1 : this.averageLength;
    const documentFrequency = eligible ? new Map<string, number>() : this.documentFrequency;
    if (eligible) {
      for (const document of documents) {
        for (const term of queryTerms) {
          if (document.frequencies.has(term)) {
            documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
          }
        }
      }
    }

    return documents.map(document => {
      const frequencies = document.frequencies;
      let score = 0;
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) || 0;
        if (frequency === 0) {
          continue;
        }
        const df = documentFrequency.get(term) || 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * document.length / averageLength);
        score += idf * (frequency * (BM25_K1 + 1)) / denominator;
      }
      return { value: document.value, score };
    })
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
