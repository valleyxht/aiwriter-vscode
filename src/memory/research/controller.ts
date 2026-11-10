import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIConfig } from '../../types';
import { readDocumentText } from '../../platform/vscode/text-content';
import { WebviewProtocol } from '../../webview/protocol';
import { DEFAULT_IGNORE, IGNORE_FILE, ResearchCatalogStore } from './catalog';
import { createSummaryCall, generateSummaries, logSummary, GenerationProgress } from './summarizer';

/** Serializes disk updates and generation per workspace; watchers never invoke a model. */
export class ResearchController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly changedPaths = new Map<string, Set<string>>();
  private active?: AbortController;
  private disposed = false;

  constructor(private readonly config: () => AIConfig, private readonly protocol: WebviewProtocol) {
    this.disposables.push(vscode.commands.registerCommand('aiwriter.researchCatalog', () => this.open()));
    protocol.onMessage('research/action', async ({ action }: { action: string }) => this.open(action));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || folder.uri.scheme !== 'file') { return; }
      const relative = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
      if (/(^|\/)(\.git|node_modules)(\/|$)/.test(relative)
        || (relative.startsWith('.aiwriter/') && !relative.startsWith('.aiwriter/research/summaries/'))) { return; }
      const changed = this.changedPaths.get(folder.uri.fsPath) || new Set<string>();
      changed.add(relative);
      this.changedPaths.set(folder.uri.fsPath, changed);
      this.schedule(folder.uri.fsPath);
    };
    this.disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
      vscode.workspace.onDidSaveTextDocument(doc => changed(doc.uri)),
      vscode.workspace.onDidRenameFiles(event => event.files.forEach(file => { changed(file.oldUri); changed(file.newUri); })),
      vscode.workspace.onDidDeleteFiles(event => event.files.forEach(changed)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.initialize()));
    this.initialize();
  }

  private initialize(): void {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme === 'file') { this.schedule(folder.uri.fsPath); }
    }
  }

  private store(root: string): ResearchCatalogStore {
    return new ResearchCatalogStore(root, absolute => readDocumentText(vscode.Uri.file(absolute), true), absolute => {
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === absolute);
      return document ? { version: document.version, dirty: document.isDirty } : undefined;
    });
  }

  private enqueue<T>(root: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(root) || Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(root, pending);
    return pending;
  }

  private schedule(root: string): void {
    if (this.disposed) { return; }
    clearTimeout(this.timers.get(root));
    this.timers.set(root, setTimeout(() => {
      this.timers.delete(root);
      void this.enqueue(root, async () => {
        if (this.disposed) { return; }
        const store = this.store(root);
        try { await fs.access(store.catalogPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
          try { await fs.access(path.join(store.directory, 'summaries')); }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw missing; }
        }
        const catalog = await store.load();
        const changedPaths = this.changedPaths.get(root);
        this.changedPaths.delete(root);
        await store.scan(catalog, undefined, { changedPaths });
        this.status();
      }).catch(error => {
        console.error('[ResearchCatalog] 同步失败', error);
        this.message(`资料目录同步失败：${String(error)}`);
      });
    }, 700));
  }

  private message(message: string): void { this.protocol.sendMessage({ type: 'research/status', data: { message } }); }

  private status(): void {
    this.message('摘要保存在 .aiwriter/research/summaries，可直接编辑；生成时默认补齐缺失摘要。');
  }

  async open(action?: string): Promise<void> {
    if (action === 'cancel') { this.active?.abort(); return; }
    try {
      const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder || folder.uri.scheme !== 'file') { return; }
      action ??= 'update';
      if (!['update', 'ignore'].includes(action)) { return; }
      const root = folder.uri.fsPath;
      const ignorePath = path.join(root, IGNORE_FILE);
      try { await fs.writeFile(ignorePath, DEFAULT_IGNORE, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
      if (action === 'ignore') {
        await vscode.window.showTextDocument(vscode.Uri.file(ignorePath));
        return;
      }
      if (this.active) { vscode.window.showInformationMessage('摘要任务正在运行，可在进度通知中取消。'); return; }
      const store = this.store(root);
      const controller = new AbortController();
      this.active = controller;
      const runId = randomUUID();
      const started = Date.now();
      logSummary('task.start', { runId, action });
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '生成资料目录与章节摘要', cancellable: true }, async (ui, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            await this.enqueue(root, async () => {
              const catalog = await store.load();
              await store.scan(catalog, controller.signal);
              const mode = await vscode.window.showQuickPick([
                { label: '补齐缺失摘要', mode: 'missing', description: '保留所有已有摘要，包括作者手写内容', picked: true },
                { label: '选择章节生成 / 更新', mode: 'selected', description: '自行选择章节；已有摘要将被覆盖' },
              ], { title: '生成 / 更新摘要' });
              if (!mode || controller.signal.aborted) { return; }
              let sectionIds: Set<string> | undefined;
              if (mode.mode === 'selected') {
                const picked = await vscode.window.showQuickPick(catalog.files.filter(file => !file.error)
                  .flatMap(file => file.sections.map(section => ({ label: section.title,
                    description: `${file.path} · ${section.summary ? '已有摘要，将覆盖' : '无摘要'}`, id: section.id }))),
                { title: '选择要生成 / 更新的章节（已有摘要将被覆盖）', canPickMany: true });
                if (!picked?.length || controller.signal.aborted) { return; }
                sectionIds = new Set(picked.map(item => item.id));
              }
              const count = catalog.files.filter(file => !file.error).flatMap(file => file.sections)
                .filter(section => sectionIds ? sectionIds.has(section.id) : !section.summary).length;
              if (!count) { this.message('没有缺失的章节摘要；可选择章节更新已有摘要。'); return; }
              const progress: GenerationProgress = { runId, completed: 0, total: 0, failed: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0, message: '' };
              const config = this.config();
              // Reserve room for instructions and output; conservative character budget for mixed encodings.
              const maxChars = Math.min(12000, Math.floor((config.contextWindowSize * 1000 - 4096) / 3));
              if (maxChars < 1000) { throw new Error('模型上下文窗口过小，请检查配置'); }
              const call = createSummaryCall(config, progress, maxChars);
              const report = () => {
                const message = `${progress.completed}/${progress.total} · ${progress.message} · 已知 Token ${progress.inputTokens + progress.outputTokens}${progress.missingUsage ? `（${progress.missingUsage} 次未返回用量）` : ''}`;
                ui.report({ message }); this.message(message);
              };
              try {
                await generateSummaries(store, catalog, call, { sectionIds, maxChars, signal: controller.signal, progress, report });
              } finally {
                // Catch source changes during calls, including deletion, ignore edits and failed generation.
                await store.scan(catalog);
                this.status();
              }
              const failed = progress.failed + catalog.files.filter(file => file.error).length;
              logSummary('task.complete', { runId, elapsedMs: Date.now() - started,
                total: progress.total, succeeded: progress.completed - progress.failed, failed,
                inputTokens: progress.inputTokens, outputTokens: progress.outputTokens, missingUsage: progress.missingUsage });
              const message = `摘要处理完成：${progress.completed - progress.failed} 项成功，${failed} 项失败。已知 Token：${progress.inputTokens + progress.outputTokens}${progress.missingUsage ? `；${progress.missingUsage} 次用量未返回` : ''}。`;
              this.message(message);
              if (failed) { vscode.window.showWarningMessage(message); }
              else { vscode.window.showInformationMessage(message); }
            });
          } finally { subscription.dispose(); }
        });
      } catch (error) {
        logSummary(controller.signal.aborted ? 'task.cancelled' : 'task.failed',
          { runId, elapsedMs: Date.now() - started }, 'warn');
        if (controller.signal.aborted) { throw new DOMException('已取消', 'AbortError'); }
        throw error;
      } finally { this.active = undefined; }
    } catch (error) {
      if ((error as Error).name === 'AbortError') { this.message('已取消；完成的摘要已保存，下次更新将继续处理剩余内容。'); }
      else {
        console.error('[ResearchCatalog]', error);
        this.message(`摘要处理失败：${String(error)}`);
        vscode.window.showErrorMessage(`摘要处理失败：${String(error)}`);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.active?.abort();
    this.timers.forEach(timer => clearTimeout(timer));
    this.disposables.forEach(disposable => disposable.dispose());
  }
}
