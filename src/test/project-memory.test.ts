import * as assert from 'node:assert';
import { AIMessage } from '../ai/messages';
import { ProjectMemoryManager, PROJECT_MEMORY_FILENAME } from '../memory/project';
import { AIConfig, FileOperationResult, IFileSystem, SearchResult } from '../types';

const CONFIG: AIConfig = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://example.invalid/v1',
  model: 'user-supplied-model',
  maxTokens: 1024,
  temperature: 0,
  contextWindowMode: 'manual',
  contextWindowSize: 20,
};

suite('Project memory initialization', () => {
  test('loads an existing AIWRITER.md without invoking the model', async () => {
    const fs = new MemoryFileSystem({
      'C:\\novel\\AIWRITER.md': '# 工程说明\n\n- `正文/`：小说正文。\n',
    });
    let modelCalls = 0;
    const manager = new ProjectMemoryManager(fs, () => CONFIG, () => {
      modelCalls++;
      throw new Error('model should not be created');
    });

    const result = await manager.startSession('C:\\novel');

    assert.strictEqual(result.status, 'loaded');
    assert.match(result.content || '', /正文/);
    assert.strictEqual(modelCalls, 0);
  });

  test('uses read-only exploration and the single-purpose create tool', async () => {
    const fs = new MemoryFileSystem({
      'C:\\novel\\总纲.md': '# 故事总纲',
    });
    const invokedTools: string[] = [];
    let initializationPrompt = '';
    let turn = 0;
    const manager = new ProjectMemoryManager(fs, () => CONFIG, (_config, _tools) => ({
      invoke: async input => {
        turn++;
        if (turn === 1 && Array.isArray(input)) {
          initializationPrompt = String((input[0] as { content?: unknown })?.content || '');
        }
        const call = turn === 1
          ? { id: 'list-1', name: 'listFiles', args: { directory: '.' } }
          : {
              id: 'create-1',
              name: 'createProjectMemory',
              args: {
                content: '# AI Writer 项目说明\n\n- `总纲.md`：故事整体规划入口。',
              },
            };
        invokedTools.push(call.name);
        return new AIMessage({ content: '', tool_calls: [call] });
      },
    }));

    const result = await manager.startSession('C:\\novel');

    assert.strictEqual(result.status, 'created');
    assert.deepStrictEqual(invokedTools, ['listFiles', 'createProjectMemory']);
    assert.match(initializationPrompt, /任何具体人物、人物关系、地点/);
    assert.match(initializationPrompt, /人物姓名、地点名、章节名/);
    assert.match(initializationPrompt, /逐文件清单/);
    assert.strictEqual(
      fs.get('C:\\novel\\AIWRITER.md'),
      '# AI Writer 项目说明\n\n- `总纲.md`：故事整体规划入口。\n'
    );
  });

  test('does not create a placeholder when the model is not configured', async () => {
    const fs = new MemoryFileSystem();
    const manager = new ProjectMemoryManager(
      fs,
      () => ({ ...CONFIG, apiKey: '', model: '' })
    );

    const result = await manager.startSession('C:\\novel');

    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(await fs.fileExists(`C:\\novel\\${PROJECT_MEMORY_FILENAME}`), false);
  });

  test('does not run initialization on a later turn when memory is missing', async () => {
    const fs = new MemoryFileSystem();
    let modelCreated = false;
    const manager = new ProjectMemoryManager(fs, () => CONFIG, () => {
      modelCreated = true;
      throw new Error('later turns must not initialize');
    });

    const result = await manager.loadExisting('C:\\novel');

    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(modelCreated, false);
    assert.strictEqual(await fs.fileExists('C:\\novel\\AIWRITER.md'), false);
  });

  test('keeps a stable snapshot within a session and reloads on the next session', async () => {
    const filepath = 'C:\\novel\\AIWRITER.md';
    const fs = new MemoryFileSystem({ [filepath]: '# 第一版' });
    const manager = new ProjectMemoryManager(fs, () => CONFIG);

    await manager.startSession('C:\\novel');
    fs.set(filepath, '# 第二版');
    await manager.ensureInitialized('C:\\novel');
    assert.strictEqual(manager.currentContent, '# 第一版');

    await manager.startSession('C:\\novel');
    assert.strictEqual(manager.currentContent, '# 第二版');
  });
});

class MemoryFileSystem implements IFileSystem {
  private readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [filepath, content] of Object.entries(initial)) {
      this.files.set(this.key(filepath), content);
    }
  }

  get(filepath: string): string | undefined {
    return this.files.get(this.key(filepath));
  }

  set(filepath: string, content: string): void {
    this.files.set(this.key(filepath), content);
  }

  async validatePath(filepath: string): Promise<FileOperationResult> {
    return { success: true, message: 'ok', content: filepath };
  }

  async readFile(filepath: string): Promise<FileOperationResult> {
    const content = this.get(filepath);
    return content === undefined
      ? { success: false, message: 'not found' }
      : { success: true, message: 'ok', content };
  }

  async writeFile(filepath: string, content: string): Promise<FileOperationResult> {
    this.set(filepath, content);
    return { success: true, message: 'ok' };
  }

  async createFile(filepath: string, content: string): Promise<FileOperationResult> {
    this.set(filepath, content);
    return { success: true, message: 'ok' };
  }

  async editFile(filepath: string, content: string): Promise<FileOperationResult> {
    return this.writeFile(filepath, content);
  }

  async deleteFile(filepath: string): Promise<FileOperationResult> {
    this.files.delete(this.key(filepath));
    return { success: true, message: 'ok' };
  }

  async fileExists(filepath: string): Promise<boolean> {
    return this.files.has(this.key(filepath));
  }

  async listFiles(): Promise<FileOperationResult> {
    const content = [...this.files.keys()].map(filepath => `[FILE] ${filepath}`).join('\n');
    return { success: true, message: 'ok', content };
  }

  async searchFiles(): Promise<FileOperationResult> {
    return this.listFiles();
  }

  async searchInFiles(): Promise<SearchResult> {
    return { success: true, message: 'ok', matches: [] };
  }

  async searchAndReplace(): Promise<FileOperationResult> {
    return { success: false, message: 'unused' };
  }

  private key(filepath: string): string {
    return filepath.replace(/\//g, '\\').toLowerCase();
  }
}
