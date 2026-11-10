import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ripgrepCandidates, selectSearchCandidates } from '../platform/vscode/ripgrep-search';

suite('Native search candidate selection', () => {
  let root: string;
  setup(async () => { root = await fs.mkdtemp(path.join(process.cwd(), 'out', 'rg-test-')); });
  teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const write = async (name: string, bytes: string | Buffer): Promise<string> => {
    const file = path.join(root, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  const largeFiles = async () => Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const file = await write(`${i}.txt`, '');
    await fs.truncate(file, 2 * 1024 * 1024);
    return file;
  }));

  test('finds UTF-8, GBK and BOM UTF-16 without depending on gitignore', async () => {
    const text = '大殿下';
    const gbk = Buffer.from([0xb4, 0xf3, 0xb5, 0xee, 0xcf, 0xc2]);
    const le = Buffer.from('\ufeff' + text, 'utf16le');
    const be = Buffer.from(le).swap16();
    const files = await Promise.all([write('中文 空格.txt', text), write('gbk.txt', gbk), write('le.txt', le), write('be.txt', be)]);
    await write('.gitignore', '*.txt');
    const unrelated = await write('其他.txt', '无人');
    const found = await ripgrepCandidates([...files, unrelated], text);
    assert.deepEqual([...found].sort(), files.sort());
  });

  test('literal punctuation and option-like query never become regex or shell instructions', async () => {
    const file = await write('-name.txt', '--help a.b [角色] $(test)');
    assert.ok((await ripgrepCandidates([file], '--help')).has(file));
    assert.ok((await ripgrepCandidates([file], 'a.b [角色] $(test)')).has(file));
    assert.equal((await ripgrepCandidates([file], 'aXb')).size, 0);
  });

  test('small scope and multiline query never launch a process', async () => {
    const file = await write('小稿.txt', '正文');
    const never = async (): Promise<Set<string>> => { throw new Error('must not launch'); };
    assert.equal((await selectSearchCandidates([file], '正文', new Set(), never)).backend, 'direct');
    const files = await largeFiles();
    assert.equal((await selectSearchCandidates(files, '跨\n行', new Set(), never)).backend, 'direct');
  });

  test('keeps live editor documents even if disk search does not match, and preserves order', async () => {
    const disk = await largeFiles();
    const editor = await write('编辑中.txt', '磁盘旧文');
    const input = [editor, ...disk];
    const result = await selectSearchCandidates(input, '未保存正文', new Set([editor]), async files => {
      assert.ok(!files.includes(editor));
      return new Set([disk[5]]);
    });
    assert.equal(result.backend, 'ripgrep');
    assert.deepEqual(result.files, [editor, disk[5]]);
  });

  test('native startup/timeout failure falls back to the original scope', async () => {
    const files = await largeFiles();
    const result = await selectSearchCandidates(files, '查询', new Set(), async () => { throw new Error('ENOENT'); });
    assert.equal(result.backend, 'direct-fallback');
    assert.deepEqual(result.files, files);
  });
});
