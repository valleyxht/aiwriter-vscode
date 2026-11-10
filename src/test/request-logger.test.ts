import * as assert from 'assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage } from '../ai/messages';
import {
  createWritingAssistantAgent,
  DEFAULT_AGENT_LIMITS,
  getRequestLogPath,
  RequestJsonlLogger,
  summarizeToolArguments,
} from '../ai/runtime';
import { TokenCounter } from '../memory/token-counter';
import { DEFAULT_AI_CONFIG } from '../types';

suite('request and file-operation observability', () => {
  test('writes one discoverable JSONL file per request', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'aiwriter-request-log-'));
    const logger = new RequestJsonlLogger();
    try {
      await logger.write(workspace, 'request:unsafe/id', {
        event: 'request_start',
        data: { model: 'test-model' },
      });
      const filepath = getRequestLogPath(workspace, 'request:unsafe/id');
      const content = await readFile(filepath, 'utf8');
      assert.match(filepath, /logs[\\/]requests/);
      assert.doesNotMatch(filepath, /\.aiwriter/);
      assert.match(filepath, /request_unsafe_id\.jsonl$/);
      assert.match(content, /request_start/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('records content telemetry without persisting novel text', () => {
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const summary = summarizeToolArguments({
        filepath: 'D:\\novel\\chapter.md',
        content: '这是一段不应进入日志的小说正文。',
      }, counter);
      const serialized = JSON.stringify(summary);
      assert.match(serialized, /chapter\.md/);
      assert.match(serialized, /sha256/);
      assert.match(serialized, /chars/);
      assert.doesNotMatch(serialized, /不应进入日志/);
    } finally {
      counter.dispose();
    }
  });

  test('records modify operations as telemetry without persisting their text', () => {
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const summary = summarizeToolArguments({
        filepath: 'D:\\novel\\chapter.md',
        operations: [
          { type: 'append', content: '追加内容不能进入日志' },
          { type: 'replace', oldText: '需要替换的原文', newText: '修改后的正文', replaceAll: true },
        ],
      }, counter);
      const serialized = JSON.stringify(summary);
      assert.match(serialized, /append/);
      assert.match(serialized, /replace/);
      assert.match(serialized, /sha256/);
      assert.match(serialized, /replaceAll/);
      assert.doesNotMatch(serialized, /追加内容|需要替换|修改后的正文/);
    } finally {
      counter.dispose();
    }
  });

  test('captures before and after snapshots for a file creation tool call', async () => {
    const files = new Map<string, string>();
    const fileSystem = {
      validatePath: async (filepath: string) => ({ success: true, message: 'ok', content: filepath }),
      readFile: async (filepath: string) => files.has(filepath)
        ? { success: true, message: 'ok', content: files.get(filepath) }
        : { success: false, message: 'missing' },
      fileExists: async (filepath: string) => files.has(filepath),
      createFile: async (filepath: string, content: string) => {
        files.set(filepath, content);
        return { success: true, message: 'created' };
      },
      editFile: async () => ({ success: true, message: 'edited' }),
      writeFile: async () => ({ success: true, message: 'written' }),
      deleteFile: async () => ({ success: true, message: 'deleted' }),
      listFiles: async () => ({ success: true, message: 'ok' }),
      searchFiles: async () => ({ success: true, message: 'ok' }),
      searchInFiles: async () => ({ success: true, message: 'ok' }),
      searchAndReplace: async () => ({ success: true, message: 'ok' }),
    } as any;
    const responses = [
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'create-1',
          name: 'createNewFile',
          args: { filepath: 'D:\\workspace\\chapter.md', content: '第一段正文。' },
        }],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      new AIMessage({ content: '文件已经写入。', response_metadata: { finish_reason: 'stop' } }),
    ];
    const modelFactory = (() => ({
      bind: () => ({ invoke: async () => responses.shift()! }),
      invoke: async () => responses.shift()!,
    })) as any;
    const events: any[] = [];
    const logger = {
      write: async (_workspace: string | undefined, _requestId: string | undefined, event: any) => {
        events.push(event);
      },
    };
    const counter = new TokenCounter('gpt-4o-mini', 20);
    try {
      const graph = createWritingAssistantAgent(
        { ...DEFAULT_AI_CONFIG, apiKey: 'test' },
        fileSystem,
        { confirmFileWrite: async () => true } as any,
        undefined,
        undefined,
        undefined,
        counter,
        DEFAULT_AGENT_LIMITS,
        undefined,
        modelFactory,
        undefined,
        logger
      );
      await graph.invoke(
        {
          workspacePath: 'D:\\workspace',
          logRoot: 'D:\\extension-storage',
          messages: [new HumanMessage('创建章节文件')],
        },
        { metadata: { requestId: 'request-file-log' }, }
      );

      const started = events.find(event => event.event === 'tool_call_start');
      const completed = events.find(event => event.event === 'tool_call_complete');
      assert.strictEqual(started.data.writeMode, 'create');
      assert.strictEqual(started.data.fileBefore.exists, false);
      assert.strictEqual(completed.data.fileAfter.exists, true);
      assert.strictEqual(completed.data.fileAfter.text.chars, '第一段正文。'.length);
      assert.strictEqual(completed.data.outcome, 'success');
      assert.doesNotMatch(JSON.stringify(events), /第一段正文/);
    } finally {
      counter.dispose();
    }
  });
});
