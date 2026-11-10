/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ui.ts - UI 命令管理器
 * 功能：注册和处理所有 VSCode 命令
 * 包含：
 *   - 命令注册（新建会话、收集文本、diff 操作等）
 *   - Webview 协议消息处理
 *   - 协调各管理器之间的交互
*/
import * as vscode from 'vscode';
import { ResearchController } from '../memory/research/controller';
import { SessionManager } from './session';
import { SelectionManager } from './selection';
import { DiffManager } from './diff';
import { WebviewProtocol } from '../webview/protocol';
import { SidebarWebviewProvider } from '../webview/provider';
import { AIManager } from '../ai';
import * as path from 'path';
import { FileApprovalService } from '../features/file-approval';
import { MarkdownOrganizationService } from '../features/markdown-organization';
import { FileApprovalController } from '../presentation/webview/controllers/file-approval-controller';
import {
  ChatController,
  DiffController,
  SessionController,
  SettingsController,
} from '../presentation/webview/controllers';
import {
  analyzeCLongEvalChunking,
  CLongEvalBenchmarkReport,
  evaluateCLongEvalRetrieval,
  evaluateRagRetrieval,
  parseCLongEvalJsonl,
  parseNovelQaEvaluationCases,
  renderCLongEvalMarkdown,
  sampleCLongEvalCases,
  sampleNovelQaCases,
} from '../memory/rag';

