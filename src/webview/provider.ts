/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * provider.ts - 侧边栏 Webview 提供者
 * 功能：管理 VSCode 侧边栏视图
 * 包含：
 *   - Webview 初始化和内容加载
 *   - 资源路径解析
 *   - 初始数据同步
*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../core/session';
import { SelectionManager } from '../core/selection';
import { DiffManager } from '../core/diff';
import { WebviewProtocol, Message } from './protocol';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiwriter.sidebar';


  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly protocol: WebviewProtocol,
    private readonly sessionManager: SessionManager,
    private readonly selectionManager: SelectionManager,
    _diffManager: DiffManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'html')
      ]
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    this.protocol.setWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: Message) => {
      await this.protocol.handleMessage(message);
    });

    this.syncInitialData();
  }

  private getWebviewContent(webview: vscode.Webview): string {
    // HTML、样式和脚本必须来自同一份构建目录，避免新 HTML 搭配旧脚本。
    const outHtmlPath = path.join(this.context.extensionPath, 'out', 'webview', 'index.html');
    const useBuildOutput = fs.existsSync(outHtmlPath);
    const htmlPath = useBuildOutput
      ? outHtmlPath
      : path.join(this.context.extensionPath, 'src', 'webview', 'html', 'index.html');
    const resourceRoot = useBuildOutput
      ? vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')
      : vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(resourceRoot, 'styles.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(resourceRoot, 'main.js')
    );
    const fileApprovalScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(resourceRoot, 'modules', 'file-approval.js')
    );
    const settingsScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(resourceRoot, 'modules', 'settings.js')
    );

    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(resourceRoot, 'vendor', 'marked.umd.js')
    );

    // 替换资源路径
    htmlContent = htmlContent.replace('./styles.css', stylesUri.toString());
    htmlContent = htmlContent.replace('./main.js', scriptUri.toString());
    htmlContent = htmlContent.replace('./modules/file-approval.js', fileApprovalScriptUri.toString());
    htmlContent = htmlContent.replace('./modules/settings.js', settingsScriptUri.toString());
    htmlContent = htmlContent.replace('./vendor/marked.umd.js', markedUri.toString());
    htmlContent = htmlContent.replaceAll('{{cspSource}}', webview.cspSource);

    return htmlContent;
  }

  private async syncInitialData(): Promise<void> {
    await this.syncSessions();
    await this.syncSelections();
    await this.syncActiveSession();
  }

  async syncSessions(): Promise<void> {
    const sessions = await this.sessionManager.getAllSessionMetadata();
    this.protocol.sendMessage({
      type: 'session/list',
      data: sessions
    });
  }

  async syncSelections(): Promise<void> {
    const selections = await this.selectionManager.getSelections();
    this.protocol.sendMessage({
      type: 'selection/list',
      data: selections
    });
  }

  async syncActiveSession(): Promise<void> {
    const session = await this.sessionManager.getActiveSession();
    this.protocol.sendMessage({
      type: 'session/active',
      data: session
    });
  }
}
