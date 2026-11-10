/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * diff.ts - 文件差异对比管理器
 * 功能：展示、接受和拒绝文件修改
 * 包含：
 *   - Inline diff 展示（在原文件中高亮显示差异）
 *   - 接受/拒绝修改操作
 *   - 撤销支持（通过 VSCode 的 WorkspaceEdit）
 *   - 差异状态跟踪和通知
*/
import * as vscode from 'vscode';
import { FileState } from '../types';

// Inline Diff 信息
interface InlineDiffInfo {
  filepath: string;
  originalContent: string;
  modifiedContent: string;
  originalLines: string[];
  modifiedLines: string[];
  diffRanges: DiffRange[];
}

interface DiffRange {
  startLine: number;
  endLine: number;
  type: 'added' | 'removed' | 'same';
  content?: string;
}

// Diff 装饰类型
const ADDED_LINE_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(0, 255, 0, 0.15)',
  isWholeLine: true
});

const REMOVED_LINE_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 0, 0, 0.15)',
  isWholeLine: true
});

export class DiffManager {
  private inlineDiffs: Map<string, InlineDiffInfo> = new Map();
  private _onDiffUpdate?: (filepath: string, diffs: InlineDiffInfo[]) => void;

  constructor(_context: vscode.ExtensionContext) {}

  setOnDiffUpdateCallback(callback: (filepath: string, diffs: InlineDiffInfo[]) => void): void {
    this._onDiffUpdate = callback;
  }

  /**
   * 异步展示 diff，不等待用户操作
   * @param originalContent 修改前的文件内容
   * @param modifiedContent 修改后的文件内容
   * @param filepath 文件路径
   */
  async showDiffAsync(
    originalContent: string,
    modifiedContent: string,
    filepath: string
  ): Promise<void> {
    const originalLines = originalContent.split('\n');
    const modifiedLines = modifiedContent.split('\n');

    // 计算 diff
    const diffRanges = this.computeDiff(originalLines, modifiedLines);

    const diffInfo: InlineDiffInfo = {
      filepath,
      originalContent,
      modifiedContent,
      originalLines,
      modifiedLines,
      diffRanges
    };

    this.inlineDiffs.set(filepath, diffInfo);

    // 在编辑器中展示
    await this.displayInlineDiff(diffInfo);

    // 通知 UI 更新
    this._onDiffUpdate?.(filepath, Array.from(this.inlineDiffs.values()));
  }

  /**
   * 计算两个内容之间的差异
   */
  private computeDiff(originalLines: string[], modifiedLines: string[]): DiffRange[] {
    const ranges: DiffRange[] = [];
    const maxLines = Math.max(originalLines.length, modifiedLines.length);

    let i = 0;
    while (i < maxLines) {
      if (i >= originalLines.length) {
        // 新增的行
        ranges.push({
          startLine: i,
          endLine: modifiedLines.length - 1,
          type: 'added'
        });
        break;
      } else if (i >= modifiedLines.length) {
        // 删除的行
        ranges.push({
          startLine: i,
          endLine: originalLines.length - 1,
          type: 'removed'
        });
        break;
      } else if (originalLines[i] !== modifiedLines[i]) {
        // 找出连续不同的行
        let j = i;
        while (j < maxLines && originalLines[j] !== modifiedLines[j]) {
          j++;
        }
        const hasOriginal = j <= originalLines.length;
        const hasModified = j <= modifiedLines.length;

        if (!hasOriginal && hasModified) {
          ranges.push({
            startLine: i,
            endLine: modifiedLines.length - 1,
            type: 'added'
          });
        } else if (hasOriginal && !hasModified) {
          ranges.push({
            startLine: i,
            endLine: originalLines.length - 1,
            type: 'removed'
          });
        } else {
          ranges.push({
            startLine: i,
            endLine: j - 1,
            type: 'same',
            content: modifiedLines.slice(i, j).join('\n')
          });
        }
        i = j;
      } else {
        i++;
      }
    }

    return ranges;
  }

  /**
   * 在编辑器中显示 inline diff
   */
  private async displayInlineDiff(diffInfo: InlineDiffInfo): Promise<void> {
    const uri = vscode.Uri.file(diffInfo.filepath);
    let editor: vscode.TextEditor | undefined;

    // 尝试获取已打开的编辑器
    const visibleEditors = vscode.window.visibleTextEditors;
    const existingEditor = visibleEditors.find(e => e.document.uri.fsPath === diffInfo.filepath);

    if (existingEditor) {
      editor = existingEditor;
    } else {
      // 打开文件
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, { preview: false });
    }