export class UICommandManager {
  private _clongEvalRunning = false;
  private _markdownOrganizationRunning = false;
  private readonly fileApprovalController: FileApprovalController;
  private readonly markdownOrganizationService: MarkdownOrganizationService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: SessionManager,
    private readonly selectionManager: SelectionManager,
    private readonly diffManager: DiffManager,
    private readonly protocol: WebviewProtocol,
    private readonly webviewProvider: SidebarWebviewProvider,
    private readonly aiManager: AIManager,
    fileApprovalService: FileApprovalService
  ) {
    this.fileApprovalController = new FileApprovalController(protocol, fileApprovalService);
    this.markdownOrganizationService = new MarkdownOrganizationService(() => aiManager.config);
    this.context.subscriptions.push(this.markdownOrganizationService);
    this.context.subscriptions.push(new ResearchController(() => aiManager.config, protocol));
  }

  registerCommands(): void {
    this.fileApprovalController.register();
    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.newSession', () => this.handleNewSession())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.collectSelectedText', () => this.handleCollectSelectedText())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.collectEntireFile', () => this.handleCollectEntireFile())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.clearSelections', () => this.handleClearSelections())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.acceptDiff', () => this.handleAcceptDiff())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.rejectDiff', () => this.handleRejectDiff())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.showSidebar', () => this.handleShowSidebar())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.addFileToChat', (uri: vscode.Uri) => this.handleAddFileToChat(uri))
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.acceptInlineDiff', (filepath: string) => this.handleAcceptInlineDiff(filepath))
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.rejectInlineDiff', (filepath: string) => this.handleRejectInlineDiff(filepath))
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.buildRagIndex', () => this.handleBuildRagIndex())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.runNovelQaEvaluation', () => this.handleRunNovelQaEvaluation())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.runCLongEvalEvaluation', () => this.handleRunCLongEvalEvaluation())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('aiwriter.organizeMarkdownProject', () => this.handleOrganizeMarkdownProject())
    );

    // 保存 .md/.txt 文件时增量更新 RAG 索引（仅在 RAG 就绪时生效）
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (!/\.(md|txt)$/i.test(doc.fileName)) {
          return;
        }
        try {
          await this.aiManager.rag.scheduleFileUpdate(doc.fileName);
        } catch (error) {
          console.warn('[UI] RAG 增量更新失败:', error);
        }
      })
    );

    this.context.subscriptions.push(
      vscode.workspace.onDidDeleteFiles(async (event) => {
        for (const uri of event.files) {
          try {
            await this.aiManager.rag.removeFile(uri.fsPath);
          } catch (error) {
            console.warn('[UI] RAG 删除索引记录失败:', error);
          }
        }
      })
    );

    this.context.subscriptions.push(
      vscode.workspace.onDidRenameFiles(async (event) => {
        for (const { oldUri, newUri } of event.files) {
          try {
            await this.aiManager.rag.updateFile(newUri.fsPath);
            await this.aiManager.rag.removeFile(oldUri.fsPath);
          } catch (error) {
            console.warn('[UI] RAG 重命名索引更新失败:', error);
          }
        }
      })
    );

    this.registerProtocolHandlers();
  }

  private async handleBuildRagIndex(): Promise<void> {
    const status = this.aiManager.rag.status.status;
    if (status === 'DISABLED') {
      vscode.window.showWarningMessage('RAG 未启用，请先在 AI 配置中启用并保存。');
      return;
    }
    if (status === 'NOT_CONFIGURED') {
      vscode.window.showWarningMessage('RAG 未配置：请设置 Embedding API Key、Base URL，并打开工作区。');
      return;
    }
    if (status === 'BUILDING') {
      vscode.window.showInformationMessage('RAG 索引正在构建中。');
      return;
    }

    let selectedFiles: string[];
    try {
      const candidates = await this.aiManager.rag.indexCandidates();
      if (!candidates.length) { vscode.window.showInformationMessage('当前工作区没有可索引的 Markdown 或 TXT 文件。'); return; }
      const selection = await vscode.window.showQuickPick(candidates, {
        canPickMany: true, title: '选择故事索引文件',
        placeHolder: '勾选需要检索的文件；取消勾选会从索引移除，不修改原文。确认后开始构建。',
      });
      if (selection === undefined) { return; }
      selectedFiles = selection.map(item => item.filepath);
    } catch (error) {
      vscode.window.showErrorMessage(`读取索引文件列表失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '构建 RAG 索引',
        cancellable: false,
      },
      async (progress) => {
        try {
          const result = await this.aiManager.rag.buildIndex((message, current, total) => {
            progress.report({
              message: `${message} (${current}/${total})`,
              increment: total > 0 ? 100 / total : 0,
            });
          }, selectedFiles);
          vscode.window.showInformationMessage(
            `RAG 索引完成：新建/更新 ${result.indexed} 个文件，跳过 ${result.skipped} 个，清理 ${result.removed} 个，共 ${result.chunks} 个新片段。`
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`构建 RAG 索引失败: ${msg}`);
        }
      }
    );
  }

  private async handleOrganizeMarkdownProject(notifyWebview = false): Promise<void> {
    if (this._markdownOrganizationRunning) {
      vscode.window.showInformationMessage('Markdown 整理正在运行，请等待当前任务完成。');
      return;
    }
    this._markdownOrganizationRunning = true;
    if (notifyWebview) {
      this.protocol.sendMessage({
        type: 'organization/status',
        data: { state: 'running', message: '正在选择并分析 Markdown 文件夹…' }
      });
    }
    try {
      const result = await this.markdownOrganizationService.run();
      if (notifyWebview) {
        const messages = {
          completed: '整理完成，结果已写入 AIWriter整理结果。',
          no_changes: '没有可安全整理的文件，请查看输出面板。',
          cancelled: '已取消整理。',
        } as const;
        this.protocol.sendMessage({
          type: 'organization/status',
          data: { state: result, message: messages[result] }
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        vscode.window.showInformationMessage('Markdown 整理已取消。');
        if (notifyWebview) {
          this.protocol.sendMessage({
            type: 'organization/status',
            data: { state: 'cancelled', message: '已取消整理。' }
          });
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UI] Markdown 整理失败:', error);
      vscode.window.showErrorMessage(`Markdown 整理失败: ${message}`);
      if (notifyWebview) {
        this.protocol.sendMessage({
          type: 'organization/status',
          data: { state: 'error', message: `整理失败：${message}` }
        });
      }
    } finally {
      this._markdownOrganizationRunning = false;
    }
  }

  private async handleRunNovelQaEvaluation(): Promise<void> {
    if (!this.aiManager.rag.isReady) {
      vscode.window.showWarningMessage('请先启用 RAG、配置 Embedding，并为当前小说构建索引。');
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'NovelQA 标注文件': ['json'] },
      openLabel: '选择 NovelQA 标注文件',
    });
    if (!selected?.[0]) {
      return;
    }

    let imported;
    try {
      const bytes = await vscode.workspace.fs.readFile(selected[0]);
      const json = JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
      imported = parseNovelQaEvaluationCases(json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`无法读取 NovelQA 标注：${message}`);
      return;
    }
    if (imported.cases.length === 0) {
      vscode.window.showWarningMessage(
        `该文件没有可用于检索评测的 gold evidence（跳过 ${imported.skippedWithoutEvidence} 题）。`+
        '公开 test 输入不含答案/evidence，请使用 Demonstration 或获准的完整标注。'
      );
      return;
    }

    const requested = await vscode.window.showInputBox({
      title: 'NovelQA RAG 评测',
      prompt: `检测到 ${imported.cases.length} 道带 evidence 的题；首次建议运行 50 道分层样本`,
      value: String(Math.min(50, imported.cases.length)),
      validateInput: value => /^\d+$/.test(value) && Number(value) > 0 ? undefined : '请输入大于 0 的整数',
    });
    if (!requested) {
      return;
    }
    const cases = sampleNovelQaCases(imported.cases, Math.min(Number(requested), imported.cases.length));
    const topK = 5;
    const controller = new AbortController();

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `NovelQA RAG 评测（${cases.length} 题，Top-${topK}）`,
      cancellable: true,
    }, async (progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      let completed = 0;
      try {
        const summary = await evaluateRagRetrieval(cases, async query => {
          if (controller.signal.aborted) {
            throw new DOMException('NovelQA evaluation cancelled', 'AbortError');
          }
          const results = await this.aiManager.rag.search({
            selection: query,
            intent: '',
            useHyde: false,
            transformQuery: false,
            topK,
            signal: controller.signal,
          });
          completed++;
          progress.report({
            message: `${completed}/${cases.length}`,
            increment: 100 / cases.length,
          });
          return results;
        }, topK);

        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspace) {
          throw new Error('没有打开工作区');
        }
        const reportFolder = vscode.Uri.joinPath(workspace, '.aiwriter', 'evaluations');
        await vscode.workspace.fs.createDirectory(reportFolder);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportUri = vscode.Uri.joinPath(reportFolder, `novelqa-${timestamp}.json`);
        const report = {
          benchmark: 'NovelQA',
          createdAt: new Date().toISOString(),
          datasetFile: selected[0].fsPath,
          mode: 'raw-query-hybrid-retrieval',
          topK,
          sampledCases: cases.length,
          availableCases: imported.cases.length,
          skippedWithoutEvidence: imported.skippedWithoutEvidence,
          summary,
        };
        await vscode.workspace.fs.writeFile(
          reportUri,
          new TextEncoder().encode(JSON.stringify(report, null, 2))
        );
        const hitRate = (summary.hitRateAtK * 100).toFixed(1);
        const mrr = summary.meanReciprocalRank.toFixed(3);
        vscode.window.showInformationMessage(
          `NovelQA 完成：HitRate@${topK} ${hitRate}%，MRR ${mrr}，失败 ${summary.failures.length}/${summary.cases}`
        );
        await vscode.window.showTextDocument(reportUri, { preview: false });
      } catch (error) {
        if (controller.signal.aborted) {
          vscode.window.showInformationMessage(`NovelQA 评测已停止（完成 ${completed}/${cases.length}）`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`NovelQA 评测失败：${message}`);
      }
    });
  }

  private async handleRunCLongEvalEvaluation(): Promise<void> {
    if (this._clongEvalRunning) {
      vscode.window.showInformationMessage('CLongEval 评测已经在运行。');
      return;
    }
    const ragStatus = this.aiManager.rag.status.status;
    if (ragStatus === 'DISABLED' || ragStatus === 'NOT_CONFIGURED') {
      vscode.window.showWarningMessage('请先启用 RAG，并配置独立的 Embedding API Key、Base URL 和模型。');
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'CLongEval JSONL': ['jsonl'] },
      openLabel: '选择 small / medium / large.jsonl',
    });
    if (!selected?.[0]) {
      return;
    }

    let dataset;
    try {
      const bytes = await vscode.workspace.fs.readFile(selected[0]);
      dataset = parseCLongEvalJsonl(new TextDecoder('utf-8').decode(bytes), selected[0].fsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`无法读取 CLongEval：${message}`);
      return;
    }
    if (dataset.cases.length === 0) {
      vscode.window.showWarningMessage(
        `没有找到可评测记录。无效行 ${dataset.invalidLines}，缺少 refered_chunk ${dataset.skippedWithoutEvidence}。`
      );
      return;
    }

    const requested = await vscode.window.showInputBox({
      title: 'CLongEval 中文小说 RAG 评测',
      prompt: `检测到 ${dataset.cases.length} 题、${dataset.documents.length} 个去重故事；small 首轮建议运行全部`,
      value: String(dataset.cases.length),
      validateInput: value => /^\d+$/.test(value) && Number(value) > 0 ? undefined : '请输入大于 0 的整数',
    });
    if (!requested) {
      return;
    }
    const cases = sampleCLongEvalCases(dataset.cases, Math.min(Number(requested), dataset.cases.length));
    const configuration = this.aiManager.rag.benchmarkConfiguration;
    const topK = 5;
    const controller = new AbortController();
    const chunking = analyzeCLongEvalChunking(dataset, cases, {
      chunkSize: configuration.chunkSize,
      chunkOverlap: configuration.chunkOverlap,
    });

    this._clongEvalRunning = true;
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CLongEval ${dataset.split}（${cases.length} 题，Top-${topK}）`,
        cancellable: true,
      }, async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        try {
        const retrieval = await evaluateCLongEvalRetrieval(
          dataset,
          cases,
          async (document, item) => this.aiManager.rag.benchmarkSearchDocument(
            document.id,
            document.content,
            item.query,
            {
              topK,
              signal: controller.signal,
              onIndexProgress: (done, total) => progress.report({
                message: `正在索引故事 ${document.id}（${done}/${total} chunks）`,
              }),
            }
          ),
          topK,
          (completed, total) => progress.report({
            message: `正在评测 ${completed}/${total}`,
            increment: total > 0 ? 100 / total : 0,
          })
        );

        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspace) {
          throw new Error('没有打开工作区');
        }
        const report: CLongEvalBenchmarkReport = {
          benchmark: 'CLongEval-long_story_qa',
          createdAt: new Date().toISOString(),
          dataset: {
            sourceFile: path.basename(selected[0].fsPath),
            sourceHash: dataset.sourceHash,
            split: dataset.split,
            documents: dataset.documents.length,
            availableCases: dataset.cases.length,
            sampledCases: cases.length,
            invalidLines: dataset.invalidLines,
            skippedWithoutEvidence: dataset.skippedWithoutEvidence,
          },
          configuration: {
            ...configuration,
            retrieval: 'hybrid-rrf',
            topK,
            queryTransformation: false,
            hyde: false,
          },
          chunking,
          retrieval,
        };
        const reportFolder = vscode.Uri.joinPath(workspace, '.aiwriter', 'evaluations');
        await vscode.workspace.fs.createDirectory(reportFolder);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonUri = vscode.Uri.joinPath(reportFolder, `clongeval-${dataset.split}-${timestamp}.json`);
        const markdownUri = vscode.Uri.joinPath(reportFolder, `clongeval-${dataset.split}-${timestamp}.md`);
        await Promise.all([
          vscode.workspace.fs.writeFile(jsonUri, new TextEncoder().encode(JSON.stringify(report, null, 2))),
          vscode.workspace.fs.writeFile(markdownUri, new TextEncoder().encode(renderCLongEvalMarkdown(report))),
        ]);
        vscode.window.showInformationMessage(
          `CLongEval 完成：HitRate@${topK} ${(retrieval.hitRateAtK * 100).toFixed(1)}%，`+
          `MRR ${retrieval.meanReciprocalRank.toFixed(3)}，失败 ${retrieval.failures.length}/${retrieval.evaluatedCases}`
        );
        await vscode.window.showTextDocument(markdownUri, { preview: false });
        } catch (error) {
          if (controller.signal.aborted) {
            vscode.window.showInformationMessage('CLongEval 评测已停止；已生成的隔离索引缓存将在下次复用。');
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`CLongEval 评测失败：${message}`);
        }
      });
    } finally {
      this._clongEvalRunning = false;
    }
  }

  private registerProtocolHandlers(): void {
    new SessionController(
      this.sessionManager,
      this.selectionManager,
      this.protocol,
      this.webviewProvider
    ).register();
    new DiffController(this.diffManager, this.protocol).register();
    new SettingsController(
      this.aiManager,
      this.protocol,
      () => this.handleBuildRagIndex()
    ).register();
    new ChatController(
      this.sessionManager,
      this.selectionManager,
      this.diffManager,
      this.protocol,
      this.webviewProvider,
      this.aiManager
    ).register();

    this.protocol.onMessage('init', async () => {
      await this.webviewProvider.syncSessions();
      await this.webviewProvider.syncActiveSession();
      this.fileApprovalController.resendPending();
    });

    this.protocol.onMessage('organization/start', async () => {
      await this.handleOrganizeMarkdownProject(true);
    });

  }

  private async handleNewSession(): Promise<void> {
    const title = await vscode.window.showInputBox({
      prompt: '输入会话标题',
      placeHolder: '留空使用默认标题'
    });

    const session = await this.sessionManager.createSession(title);
    await this.sessionManager.setActiveSession(session.sessionId);
    await this.webviewProvider.syncSessions();
    await this.webviewProvider.syncActiveSession();

    this.protocol.sendMessage({
      type: 'session/created',
      data: session
    });

    vscode.window.showInformationMessage('会话 "' + session.title + '" 已创建');
  }

  private async handleCollectSelectedText(): Promise<void> {
    try {
      const selection = await this.selectionManager.collectHighlightedCode();
      await this.selectionManager.addSelection(selection);
      this.webviewProvider.syncSelections();

      this.protocol.sendMessage({
        type: 'selection/added',
        data: selection
      });

      vscode.window.showInformationMessage('已收集文本: ' + selection.displayName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage('收集选中文本失败: ' + message);
    }
  }

  private async handleCollectEntireFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('没有打开的文件');
      return;
    }

    try {
      const selection = await this.selectionManager.collectEntireFile(editor.document.uri);
      await this.selectionManager.addSelection(selection);
      this.webviewProvider.syncSelections();

      this.protocol.sendMessage({
        type: 'selection/added',
        data: selection
      });

      vscode.window.showInformationMessage('已收集文件: ' + selection.displayName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage('收集文件失败: ' + message);
    }
  }

  private async handleClearSelections(): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      '确定要清空所有收集的文本吗?',
      { modal: true }
    );

    if (result === '确定') {
      await this.selectionManager.clearSelections();
      this.webviewProvider.syncSelections();

      this.protocol.sendMessage({
        type: 'selection/cleared',
        data: undefined
      });

      vscode.window.showInformationMessage('已清空所有收集的文本');
    }
  }

  private async handleAcceptDiff(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('没有打开的文件');
      return;
    }

    const filepath = editor.document.uri.fsPath;
    if (!this.diffManager.hasDiff(filepath)) {
      vscode.window.showWarningMessage('没有待处理的差异');
      return;
    }

    await this.diffManager.acceptDiff(filepath);
    vscode.window.showInformationMessage('已接受差异');
  }

  private async handleRejectDiff(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('没有打开的文件');
      return;
    }

    const filepath = editor.document.uri.fsPath;
    if (!this.diffManager.hasDiff(filepath)) {
      vscode.window.showWarningMessage('没有待处理的差异');
      return;
    }

    await this.diffManager.rejectDiff(filepath);
    vscode.window.showInformationMessage('已拒绝差异');
  }

  private async handleAcceptInlineDiff(filepath: string): Promise<void> {
    await this.diffManager.acceptDiff(filepath);
  }

  private async handleRejectInlineDiff(filepath: string): Promise<void> {
    await this.diffManager.rejectDiff(filepath);
  }

  private handleShowSidebar(): void {
    vscode.commands.executeCommand('aiwriter.sidebar.focus');
  }

  private async handleAddFileToChat(uri: vscode.Uri): Promise<void> {
    try {
      const selection = await this.selectionManager.collectEntireFile(uri);
      await this.selectionManager.addSelection(selection);
      this.webviewProvider.syncSelections();

      this.protocol.sendMessage({
        type: 'selection/added',
        data: selection
      });

      vscode.window.showInformationMessage('已添加文件到对话: ' + selection.displayName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage('添加文件失败: ' + message);
    }
  }
}
