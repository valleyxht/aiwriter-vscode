import * as assert from 'assert';
import { collectFileMutationSummaries } from '../ai/runtime/file-mutations';

suite('File mutation summaries', () => {
  test('collects only confirmed changed file mutations', () => {
    const result = collectFileMutationSummaries([
      { tool: 'searchFiles', result: 'ok' },
      { tool: 'modifyFile', mutation: { filepath: 'a.md', changed: false } },
      {
        tool: 'modifyFile',
        mutation: {
          filepath: 'chapter.md',
          changed: true,
          beforeExists: true,
          afterExists: true,
          beforeChars: 10,
          afterChars: 30,
          beforeSha256: 'before',
          afterSha256: 'after',
        },
      },
    ]);

    assert.deepStrictEqual(result, [{
      tool: 'modifyFile',
      filepath: 'chapter.md',
      mode: 'atomic-append-or-replace',
      changed: true,
      beforeExists: true,
      afterExists: true,
      beforeChars: 10,
      afterChars: 30,
      beforeSha256: 'before',
      afterSha256: 'after',
    }]);
  });

});
