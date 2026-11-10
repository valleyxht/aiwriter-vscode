/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * selection.ts - 选中文本管理器
 * 功能：收集、存储和管理编辑器中的选中文本
 * 包含：
 *   - 收集高亮文本
 *   - 收集整个文件
 *   - 管理收集的文本列表
 *   - 工作区隔离存储
*/
import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { CollectedText } from '../types';
import { StorageManager } from './storage';

export class SelectionManager {
  private readonly SELECTIONS_KEY = 'aiwriter.selections';
  private selections: CollectedText[] = [];

  constructor(
    _context: vscode.ExtensionContext,
    private readonly storage: StorageManager
  ) {}

  async initialize(): Promise<void> {
    await this.loadSelections();
  }

  async collectHighlightedCode(): Promise<CollectedText> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No active editor');
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      throw new Error('No text selected');
    }

    const filepath = editor.document.uri.toString();
    const contents = editor.document.getText(selection);
    const displayName = path.basename(editor.document.uri.fsPath);

    const collectedText: CollectedText = {
      id: randomUUID(),
      filepath,
      range: {
        start: {
          line: selection.start.line,
          character: selection.start.character
        },
        end: {
          line: selection.end.line,
          character: selection.end.character
        }
      },
      contents,
      displayName,
      timestamp: new Date().toISOString()
    };

    return collectedText;
  }

  async collectEntireFile(uri: vscode.Uri): Promise<CollectedText> {
    const stat = await vscode.workspace.fs.stat(uri);

    if (stat.type === vscode.FileType.Directory) {
      const files = await vscode.workspace.fs.readDirectory(uri);
      const results: CollectedText[] = [];

      for (const [filename, type] of files) {
        if (type === vscode.FileType.File) {
          const fileUri = vscode.Uri.joinPath(uri, filename);
          const result = await this.collectEntireFile(fileUri);
          results.push(result);
        }
      }

      return results[0];
    }

    const content = await vscode.workspace.fs.readFile(uri);
    const contents = new TextDecoder('utf-8').decode(content);
    const lines = contents.split('\n');
    const filepath = uri.toString();
    const displayName = path.basename(uri.fsPath);

    return {
      id: randomUUID(),
      filepath,
      range: {
        start: { line: 0, character: 0 },
        end: { line: Math.max(0, lines.length - 1), character: 0 }
      },
      contents,
      displayName,
      timestamp: new Date().toISOString()
    };
  }

  async addSelection(selection: CollectedText): Promise<void> {
    const config = vscode.workspace.getConfiguration('aiwriter');
    const maxSelections = config.get<number>('maxSelections', 10);

    if (this.selections.length >= maxSelections) {
      throw new Error(`Maximum number of selections (${maxSelections}) reached`);
    }

    this.selections.push(selection);
    await this.saveSelections();
  }

  async removeSelection(id: string): Promise<void> {
    const index = this.selections.findIndex(s => s.id === id);
    if (index >= 0) {
      this.selections.splice(index, 1);
      await this.saveSelections();
    }
  }

  async clearSelections(): Promise<void> {
    this.selections = [];
    await this.saveSelections();
  }

  async getSelections(): Promise<CollectedText[]> {
    return [...this.selections];
  }

  async getSelection(id: string): Promise<CollectedText | null> {
    return this.selections.find(s => s.id === id) || null;
  }

  private async loadSelections(): Promise<void> {
    this.selections = await this.storage.getWorkspaceData<CollectedText[]>(this.SELECTIONS_KEY) || [];
  }

  private async saveSelections(): Promise<void> {
    await this.storage.setWorkspaceData(this.SELECTIONS_KEY, this.selections);
  }

}
