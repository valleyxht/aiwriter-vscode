import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { parseMarkdownDocument } from './analyzer';
import { MarkdownOrganizationAgent } from './agent';
import {
  AIConfigProvider,
  MarkdownDocument,
  OrganizationExecutionResult,
  OrganizationOperation,
  OrganizationPlan,
  SkippedDocument,
} from './types';

const OUTPUT_DIRECTORY = 'AIWriter整理结果';
const CONTROL_FILES = new Set(['agents.md', 'aiwriter.md']);
export type MarkdownOrganizationRunResult = 'completed' | 'no_changes' | 'cancelled';

export class MarkdownOrganizationService implements vscode.Disposable {
  private readonly agent: MarkdownOrganizationAgent;
  private readonly output = vscode.window.createOutputChannel('AI Writer Markdown 整理');

  constructor(configProvider: AIConfigProvider) {
    this.agent = new MarkdownOrganizationAgent(configProvider);
  }

  dispose(): void {
    this.output.dispose();
  }

  async run(): Promise<MarkdownOrganizationRunResult> {
    const sourceRoot = await this.selectSourceRoot();
    if (!sourceRoot) {
      return 'cancelled';
    }

    const controller = new AbortController();
    this.output.clear();
    this.output.appendLine('AI Writer Markdown 整理 Agent');
    this.output.appendLine('='.repeat(60));
    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '分析 Markdown 小说文件', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        progress.report({ message: '正在扫描 .md 文件…' });
        const { documents, skipped } = await this.scan(sourceRoot, controller.signal);
        progress.report({ message: `AI 正在使用工具检查 ${documents.length} 个 Markdown 文件…` });
        const organizationPlan: OrganizationPlan = documents.length === 0
          ? { sourceRoot: sourceRoot.fsPath, outputDirectoryName: OUTPUT_DIRECTORY, operations: [], skipped: [] }
          : await this.agent.organize(sourceRoot.fsPath, documents, controller.signal,
            message => this.output.appendLine(`[工具] ${message}`));
        organizationPlan.skipped.unshift(...skipped);
        return organizationPlan;
      }
    );

    this.showPreview(plan, this.output);
    if (plan.operations.length === 0) {
      vscode.window.showInformationMessage(
        `没有可安全整理的文件；已跳过 ${plan.skipped.length} 个文件。详情见“AI Writer Markdown 整理”输出。`
      );
      return 'no_changes';
    }

    const confirmed = await vscode.window.showWarningMessage(
      `将原样复制 ${plan.operations.length} 个文件/章节到“${OUTPUT_DIRECTORY}”。原文件不会修改或删除。`,
      { modal: true },
      '执行整理'
    );
    if (confirmed !== '执行整理') {
      return 'cancelled';
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '整理 Markdown 小说文件', cancellable: false },
      progress => this.execute(sourceRoot, plan, progress)
    );
    vscode.window.showInformationMessage(
      `整理完成：创建 ${result.created.length} 个原文副本，跳过 ${result.skipped.length} 个文件。`
    );
    return 'completed';
  }

  private async selectSourceRoot(): Promise<vscode.Uri | undefined> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择要整理的 Markdown 文件夹',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    return selected?.[0];
  }

  private async scan(
    sourceRoot: vscode.Uri,
    signal: AbortSignal
  ): Promise<{ documents: MarkdownDocument[]; skipped: SkippedDocument[] }> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(sourceRoot, '**/*.md'),
      `**/{node_modules,.git,.aiwriter,.codex,${OUTPUT_DIRECTORY}}/**`
    );
    const documents: MarkdownDocument[] = [];
    const skipped: SkippedDocument[] = [];
    const outputPrefix = normalizeFsPath(vscode.Uri.joinPath(sourceRoot, OUTPUT_DIRECTORY).fsPath);
    for (const uri of uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      throwIfAborted(signal);
      if (normalizeFsPath(uri.fsPath).startsWith(`${outputPrefix}/`)) {
        continue;
      }
      const relativePath = path.relative(sourceRoot.fsPath, uri.fsPath).replace(/\\/g, '/');
      if (CONTROL_FILES.has(path.posix.basename(relativePath).toLowerCase())) {
        skipped.push({ sourceRelativePath: relativePath, reason: '项目控制文件不参与小说资料整理' });
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        documents.push(parseMarkdownDocument(uri.fsPath, relativePath, bytes));
      } catch (error) {
        skipped.push({
          sourceRelativePath: relativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { documents, skipped };
  }

  private showPreview(plan: OrganizationPlan, output: vscode.OutputChannel): void {
    output.appendLine('\nAI Writer Markdown 无损整理预览');
    output.appendLine('='.repeat(60));
    output.appendLine(`源目录：${plan.sourceRoot}`);
    output.appendLine(`输出目录：${path.join(plan.sourceRoot, plan.outputDirectoryName)}`);
    output.appendLine('原文件不会修改、覆盖或删除。\n');
    for (const operation of plan.operations) {
      output.appendLine(`[原文切片 ${operation.range.startLine}-${operation.range.endLine} 行] ${operation.sourceRelativePath}`);
      output.appendLine(`       → ${operation.targetRelativePath}`);
    }
    if (plan.skipped.length > 0) {
      output.appendLine('\n跳过：');
      for (const item of plan.skipped) {
        output.appendLine(`- ${item.sourceRelativePath}: ${item.reason}`);
      }
    }
    output.show(true);
  }

  private async execute(
    sourceRoot: vscode.Uri,
    plan: OrganizationPlan,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<OrganizationExecutionResult> {
    const outputRoot = vscode.Uri.joinPath(sourceRoot, plan.outputDirectoryName);
    await this.preflight(sourceRoot, outputRoot, plan.operations);
    const createdFiles: vscode.Uri[] = [];
    try {
      for (let index = 0; index < plan.operations.length; index++) {
        const operation = plan.operations[index];
        progress.report({
          message: `${index + 1}/${plan.operations.length} ${operation.targetRelativePath}`,
          increment: 100 / plan.operations.length,
        });
        const sourceBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(operation.sourcePath));
        const target = safeTargetUri(outputRoot, operation.targetRelativePath);
        const parent = vscode.Uri.file(path.dirname(target.fsPath));
        await vscode.workspace.fs.createDirectory(parent);
        const bytes = sourceBytes.slice(operation.range.startByte, operation.range.endByte);
        createdFiles.push(target);
        await vscode.workspace.fs.writeFile(target, bytes);
      }
      return {
        created: createdFiles.map(uri => path.relative(sourceRoot.fsPath, uri.fsPath).replace(/\\/g, '/')),
        skipped: plan.skipped,
      };
    } catch (error) {
      for (const uri of [...createdFiles].reverse()) {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        } catch {
          // Best-effort cleanup; original files were never touched.
        }
      }
      throw error;
    }
  }

  private async preflight(
    sourceRoot: vscode.Uri,
    outputRoot: vscode.Uri,
    operations: OrganizationOperation[]
  ): Promise<void> {
    if (!normalizeFsPath(outputRoot.fsPath).startsWith(`${normalizeFsPath(sourceRoot.fsPath)}/`)) {
      throw new Error('整理输出目录不在所选源目录内');
    }
    for (const operation of operations) {
      const currentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(operation.sourcePath));
      const currentHash = createHash('sha256').update(currentBytes).digest('hex');
      if (currentHash !== operation.sourceSha256) {
        throw new Error(`源文件在预览后发生变化，已停止整理: ${operation.sourceRelativePath}`);
      }
      if (operation.range.startByte < 0
          || operation.range.endByte <= operation.range.startByte
          || operation.range.endByte > currentBytes.byteLength) {
        throw new Error(`无效的原文切片范围: ${operation.sourceRelativePath}`);
      }
      const target = safeTargetUri(outputRoot, operation.targetRelativePath);
      try {
        await vscode.workspace.fs.stat(target);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          continue;
        } else {
          throw error;
        }
      }
      throw new Error(`目标文件已存在，为避免覆盖已停止整理: ${operation.targetRelativePath}`);
    }
  }
}

function safeTargetUri(outputRoot: vscode.Uri, relativePath: string): vscode.Uri {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`无效目标路径: ${relativePath}`);
  }
  const target = vscode.Uri.joinPath(outputRoot, ...segments);
  if (!normalizeFsPath(target.fsPath).startsWith(`${normalizeFsPath(outputRoot.fsPath)}/`)) {
    throw new Error(`目标路径越界: ${relativePath}`);
  }
  return target;
}

function normalizeFsPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Markdown organization cancelled', 'AbortError');
  }
}
