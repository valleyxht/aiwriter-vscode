import * as assert from 'assert';
import {
  exactRangeForLines,
  parseMarkdownDocument,
  validateLosslessCoverage,
} from '../features/markdown-organization';
import { OrganizationToolState } from '../features/markdown-organization/agent';

function findTool(state: OrganizationToolState, name: string): any {
  const selected = state.createTools().find(candidate => candidate.name === name);
  assert.ok(selected, `missing tool: ${name}`);
  return selected;
}

suite('Markdown organization agent tools', () => {
  test('exposes only the constrained organization tools', () => {
    const document = parseMarkdownDocument('人物.md', '人物.md', Buffer.from('# 林舟\n原文。\n'));
    const names = new OrganizationToolState([document], () => undefined).createTools().map(item => item.name);
    assert.deepStrictEqual(names, [
      'listMarkdownDirectory', 'readMarkdownFile', 'createOrganizationFolder',
      'splitMarkdownFile', 'skipMarkdownFile',
    ]);
    const splitTool = findTool(new OrganizationToolState([document], () => undefined), 'splitMarkdownFile');
    assert.ok(!('content' in splitTool.schema.properties), 'split tool must not accept generated content');
  });

  test('lists and reads existing Markdown without changing its text', async () => {
    const source = Buffer.from('---\r\ntype: character\r\ntags: [人物, 主角]\r\n---\r\n# 林舟\r\n原文。\r\n');
    const document = parseMarkdownDocument('D:/book/设定/人物.md', '设定/人物.md', source);
    const state = new OrganizationToolState([document], () => undefined);
    const listing = JSON.parse(await findTool(state, 'listMarkdownDirectory').invoke({ directory: '.' }));
    assert.deepStrictEqual(listing.entries, [{ name: '设定', type: 'directory' }]);
    const read = JSON.parse(await findTool(state, 'readMarkdownFile').invoke({ filepath: '设定/人物.md' }));
    assert.strictEqual(read.metadata.type, 'character');
    assert.deepStrictEqual(read.metadata.tags, ['人物', '主角']);
    assert.match(read.content, /6: 原文。/);
  });

  test('stages exact line ranges that reconstruct CRLF source bytes', async () => {
    const source = Buffer.from('# 第一章 雨夜\r\n甲。\r\n# 第二章 城门\r\n乙。\r\n', 'utf8');
    const document = parseMarkdownDocument('D:/book/正文.md', '正文.md', source);
    const state = new OrganizationToolState([document], () => undefined);
    await findTool(state, 'createOrganizationFolder').invoke({ directory: '正文' });
    await findTool(state, 'splitMarkdownFile').invoke({
      sourcePath: '正文.md', startLine: 1, endLine: 2, targetPath: '正文/第一章 雨夜.md',
    });
    await findTool(state, 'splitMarkdownFile').invoke({
      sourcePath: '正文.md', startLine: 3, endLine: 4, targetPath: '正文/第二章 城门.md',
    });
    const plan = state.finalize('D:/book');
    assert.strictEqual(plan.operations.length, 2);
    assert.strictEqual(plan.skipped.length, 0);
    assert.ok(validateLosslessCoverage(document, plan.operations));
    const rebuilt = Buffer.concat(plan.operations.map(operation =>
      source.subarray(operation.range.startByte, operation.range.endByte)));
    assert.deepStrictEqual(rebuilt, source);
  });

  test('rejects incomplete AI splits and emits no partial output', async () => {
    const document = parseMarkdownDocument('D:/book/正文.md', '正文.md', Buffer.from('第一行\n第二行\n第三行\n'));
    const state = new OrganizationToolState([document], () => undefined);
    await findTool(state, 'createOrganizationFolder').invoke({ directory: '正文' });
    await findTool(state, 'splitMarkdownFile').invoke({
      sourcePath: '正文.md', startLine: 2, endLine: 3, targetPath: '正文/不完整.md',
    });
    const plan = state.finalize('D:/book');
    assert.deepStrictEqual(plan.operations, []);
    assert.match(plan.skipped[0].reason, /遗漏、重叠/);
  });

  test('skips unsupported content without generating files', async () => {
    const document = parseMarkdownDocument('D:/book/随手记录.md', '随手记录.md', Buffer.from('# 随手记录\n购物清单。\n'));
    const state = new OrganizationToolState([document], () => undefined);
    await findTool(state, 'skipMarkdownFile').invoke({ filepath: '随手记录.md', reason: '不属于支持的小说资料' });
    const plan = state.finalize('D:/book');
    assert.deepStrictEqual(plan.operations, []);
    assert.strictEqual(plan.skipped[0].reason, '不属于支持的小说资料');
  });

  test('requires a fixed category folder and forbids traversal', async () => {
    const document = parseMarkdownDocument('D:/book/正文.md', '正文.md', Buffer.from('原文\n'));
    const state = new OrganizationToolState([document], () => undefined);
    await assert.rejects(() => findTool(state, 'createOrganizationFolder').invoke({ directory: '其他' }), /第一层目录只能是/);
    await assert.rejects(() => findTool(state, 'createOrganizationFolder').invoke({ directory: '../正文' }), /无效目标路径/);
  });

  test('line ranges include the final newline without inventing an empty line', () => {
    const source = Buffer.from('甲\r\n乙\r\n');
    const document = parseMarkdownDocument('D:/book/a.md', 'a.md', source);
    const range = exactRangeForLines(document, 1, 2);
    assert.strictEqual(document.lineCount, 2);
    assert.deepStrictEqual(source.subarray(range.startByte, range.endByte), source);
  });

  test('does not send empty Markdown files to the organization agent', () => {
    assert.throws(
      () => parseMarkdownDocument('D:/book/空文件.md', '空文件.md', Buffer.alloc(0)),
      /空 Markdown 文件不需要整理/
    );
  });
});
