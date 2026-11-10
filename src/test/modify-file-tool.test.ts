import * as assert from 'assert';
import { createHash } from 'node:crypto';
import {
  applyModifyFileOperations,
  createFileTools,
  ModifyFileOperation,
} from '../ai/tools/index';
import type { IFileSystem } from '../types';
import type { FileMutationSummary } from '../ai/runtime';

function createMemoryFileSystem(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  let editCalls = 0;
  const fileSystem: IFileSystem = {
    validatePath: async filepath => ({ success: true, message: 'ok', content: filepath }),
    readFile: async filepath => files.has(filepath)
      ? { success: true, message: 'ok', content: files.get(filepath) }
      : { success: false, message: 'missing' },
    writeFile: async (filepath, content) => {
      files.set(filepath, content);
      return { success: true, message: 'written' };
    },
    createFile: async (filepath, content) => {
      files.set(filepath, content);
      return { success: true, message: 'created' };
    },
    editFile: async (filepath, content) => {
      editCalls += 1;
      files.set(filepath, content);
      return { success: true, message: 'edited' };
    },
    deleteFile: async filepath => {
      files.delete(filepath);
      return { success: true, message: 'deleted' };
    },
    fileExists: async filepath => files.has(filepath),
    listFiles: async () => ({ success: true, message: 'ok' }),
    searchFiles: async () => ({ success: true, message: 'ok' }),
    searchInFiles: async () => ({ success: true, message: 'ok', matches: [] }),
    searchAndReplace: async () => ({ success: true, message: 'unused' }),
  };
  return { files, fileSystem, getEditCalls: () => editCalls };
}

suite('modifyFile tool', () => {
  test('applies append and replace operations in order', () => {
    const operations: ModifyFileOperation[] = [
      { type: 'append', content: '\n第二段' },
      { type: 'replace', oldText: '第一段', newText: '修改后的第一段' },
    ];
    const result = applyModifyFileOperations('第一段', operations);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, '修改后的第一段\n第二段');
    assert.strictEqual(result.appliedOperations, 2);
  });

  test('aborts the whole batch when one operation cannot be applied', () => {
    const original = '第一段';
    const result = applyModifyFileOperations(original, [
      { type: 'append', content: '\n第二段' },
      { type: 'replace', oldText: '不存在的原文', newText: '替换内容' },
    ]);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.content, original);
    assert.strictEqual(result.appliedOperations, 0);
  });

  test('exposes one model-facing modification tool and writes once per batch', async () => {
    const filepath = 'D:\\novel\\chapter.md';
    const memory = createMemoryFileSystem({ [filepath]: '第一段' });
    const approvals: Array<{ original: string; proposed: string }> = [];
    const tools = createFileTools(memory.fileSystem, {
      confirmFileWrite: async (_filepath, _action, original, proposed) => {
        approvals.push({ original, proposed });
        return true;
      },
    });

    assert.ok(tools.some(tool => tool.name === 'modifyFile'));
    assert.ok(!tools.some(tool => tool.name === 'editFile' || tool.name === 'searchAndReplace'));

    const modifyFile = tools.find(tool => tool.name === 'modifyFile')!;
    await modifyFile.func({
      filepath,
      operations: [
        { type: 'append', content: '\n第二段' },
        { type: 'replace', oldText: '第二段', newText: '修改后的第二段' },
      ],
    });

    assert.strictEqual(memory.files.get(filepath), '第一段\n修改后的第二段');
    assert.strictEqual(memory.getEditCalls(), 1);
    assert.deepStrictEqual(approvals, [{
      original: '第一段',
      proposed: '第一段\n修改后的第二段',
    }]);
  });

  test('rejects stale expectedSha256 without approval or write', async () => {
    const filepath = 'D:\\novel\\chapter.md';
    const memory = createMemoryFileSystem({ [filepath]: '当前正文' });
    let approvalCalls = 0;
    const tools = createFileTools(memory.fileSystem, {
      confirmFileWrite: async () => {
        approvalCalls += 1;
        return true;
      },
    });
    const modifyFile = tools.find(tool => tool.name === 'modifyFile')!;
    const staleSha = createHash('sha256').update('旧正文').digest('hex');

    const response = await modifyFile.func({
      filepath,
      expectedSha256: staleSha,
      operations: [{ type: 'append', content: '不应写入' }],
    });

    assert.match(response.content, /expectedSha256/);
    assert.strictEqual(memory.files.get(filepath), '当前正文');
    assert.strictEqual(memory.getEditCalls(), 0);
    assert.strictEqual(approvalCalls, 0);
  });

  test('does not approve or write an invalid atomic batch', async () => {
    const filepath = 'D:\\novel\\chapter.md';
    const memory = createMemoryFileSystem({ [filepath]: '当前正文' });
    let approvalCalls = 0;
    const tools = createFileTools(memory.fileSystem, {
      confirmFileWrite: async () => {
        approvalCalls += 1;
        return true;
      },
    });
    const modifyFile = tools.find(tool => tool.name === 'modifyFile')!;

    await modifyFile.func({
      filepath,
      operations: [
        { type: 'append', content: '\n临时追加' },
        { type: 'replace', oldText: '找不到', newText: '替换' },
      ],
    });

    assert.strictEqual(memory.files.get(filepath), '当前正文');
    assert.strictEqual(memory.getEditCalls(), 0);
    assert.strictEqual(approvalCalls, 0);
  });

  test('does not overwrite a file changed while approval is pending', async () => {
    const filepath = 'D:\\novel\\chapter.md';
    const memory = createMemoryFileSystem({ [filepath]: '读取时正文' });
    const tools = createFileTools(memory.fileSystem, {
      confirmFileWrite: async () => {
        memory.files.set(filepath, '用户刚刚手工修改的正文');
        return true;
      },
    });
    const modifyFile = tools.find(tool => tool.name === 'modifyFile')!;

    const response = await modifyFile.func({
      filepath,
      operations: [{ type: 'append', content: '\nAI 追加内容' }],
    });

    assert.match(response.content, /确认期间发生了变化/);
    assert.strictEqual(memory.files.get(filepath), '用户刚刚手工修改的正文');
    assert.strictEqual(memory.getEditCalls(), 0);
  });

  test('reports exact edits without writing-preparation-specific follow-up authorization', async () => {
    const filepath = 'D:\\novel\\chapter.md';
    const memory = createMemoryFileSystem({ [filepath]: '前文' });
    let approvalOptions: any;
    const tools = createFileTools(memory.fileSystem, {
      confirmFileWrite: async (_path, _action, _before, _after, _signal, options) => {
        approvalOptions = options;
        return true;
      },
    });
    let recorded: FileMutationSummary | undefined;
    const response = await tools.find(tool => tool.name === 'modifyFile')!.func({
      filepath,
      operations: [{ type: 'append', content: '新增正文' }],
    }, undefined, {
      requestId: 'request-writer',
      onFileMutation: mutation => { recorded = mutation; },
    });

    assert.match(response.content, /文件已修改/);
    assert.deepStrictEqual(approvalOptions, { requestId: 'request-writer' });
    assert.strictEqual(recorded?.edits?.[0].startBefore, 2);
    assert.strictEqual(recorded?.edits?.[0].insertedText, '新增正文');
  });
});
