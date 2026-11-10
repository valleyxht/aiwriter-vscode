import * as assert from 'assert';
import { searchWindows, utf8Prefix, SEARCH_MAX_BYTES } from '../ai/tools/search-context';
import { EvidenceLedger } from '../ai/tools/retrieval-evidence';
import { createReadOnlyFileTools } from '../ai/tools/tools';

suite('Configurable search context', () => {
  test('returns whole matching lines, merges overlap and preserves CRLF offsets', () => {
    const text = '前文\r\n人物第一次\r\n中间\r\n人物第二次\r\n后文';
    const windows = searchWindows(text, '人物', 1);
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(text.slice(windows[0].start, windows[0].end), text);
    assert.strictEqual(windows[0].line, 2);
    const line = '开头' + '字'.repeat(300) + '人物';
    const [match] = searchWindows(line, '人物');
    assert.strictEqual(line.slice(match.start, match.end), line);
  });
  test('rejects invalid line counts and handles missing terms and huge context', () => {
    for (const value of [-1, 0.5, Infinity, NaN]) {
      assert.throws(() => searchWindows('正文', '正文', value), /非负整数/);
    }
    assert.deepStrictEqual(searchWindows('正文', '无'), []);
    assert.strictEqual(searchWindows('正文', '正文', Number.MAX_SAFE_INTEGER)[0].end, 2);
  });
  test('UTF-8 limits preserve Chinese and surrogate pairs', () => {
    assert.strictEqual(utf8Prefix('中😀文', 6), '中');
    assert.strictEqual(utf8Prefix('中😀文', 7), '中😀');
  });
  test('passes contextLines and bounds the delivered output without marking unread text as read', async () => {
    const text = '中😀'.repeat(20000);
    let received: unknown;
    const tools = createReadOnlyFileTools({ searchInFiles: async (_base: string, _query: string, _pattern: string, lines: number) => {
      received = lines;
      return { success: true, message: '', matches: [{ filepath: '/story.txt', line: 1, column: 1,
        text, charStart: 0, charEnd: text.length, version: 'v1' }] };
    } } as any);
    const ledger = new EvidenceLedger();
    const result = await tools.find(t => t.name === 'searchInFiles')!.func(
      { baseDirectory: '.', searchText: '中', contextLines: 4 }, undefined, { evidence: ledger });
    assert.strictEqual(received, 4);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= SEARCH_MAX_BYTES);
    assert.ok(result.content.includes('上限'));
    assert.ok(ledger.records[0].end < text.length);
    assert.strictEqual(ledger.records[0].content, text.slice(0, ledger.records[0].end));
    assert.ok(ledger.fresh({ filepath: '/story.txt', version: 'v1', start: 0, end: text.length, content: text }).length > 0);
  });
});
