import * as assert from 'assert';
import { checkedDocumentText, decodeSavedText, readTextWithFallback } from '../platform/vscode/text-content';

suite('Editor-decoded text for file tools and RAG', () => {
  test('recovers GBK bytes when the editor decoded them incorrectly', async () => {
    const bytes = Uint8Array.from([0xb4, 0xf3, 0xb5, 0xee, 0xcf, 0xc2]); // 大殿下
    let encoding = '';
    assert.strictEqual(await readTextWithFallback(
      { getText: () => '���', isDirty: false }, async () => bytes, true,
      value => { encoding = value; }
    ), '大殿下');
    assert.strictEqual(encoding, 'gb18030');
  });
  test('preserves a healthy unsaved editor buffer without reading disk', async () => {
    assert.strictEqual(await readTextWithFallback(
      { getText: () => '尚未保存', isDirty: true },
      async () => { throw new Error('must not read disk'); }
    ), '尚未保存');
  });
  test('never falls back to stale disk contents for a dirty broken buffer', async () => {
    await assert.rejects(readTextWithFallback(
      { getText: () => '�', isDirty: true },
      async () => { throw new Error('must not read disk'); }
    ), /未保存修改/);
  });
  test('does not discard edits made during a fallback disk read', async () => {
    const document = { getText: () => '�', isDirty: false };
    assert.strictEqual(await readTextWithFallback(document, async () => {
      document.isDirty = true;
      document.getText = () => '新的修改';
      return Buffer.from('旧的内容');
    }), '新的修改');
  });
  test('supports UTF-8 and BOM-marked UTF-16 in both byte orders', () => {
    assert.strictEqual(decodeSavedText(Buffer.from('大殿下')).text, '大殿下');
    assert.strictEqual(decodeSavedText(Buffer.from('\ufeff大殿下', 'utf16le')).text, '大殿下');
    assert.strictEqual(decodeSavedText(Uint8Array.from([0xfe, 0xff, 0x59, 0x27])).text, '大');
  });
  test('rejects broken bytes, binary content, and replacements saved in valid UTF-8', () => {
    assert.throws(() => decodeSavedText(Uint8Array.from([0x81])), /无法完整解码/);
    assert.throws(() => decodeSavedText(Uint8Array.from([0, 1, 2])), /控制字符/);
    assert.throws(() => decodeSavedText(Buffer.from('已保存�')), /正确编码/);
    assert.throws(() => decodeSavedText(Uint8Array.from([0xff, 0xfe, 0x01])), /编码标记/);
  });
  test('preserves correctly decoded Chinese text', () => {
    const text = '大殿下是他的兄长。';
    assert.strictEqual(checkedDocumentText({ getText: () => text, isDirty: false }), text);
  });
  test('rejects replacement characters instead of reporting a successful read', () => {
    assert.throws(() => checkedDocumentText({ getText: () => '���л�˵', isDirty: false }), /正确编码/);
  });
  test('only indexing requires a saved document', () => {
    const document = { getText: () => '未保存的正文', isDirty: true };
    assert.strictEqual(checkedDocumentText(document), '未保存的正文');
    assert.throws(() => checkedDocumentText(document, true), /保存/);
  });
});
