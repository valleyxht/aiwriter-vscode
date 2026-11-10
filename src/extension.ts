/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * extension.ts - 插件入口文件
 * 功能：插件的激活和停用逻辑，初始化所有核心管理器
 * 包含：
 *   - StorageManager: 本地存储管理
 *   - SessionManager: 会话管理
 *   - SelectionManager: 选中文本管理
 *   - DiffManager: 文件差异对比
 *   - UICommandManager: UI 命令注册
 *   - AIManager: AI 功能管理
*/
import * as vscode from 'vscode';
import { StorageManager } from './core/storage';
import { SessionManager } from './core/session';
import { SelectionManager } from './core/selection';
import { DiffManager } from './core/diff';
import { UICommandManager } from './core/ui';
import { WebviewProtocol } from './webview/protocol';
import { SidebarWebviewProvider } from './webview/provider';
import { AIManager } from './ai';
import { FileApprovalService } from './features/file-approval';

let activeAIManager: AIManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('AI Writer 插件已激活');

  const storage = new StorageManager(context);
  const sessionManager = new SessionManager(context, storage);
  const selectionManager = new SelectionManager(context, storage);
  const diffManager = new DiffManager(context);
  const fileApprovalService = new FileApprovalService();
  const protocol = new WebviewProtocol(context);
  const aiManager = new AIManager(context, fileApprovalService);
  activeAIManager = aiManager;

  await Promise.all([
    sessionManager.initialize(),
    selectionManager.initialize(),
    aiManager.initialize()
  ]);

  // 设置 protocol 用于发送 token 统计到前端
  aiManager.setProtocol(protocol);
  console.log('[extension] AIManager protocol set for token stats');

  // 设置 DiffManager 的回调，在 diff 状态变化时通知 webview
  diffManager.setOnDiffUpdateCallback((filepath, diffs) => {
    protocol.sendMessage({
      type: 'diff/pending',
      data: { filepath, diffs }
    });
  });

  const webviewProvider = new SidebarWebviewProvider(
    context,
    protocol,
    sessionManager,
    selectionManager,
    diffManager
  );

  const uiCommandManager = new UICommandManager(
    context,
    sessionManager,
    selectionManager,
    diffManager,
    protocol,
    webviewProvider,
    aiManager,
    fileApprovalService
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarWebviewProvider.viewType,
      webviewProvider
    )
  );

  uiCommandManager.registerCommands();

  console.log('AI Writer 所有功能已注册');
  console.log('AI 管理器已初始化');
}

export async function deactivate() {
  await activeAIManager?.dispose();
  activeAIManager = undefined;
  console.log('AI Writer 插件已停用');
}

export { AIManager } from './ai';
