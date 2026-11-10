/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * storage.ts - 存储管理器
 * 功能：封装 VSCode 的 workspaceState 和 globalState，提供统一的存储接口
 * 包含：
 *   - 工作区级别存储（每个工作区独立）
 *   - 全局级别存储（跨工作区共享）
 *   - 自动处理工作区路径前缀
*/
import * as vscode from 'vscode';

export class StorageManager {
  private readonly WORKSPACE_PREFIX = 'workspace';
  private readonly GLOBAL_PREFIX = 'global';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async setWorkspaceData<T>(key: string, value: T): Promise<void> {
    const fullKey = this.getWorkspaceKey(key);
    await this.context.workspaceState.update(fullKey, value);
  }

  async getWorkspaceData<T>(key: string): Promise<T | undefined> {
    const fullKey = this.getWorkspaceKey(key);
    return this.context.workspaceState.get<T>(fullKey);
  }

  async removeWorkspaceData(key: string): Promise<void> {
    const fullKey = this.getWorkspaceKey(key);
    await this.context.workspaceState.update(fullKey, undefined);
  }

  async setGlobalData<T>(key: string, value: T): Promise<void> {
    const fullKey = this.getGlobalKey(key);
    await this.context.globalState.update(fullKey, value);
  }

  async getGlobalData<T>(key: string): Promise<T | undefined> {
    const fullKey = this.getGlobalKey(key);
    return this.context.globalState.get<T>(fullKey);
  }

  async removeGlobalData(key: string): Promise<void> {
    const fullKey = this.getGlobalKey(key);
    await this.context.globalState.update(fullKey, undefined);
  }

  private getWorkspaceKey(key: string): string {
    const workspacePath = this.getWorkspacePath();
    return `${this.WORKSPACE_PREFIX}:${workspacePath}:${key}`;
  }

  private getGlobalKey(key: string): string {
    return `${this.GLOBAL_PREFIX}:${key}`;
  }

  private getWorkspacePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return 'no-workspace';
    }
    return folders[0].uri.fsPath;
  }
}
