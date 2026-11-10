import * as assert from 'assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequestJsonlLogger } from '../ai/runtime/request-logger';
import { summarizeText } from '../ai/runtime/request-logger';

suite('Specialist log privacy', () => {
  test('persists telemetry without manuscripts, prompts, review quotes or echoed errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwriter-editor-log-'));
    const privateText = '未公开的小说正文与人物秘密';
    try {
      await new RequestJsonlLogger().write(root, 'privacy-test', {
        event: 'editor_pass_response', node: 'draft',
        data: {
          model: 'test-model', changed: true, outputTokens: 42,
          draft: privateText, finalText: privateText, raw: privateText,
          error: privateText,
          messages: [{ role: 'human', content: privateText }],
          review: { verdict: 'revise', revisedText: privateText, issues: [privateText] },
        },
      });
      const directory = path.join(root, 'logs', 'requests');
      const files = await readdir(directory);
      assert.strictEqual(files.length, 1);
      const text = await readFile(path.join(directory, files[0]), 'utf8');
      assert.ok(!text.includes(privateText));
      const entry = JSON.parse(text);
      assert.strictEqual(entry.requestId, 'privacy-test');
      assert.strictEqual(entry.data.model, 'test-model');
      assert.strictEqual(entry.data.outputTokens, 42);
      assert.strictEqual(entry.data.changed, true);
      assert.strictEqual(entry.data.messages[0].role, 'human');
      for (const summary of [entry.data.draft, entry.data.finalText, entry.data.raw,
        entry.data.error, entry.data.messages[0].content, entry.data.review.revisedText,
        entry.data.review.issues[0]]) {
        assert.deepStrictEqual(summary, JSON.parse(JSON.stringify(summarizeText(privateText))));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
