import * as assert from 'node:assert';
import { applyWritingPreferenceUpdate, createWritingPreferenceTool } from '../memory/project';

suite('Writing preference memory', () => {
  test('adds a managed preference block without changing project guidance', () => {
    const original = '# AI Writer 项目说明\n\n## 目录结构\n\n- `正文/`：正文。\n';
    const result = applyWritingPreferenceUpdate(original, {
      action: 'remember',
      preference: '章节标题使用“第X章 标题”的格式。',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.changed, true);
    assert.match(result.content, /## 目录结构/);
    assert.match(result.content, /aiwriter:writing-preferences:start/);
    assert.match(result.content, /章节标题使用/);
  });

  test('deduplicates equivalent whitespace and bullet formatting', () => {
    const first = applyWritingPreferenceUpdate('# 项目\n', {
      action: 'remember',
      preference: '段落之间保留一个空行。',
    });
    const second = applyWritingPreferenceUpdate(first.content, {
      action: 'remember',
      preference: '-  段落之间保留一个空行。',
    });

    assert.strictEqual(second.changed, false);
    assert.strictEqual((second.content.match(/段落之间保留一个空行。/g) || []).length, 1);
  });

  test('replaces and forgets prior preferences without touching other content', () => {
    const remembered = applyWritingPreferenceUpdate('# 项目\n', {
      action: 'remember',
      preference: '使用第一人称。',
    });
    const replaced = applyWritingPreferenceUpdate(remembered.content, {
      action: 'replace',
      previousPreference: '使用第一人称。',
      preference: '使用第三人称限知视角。',
    });
    const forgotten = applyWritingPreferenceUpdate(replaced.content, {
      action: 'forget',
      preference: '使用第三人称限知视角。',
    });

    assert.doesNotMatch(replaced.content, /使用第一人称/);
    assert.match(replaced.content, /使用第三人称限知视角/);
    assert.strictEqual(forgotten.content, '# 项目\n');
  });

  test('the agent tool has no filepath parameter and only writes AIWRITER.md', async () => {
    let content = '# 项目\n';
    let editedPath = '';
    const fileSystem = {
      readFile: async (filepath: string) => filepath === 'AIWRITER.md'
        ? { success: true, message: 'ok', content }
        : { success: false, message: 'wrong path' },
      validatePath: async (filepath: string) => ({
        success: filepath === 'AIWRITER.md',
        message: 'ok',
        content: 'C:\\novel\\AIWRITER.md',
      }),
      editFile: async (filepath: string, nextContent: string) => {
        editedPath = filepath;
        content = nextContent;
        return { success: true, message: 'ok' };
      },
    } as any;
    const approver = {
      confirmFileWrite: async () => true,
    } as any;
    const tool = createWritingPreferenceTool(fileSystem, approver);

    assert.strictEqual(tool.schema.properties!.filepath, undefined);
    const invalid = await tool.func({
      action: 'remember',
      preference: '对话使用全角引号。',
      filepath: 'other.md',
    });

    assert.strictEqual(invalid.code, 'invalid_arguments');
    const result = await tool.func({ action: 'remember', preference: '对话使用全角引号。' });
    assert.match(result.content, /已写入 AIWRITER\.md/);
    assert.strictEqual(editedPath, 'C:\\novel\\AIWRITER.md');
    assert.match(content, /对话使用全角引号/);
  });
});
