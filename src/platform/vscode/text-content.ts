import * as vscode from 'vscode';

export function checkedDocumentText(document: Pick<vscode.TextDocument, 'getText' | 'isDirty'>, requireSaved = false): string {
  if (requireSaved && document.isDirty) {
    throw new Error('请先保存文件再构建索引');
  }
  const text = document.getText();
  if (text.includes('\uFFFD')) {
    throw new Error('正文包含解码替换字符 �。请在 VS Code 中通过正确编码重新打开文件，确认中文正常后重试；不要保存乱码正文。');
  }
  return text;
}

/** Decode only known text encodings; never reinterpret a valid Unicode file as GBK. */
export function decodeSavedText(bytes: Uint8Array): { text: string; encoding: string } {
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : undefined;
  let text: string;
  let encoding = bom || 'utf-8';
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    if (bom) { throw new Error('文件有 Unicode 编码标记，但正文无法完整解码，请检查文件编码。'); }
    encoding = 'gb18030';
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw new Error('UTF-8、GB18030/GBK 均无法完整解码，请在 VS Code 中选择正确编码重新打开。');
    }
  }
  // Successful decoding alone does not prove a binary file is readable text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error('文件包含异常控制字符，无法作为正文读取，请检查文件类型或编码。');
  }
  checkedDocumentText({ getText: () => text, isDirty: false });
  return { text, encoding };
}

export async function readTextWithFallback(
  document: Pick<vscode.TextDocument, 'getText' | 'isDirty'>,
  readBytes: () => PromiseLike<Uint8Array>,
  requireSaved = false,
  onFallback?: (encoding: string) => void
): Promise<string> {
  if (requireSaved && document.isDirty) { throw new Error('请先保存文件再构建索引'); }
  if (!document.getText().includes('\uFFFD')) { return checkedDocumentText(document, requireSaved); }
  if (document.isDirty) {
    throw new Error('正文包含解码替换字符且有未保存修改，不能用磁盘旧内容替代。请先处理未保存修改，再通过正确编码重新打开。');
  }
  const bytes = await readBytes();
  // The editor may have changed while the disk read was pending.
  if (document.isDirty || !document.getText().includes('\uFFFD')) {
    return checkedDocumentText(document, requireSaved);
  }
  const decoded = decodeSavedText(bytes);
  onFallback?.(decoded.encoding);
  return decoded.text;
}

/** Prefer the live editor document; recover saved text without modifying the file or editor. */
export async function readDocumentText(uri: vscode.Uri, requireSaved = false): Promise<string> {
  return readTextWithFallback(
    await vscode.workspace.openTextDocument(uri),
    () => vscode.workspace.fs.readFile(uri),
    requireSaved,
    encoding => console.info(`[TextContent] Read-only decoding fallback: ${encoding}`)
  );
}
