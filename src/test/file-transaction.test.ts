import * as assert from 'assert';
import { ContentVersionStore, FileTransactionManager } from '../history';
import { FileOperationResult, IFileSystem, SearchResult } from '../types';

class MemoryContentStore implements ContentVersionStore {
  private values = new Map<string, Uint8Array>();

  async put(content: Uint8Array): Promise<string> {
    const id = `blob:${Buffer.from(content).toString('base64')}`;
    this.values.set(id, Uint8Array.from(content));
    return id;
  }

  async get(id: string): Promise<Uint8Array | undefined> {
    return this.values.get(id);
  }

  async has(id: string): Promise<boolean> {
    return this.values.has(id);
  }
}

class MemoryFileSystem implements IFileSystem {
  readonly files = new Map<string, string>();

  async validatePath(filepath: string): Promise<FileOperationResult> {
    return { success: true, message: 'ok', content: filepath };
  }
  async readFile(filepath: string): Promise<FileOperationResult> {
    return this.files.has(filepath)
      ? { success: true, message: 'ok', content: this.files.get(filepath) }
      : { success: false, message: 'missing' };
  }
  async writeFile(filepath: string, content: string): Promise<FileOperationResult> {
    this.files.set(filepath, content);
    return { success: true, message: 'written' };
  }
  async createFile(filepath: string, content: string): Promise<FileOperationResult> {
    this.files.set(filepath, content);
    return { success: true, message: 'created' };
  }
  async editFile(filepath: string, content: string): Promise<FileOperationResult> {
    this.files.set(filepath, content);
    return { success: true, message: 'edited' };
  }
  async deleteFile(filepath: string): Promise<FileOperationResult> {
    this.files.delete(filepath);
    return { success: true, message: 'deleted' };
  }
  async fileExists(filepath: string): Promise<boolean> { return this.files.has(filepath); }
  async listFiles(): Promise<FileOperationResult> { return { success: true, message: 'ok' }; }
  async searchFiles(): Promise<FileOperationResult> { return { success: true, message: 'ok' }; }
  async searchInFiles(): Promise<SearchResult> { return { success: true, message: 'ok' }; }
  async searchAndReplace(): Promise<FileOperationResult> { return { success: true, message: 'ok' }; }
}

function createManager(fileSystem: MemoryFileSystem): FileTransactionManager {
  let persisted: unknown;
  const metadata = {
    getWorkspaceData: async <T>(): Promise<T | undefined> => persisted as T | undefined,
    setWorkspaceData: async <T>(_key: string, value: T): Promise<void> => { persisted = value; },
  };
  return new FileTransactionManager(metadata, new MemoryContentStore(), fileSystem);
}

const context = (conversationIndex: number) => ({
  sessionId: 'session-1',
  conversationIndex,
  workspaceDirectory: 'D:\\workspace',
});

suite('File transaction history', () => {
  test('restores edits across multiple conversation turns in reverse order', async () => {
    const fs = new MemoryFileSystem();
    const filepath = 'D:\\workspace\\chapter.md';
    fs.files.set(filepath, 'original');
    const manager = createManager(fs);
    await manager.initialize();

    await manager.begin('request-1', context(0));
    await manager.executeWrite('request-1', filepath, 'turn one', () => fs.editFile(filepath, 'turn one'));
    await manager.complete('request-1');
    await manager.begin('request-2', context(1));
    await manager.executeWrite('request-2', filepath, 'turn two', () => fs.editFile(filepath, 'turn two'));
    await manager.complete('request-2');

    const result = await manager.rollbackFrom('session-1', 0);
    assert.deepStrictEqual(result.conflicts, []);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(fs.files.get(filepath), 'original');
  });

  test('keeps the first baseline for repeated writes and deletes newly created files', async () => {
    const fs = new MemoryFileSystem();
    const edited = 'D:\\workspace\\existing.md';
    const created = 'D:\\workspace\\new.md';
    fs.files.set(edited, 'before');
    const manager = createManager(fs);
    await manager.initialize();
    await manager.begin('request-1', context(0));
    await manager.executeWrite('request-1', edited, 'middle', () => fs.editFile(edited, 'middle'));
    await manager.executeWrite('request-1', edited, 'after', () => fs.editFile(edited, 'after'));
    await manager.executeWrite('request-1', created, 'new', () => fs.createFile(created, 'new'));
    await manager.complete('request-1');

    const result = await manager.rollbackFrom('session-1', 0);
    assert.strictEqual(fs.files.get(edited), 'before');
    assert.strictEqual(fs.files.has(created), false);
    assert.deepStrictEqual(result.deleted, [created]);
  });

  test('preflights every file and does not overwrite user changes on conflict', async () => {
    const fs = new MemoryFileSystem();
    const first = 'D:\\workspace\\first.md';
    const second = 'D:\\workspace\\second.md';
    fs.files.set(first, 'a');
    fs.files.set(second, 'b');
    const manager = createManager(fs);
    await manager.initialize();
    await manager.begin('request-1', context(0));
    await manager.executeWrite('request-1', first, 'ai-a', () => fs.editFile(first, 'ai-a'));
    await manager.executeWrite('request-1', second, 'ai-b', () => fs.editFile(second, 'ai-b'));
    await manager.complete('request-1');
    fs.files.set(second, 'user-b');

    const result = await manager.rollbackFrom('session-1', 0);
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(fs.files.get(first), 'ai-a');
    assert.strictEqual(fs.files.get(second), 'user-b');
  });
});