    if (!editor) {
      return;
    }

    // 应用 WorkspaceEdit 以支持 Ctrl+Z 撤销
    await this.applyDiffWithUndoSupport(editor, diffInfo);

    // 应用装饰（红绿高亮）
    this.applyDecorations(editor, diffInfo);
  }

  /**
   * 使用 WorkspaceEdit 应用 diff，支持 Ctrl+Z 撤销
   */
  private async applyDiffWithUndoSupport(
    editor: vscode.TextEditor,
    diffInfo: InlineDiffInfo
  ): Promise<void> {
    const document = editor.document;
    const fullRange = new vscode.Range(
      document.lineAt(0).range.start,
      document.lineAt(document.lineCount - 1).range.end
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, fullRange, diffInfo.modifiedContent);

    // 使用 undoStopBefore/After 让用户可以 Ctrl+Z 撤销
    await editor.edit(editBuilder => {
      editBuilder.replace(fullRange, diffInfo.modifiedContent);
    }, { undoStopBefore: true, undoStopAfter: true });
  }

  /**
   * 应用红绿装饰
   */
  private applyDecorations(editor: vscode.TextEditor, diffInfo: InlineDiffInfo): void {
    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    for (const range of diffInfo.diffRanges) {
      const vscodeRange = new vscode.Range(
        range.startLine,
        0,
        range.endLine,
        0
      );

      if (range.type === 'added') {
        addedRanges.push(vscodeRange);
      } else if (range.type === 'removed') {
        removedRanges.push(vscodeRange);
      }
    }

    editor.setDecorations(ADDED_LINE_DECORATION, addedRanges);
    editor.setDecorations(REMOVED_LINE_DECORATION, removedRanges);
  }

  /**
   * 接受 diff 修改
   */
  async acceptDiff(filepath: string): Promise<void> {
    const diffInfo = this.inlineDiffs.get(filepath);
    if (!diffInfo) {
      return;
    }

    // 直接写入文件（已写入过一次，这里清理装饰即可）
    await this.clearDiff(filepath);
  }

  /**
   * 拒绝 diff 修改，恢复原内容
   */
  async rejectDiff(filepath: string): Promise<void> {
    const diffInfo = this.inlineDiffs.get(filepath);
    if (!diffInfo) {
      return;
    }

    // 恢复原内容
    const uri = vscode.Uri.file(filepath);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(diffInfo.originalContent));

    await this.clearDiff(filepath);
  }

  /**
   * 清除 diff 展示
   */
  private async clearDiff(filepath: string): Promise<void> {
    this.inlineDiffs.delete(filepath);

    // 清除编辑器装饰
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.uri.fsPath === filepath) {
        editor.setDecorations(ADDED_LINE_DECORATION, []);
        editor.setDecorations(REMOVED_LINE_DECORATION, []);
        break;
      }
    }

    // 通知更新
    this._onDiffUpdate?.(filepath, Array.from(this.inlineDiffs.values()));
  }

  /**
   * 获取当前所有 diff 信息
   */
  getAllDiffs(): Map<string, InlineDiffInfo> {
    return new Map(this.inlineDiffs);
  }

  /**
   * 获取某个文件的 diff 信息
   */
  getDiff(filepath: string): InlineDiffInfo | undefined {
    return this.inlineDiffs.get(filepath);
  }

  /**
   * 是否有待处理的 diff
   */
  hasDiff(filepath: string): boolean {
    return this.inlineDiffs.has(filepath);
  }

  /**
   * 获取修改前的文件内容（用于快照）
   */
  getOriginalContent(filepath: string): string | undefined {
    return this.inlineDiffs.get(filepath)?.originalContent;
  }

  /**
   * 获取所有修改过的文件的当前内容（用于保存快照）
   */
  getModifiedFiles(): FileState[] {
    const files: FileState[] = [];
    for (const [filepath, diffInfo] of this.inlineDiffs) {
      files.push({
        filepath,
        content: diffInfo.modifiedContent
      });
    }
    return files;
  }

  /**
   * 清除所有 diff
   */
  clearAllDiffs(): void {
    for (const filepath of this.inlineDiffs.keys()) {
      this.clearDiff(filepath);
    }
  }
}
