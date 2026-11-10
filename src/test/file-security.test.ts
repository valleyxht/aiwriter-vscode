import * as assert from 'assert';
import * as path from 'path';
import { isPathWithinRoot } from '../platform/vscode';

suite('File tool workspace boundary', () => {
  test('accepts descendants and rejects traversal or sibling paths', () => {
    const root = path.resolve('D:\\workspace\\novel');

    assert.strictEqual(isPathWithinRoot(root, path.join(root, 'chapters', 'one.md')), true);
    assert.strictEqual(isPathWithinRoot(root, root), true);
    assert.strictEqual(isPathWithinRoot(root, path.resolve(root, '..', 'secret.txt')), false);
    assert.strictEqual(isPathWithinRoot(root, path.resolve('D:\\workspace\\novel-backup\\one.md')), false);
  });
});
