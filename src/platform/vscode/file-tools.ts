import { searchWindows, utf8Prefix, SEARCH_MAX_BYTES } from '../../ai/tools/search-context';
import { stableHash } from '../../memory/rag/chunker';
import { readDocumentText } from './text-content';
import { selectSearchCandidates } from './ripgrep-search';
/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/file-tools.ts - 文件操作工具
 * 功能：提供文件读写、创建、编辑等操作
 * 包含：
 *   - 读取/写入文件
 *   - 创建文件/目录
 *   - 列出目录内容
 *   - 搜索文件和内容
 *   - 搜索替换
*/
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { FileOperationResult, IFileSystem, SearchResult, SearchMatch } from '../../types';

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export class FileTools implements IFileSystem {
  constructor(_context: vscode.ExtensionContext) {}

  private _isWithin(root: string, candidate: string): boolean {
    return isPathWithinRoot(root, candidate);
  }

  private async _resolveSafePath(inputPath: string): Promise<string> {
    if (!inputPath || !inputPath.trim()) {
      throw new Error('文件路径不能为空');
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('未打开工作区，拒绝文件操作');
    }

    const roots = workspaceFolders.map(folder => path.resolve(folder.uri.fsPath));
    const candidates = path.isAbsolute(inputPath)
      ? [path.resolve(inputPath)]
      : roots.map(root => path.resolve(root, inputPath));

    for (const candidate of candidates) {
      const lexicalRoot = roots.find(root => this._isWithin(root, candidate));
      if (!lexicalRoot) {
        continue;
      }

      const realRoot = await fs.realpath(lexicalRoot);
      let existingAncestor = candidate;
      while (true) {
        try {
          await fs.access(existingAncestor);
          break;
        } catch {
          const parent = path.dirname(existingAncestor);
          if (parent === existingAncestor) {
            throw new Error('无法验证文件路径');
          }
          existingAncestor = parent;
        }
      }

      const realAncestor = await fs.realpath(existingAncestor);
      if (!this._isWithin(realRoot, realAncestor)) {
        throw new Error('文件路径通过符号链接指向工作区外，已拒绝操作');
      }
      return candidate;
    }

    throw new Error('文件路径不在当前工作区内，已拒绝操作');
  }

  async validatePath(filepath: string): Promise<FileOperationResult> {
    try {
      const safePath = await this._resolveSafePath(filepath);
      return { success: true, message: '路径验证通过', content: safePath };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async readFile(filepath: string): Promise<FileOperationResult> {
    try {
      if (!filepath) {
        return { success: false, message: '文件路径不能为空' };
      }
      filepath = await this._resolveSafePath(filepath);
      const uri = vscode.Uri.file(filepath);
      const text = await readDocumentText(uri);
      return {
        success: true,
        message: `成功读取文件: ${filepath}`,
        content: text, filepath, version: stableHash(text)
      };
    } catch (error) {
      return {
        success: false,
        message: `读取文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async writeFile(filepath: string, content: string): Promise<FileOperationResult> {
    try {
      filepath = await this._resolveSafePath(filepath);
      const uri = vscode.Uri.file(filepath);
      const encoder = new TextEncoder();

      // 递归创建父目录
      const dirPath = filepath.replace(/[/\\][^/\\]+$/, '');
      if (dirPath) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch {
          // 目录可能已存在，忽略
        }
      }

      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
      return {
        success: true,
        message: `成功写入文件: ${filepath}`
      };
    } catch (error) {
      return {
        success: false,
        message: `写入文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async fileExists(filepath: string): Promise<boolean> {
    try {
      filepath = await this._resolveSafePath(filepath);
      const uri = vscode.Uri.file(filepath);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async createFile(filepath: string, content: string): Promise<FileOperationResult> {
    try {
      if (!filepath) {
        return { success: false, message: '文件路径不能为空' };
      }
      filepath = await this._resolveSafePath(filepath);
      const uri = vscode.Uri.file(filepath);

      // 递归创建父目录
      const dirPath = filepath.replace(/[/\\][^/\\]+$/, '');
      if (dirPath) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch {
          // 目录可能已存在，忽略
        }
      }

      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));

      return {
        success: true,
        message: `成功创建文件: ${filepath}`
      };
    } catch (error) {
      return {
        success: false,
        message: `创建文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async editFile(filepath: string, newContent: string): Promise<FileOperationResult> {
    try {
      if (!filepath) {
        return { success: false, message: '文件路径不能为空' };
      }
      filepath = await this._resolveSafePath(filepath);
      const uri = vscode.Uri.file(filepath);
      const encoder = new TextEncoder();

      // 递归创建父目录
      const dirPath = filepath.replace(/[/\\][^/\\]+$/, '');
      if (dirPath) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch {
          // 目录可能已存在，忽略
        }
      }

      await vscode.workspace.fs.writeFile(uri, encoder.encode(newContent));

      const exists = await this.fileExists(filepath);
      if (exists) {
        return {
          success: true,
          message: `成功修改文件: ${filepath}`
        };
      } else {
        return {
          success: true,
          message: `成功创建文件: ${filepath}`
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `操作文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async deleteFile(filepath: string): Promise<FileOperationResult> {
    try {
      filepath = await this._resolveSafePath(filepath);
      await vscode.workspace.fs.delete(vscode.Uri.file(filepath), { recursive: false, useTrash: false });
      return { success: true, message: `成功删除文件: ${filepath}` };
    } catch (error) {
      return {
        success: false,
        message: `删除文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async listFiles(directory: string): Promise<FileOperationResult> {
    try {
      if (!directory) {
        return { success: false, message: '目录路径不能为空' };
      }
      directory = await this._resolveSafePath(directory);
      const uri = vscode.Uri.file(directory);
      const files = await vscode.workspace.fs.readDirectory(uri);
      const fileList = files
        .map(([name, type]) => {
          const typeStr = type === vscode.FileType.Directory ? '[DIR]' : '[FILE]';
          return `${typeStr} ${name}`;
        })
        .join('\n');

      return {
        success: true,
        message: `成功列出目录: ${directory}`,
        content: fileList
      };
    } catch (error) {
      return {
        success: false,
        message: `列出目录失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async searchFiles(baseDirectory: string, pattern: string): Promise<FileOperationResult> {
    try {
      if (!baseDirectory) {
        return { success: false, message: '基础目录路径不能为空' };
      }
      if (!pattern) {
        return { success: false, message: '搜索模式不能为空' };
      }

      baseDirectory = await this._resolveSafePath(baseDirectory);
      const relativePattern = new vscode.RelativePattern(baseDirectory, pattern);
      const files = await vscode.workspace.findFiles(relativePattern, null, 100);

      const fileList = files.map(uri => uri.fsPath).join('\n');

      return {
        success: true,
        message: `找到 ${files.length} 个匹配文件`,
        content: fileList || '未找到匹配的文件'
      };
    } catch (error) {
      return {
        success: false,
        message: `搜索文件失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async searchInFiles(baseDirectory: string, searchText: string, filePattern?: string, contextLines = 0): Promise<SearchResult> {
    try {
      if (!searchText) {
        return { success: false, message: '搜索文本不能为空' };
      }

      baseDirectory = await this._resolveSafePath(baseDirectory);
      const matches: SearchMatch[] = [];
      let remainingBytes = SEARCH_MAX_BYTES - 1024;
      let truncated = false;
      if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
        return { success: false, message: 'contextLines 必须是非负整数' };
      }


      const searchPattern = filePattern || '**/*';
      const relativePattern = new vscode.RelativePattern(baseDirectory, searchPattern);
      const discovered = await vscode.workspace.findFiles(relativePattern, '**/{node_modules,.git,.aiwriter,out}/**', 51);
      const scopeLimited = discovered.length > 50;
      const files = discovered.slice(0, 50);
      const searchStarted = performance.now();
      let backend = 'direct';
      let selectedPaths: Set<string> | undefined;

      for (const [index, uri] of files.entries()) {
        // Frequent queries often fill the result budget immediately: do not start a process in that case.
        if (index === 2 && matches.length === 0) {
          const selected = await selectSearchCandidates(files.slice(index).map(file => file.fsPath), searchText,
            new Set((vscode.workspace.textDocuments || []).map(document => document.uri.fsPath)));
          selectedPaths = new Set(selected.files);
          backend = selected.backend;
        }
        if (selectedPaths && !selectedPaths.has(uri.fsPath)) { continue; }
        try {
          const content = await readDocumentText(uri);
          if (!content.includes(searchText)) { continue; }
          const version = stableHash(content);
          for (const window of searchWindows(content, searchText, contextLines)) {
            let start = window.start;
            let source = content.slice(start, window.end);
            const headerBytes = Buffer.byteLength(`${uri.fsPath}:${window.line}:${window.column} - \n`, 'utf8');
            let text = utf8Prefix(source, Math.max(0, remainingBytes - headerBytes));
            // A long paragraph or large before-context must not hide the hit itself.
            const hit = source.indexOf(searchText);
            if (text.length < hit + searchText.length && remainingBytes > headerBytes) {
              start += hit;
              source = content.slice(start, window.end);
              text = utf8Prefix(source, Math.max(0, remainingBytes - headerBytes));
              truncated = true;
            }
            if (text) {
              matches.push({ filepath: uri.fsPath, line: window.line, column: window.column,
                text, charStart: start, charEnd: start + text.length, version });
              remainingBytes -= headerBytes + Buffer.byteLength(text, 'utf8');
            }
            if (text.length < source.length) { truncated = true; break; }
          }
          if (truncated) { break; }
        } catch (error) {
          // Never present decoding failures in story files as "no matches".
          if (/\.(md|txt)$/i.test(uri.fsPath)) {
            throw new Error(`${path.basename(uri.fsPath)}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      truncated ||= scopeLimited;
      console.info(`[Search] backend=${backend} files=${files.length} searchMs=${(performance.now() - searchStarted).toFixed(1)}`);
      if (matches.length === 0) {
        return {
          success: true,
          message: scopeLimited ? '仅搜索前 50 个文件，尚未覆盖全部范围，请指定目录或文件名继续搜索。' : truncated ? '结果超过大小上限，请缩小范围。' : `未找到包含 "${searchText}" 的文件`,
          truncated
        };
      }

      const resultText = matches
        .map(m => `${m.filepath}:${m.line}:${m.column} - ${m.text}`)
        .join('\n');

      return {
        success: true,
        message: `找到 ${matches.length} 处匹配${scopeLimited ? '（仅搜索前 50 个文件，请缩小范围继续搜索）' : ''}`,
        matches,
        truncated,
        content: resultText
      } as SearchResult & { content?: string };
    } catch (error) {
      return {
        success: false,
        message: `搜索内容失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async searchAndReplace(filepath: string, oldString: string, newString: string, replaceAll: boolean = false): Promise<FileOperationResult> {
    try {
      if (!filepath) {
        return { success: false, message: '文件路径不能为空' };
      }
      if (!oldString) {
        return { success: false, message: '被替换的文本不能为空' };
      }

      filepath = await this._resolveSafePath(filepath);
      const readResult = await this.readFile(filepath);
      if (!readResult.success) {
        return readResult;
      }

      const originalContent = readResult.content || '';
      let newContent: string;

      if (replaceAll) {
        newContent = originalContent.split(oldString).join(newString);
      } else {
        newContent = originalContent.replace(oldString, newString);
      }

      if (newContent === originalContent) {
        return {
          success: false,
          message: `未在 ${filepath} 中找到匹配的文本`
        };
      }

      const writeResult = await this.writeFile(filepath, newContent);
      if (writeResult.success) {
        return {
          success: true,
          message: `已在 ${filepath} 中替换文本`
        };
      }

      return writeResult;
    } catch (error) {
      return {
        success: false,
        message: `搜索替换失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}
