import { traceWritingRequest } from './models/langsmith';
/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/manager.ts - AI 管理器
 * 功能：协调 AI 相关的所有组件
 * 包含：
 *   - AI 配置管理
 *   - AI 引擎初始化
 *   - 消息发送和历史管理
 *   - 可选专业 Agent 工具集成
*/
import * as vscode from 'vscode';
import { ChatMessage, AIConfig, CollectedText, WorkflowConfig, AIRequestStatus, HistorySummary } from '../types';
import { randomUUID } from 'crypto';
import { AIConfigManager } from './models';
import {
  AIEngine,
  AIResponse,
  AIStreamCallback,
  AIProgressCallback,
  TokenStats,
  AIRequestResult,
  RequestJsonlLogger,
} from './runtime';
import { FileTools } from '../platform/vscode';
import { FileWriteApprover } from '../features/file-approval';
import { createSpecialistTools } from '../workers/specialists';
import { WebviewProtocol } from '../webview/protocol';
import { RagManager } from '../memory/rag';
import type { SpecialistDescriptor } from '../workers/specialists';
import { ToolDef } from './tools/index';
import { FileTransactionContext, FileTransactionManager, LocalBlobVersionStore, RollbackResult } from '../history';
import { StorageManager } from '../core/storage';
import { ProjectMemoryManager } from '../memory/project';
import { TaskOutcome } from './runtime/task-outcome';
import { currentRequestTelemetry, RequestTelemetry } from './runtime/request-telemetry';

export interface AIRequestStatusEvent extends Partial<TaskOutcome> {
  requestId: string;
  status: AIRequestStatus;
  finishReason?: string;
  error?: string;
}
export type AIRequestStatusCallback = (event: AIRequestStatusEvent) => void | Promise<void>;

export class AIManager {
  private _context: vscode.ExtensionContext;
  private _configManager: AIConfigManager;
  private _fileTools: FileTools;
  private _fileWriteApprover: FileWriteApprover;
  private _engine?: AIEngine;
  private _specialistTools: ToolDef[] = [];
  private _requestLogger = new RequestJsonlLogger();
  private _protocol?: WebviewProtocol;
  private _ragManager: RagManager;
  private _activeRequests = new Map<string, AbortController>();
  private _processedRequestIds = new Set<string>();
  private _requestIdOrder: string[] = [];
  private _configurationChangeInProgress = false;
  private _configurationChange?: Promise<void>;
  private _disposed = false;
  private _idleWaiters: Array<() => void> = [];
  private _fileTransactions: FileTransactionManager;
  private readonly _projectMemory: ProjectMemoryManager;

  private async _notifyStatus(
    callback: AIRequestStatusCallback | undefined,
    event: AIRequestStatusEvent
  ): Promise<void> {
    try {
      await callback?.(event);
    } catch (error) {
      console.error('[AIManager] Failed to publish request status:', error);
    }
  }

  constructor(context: vscode.ExtensionContext, fileWriteApprover: FileWriteApprover) {
    this._context = context;
    this._configManager = new AIConfigManager(context);
    this._fileTools = new FileTools(context);
    this._projectMemory = new ProjectMemoryManager(
      this._fileTools,
      () => this._configManager.config
    );
    this._fileWriteApprover = fileWriteApprover;
    this._fileTransactions = new FileTransactionManager(
      new StorageManager(context),
      new LocalBlobVersionStore(vscode.Uri.joinPath(context.globalStorageUri, 'file-history', 'blobs')),
      this._fileTools
    );
    this._ragManager = new RagManager(
      this._configManager.config,
      this._configManager.workflowConfig.parserModel,
      this._getWorkspacePathInternal()
    );
    console.log(
      `[AIManager] 可观测日志目录: ${vscode.Uri.joinPath(this._context.globalStorageUri, 'logs').fsPath}`
    );
    console.log('[AIManager] Initialized, token stats reporting will be enabled when protocol is set');
  }

  async initialize(): Promise<void> {
    await this._configManager.initialize();
    await this._fileTransactions.initialize();
    this._ragManager.updateConfig(this._configManager.config, this._configManager.workflowConfig.parserModel);
    await this._ragManager.initialize();
    this._initEngine();
    this._initSpecialists();
  }

  private _getWorkspacePathInternal(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }

  /** 暴露 RAG 管理器供命令层调用（构建索引、增量更新） */
  get rag(): RagManager {
    return this._ragManager;
  }

  /**
   * 设置 WebviewProtocol 用于发送 token 统计
   */
  setProtocol(protocol: WebviewProtocol): void {
    this._protocol = protocol;
    this._ragManager.setStatusCallback((status) => {
      this._protocol?.sendMessage({ type: 'rag/status', data: status });
    });
    console.log('[AIManager] WebviewProtocol set for token stats reporting');
  }

  private _initSpecialists(): void {
    this._specialistTools = createSpecialistTools({
      enableDecomposition: this._configManager.workflowConfig.enableIcebergPrompting,
      parserConfig: this._getParserConfig(),
      reviewConfig: this._configManager.config,
      fileSystem: this._fileTools,
      approver: this._fileWriteApprover,
      transactionManager: this._fileTransactions,
      rag: this._ragManager,
      logger: this._requestLogger,
      logRoot: this._context.globalStorageUri.fsPath,
    });
    this._engine?.setAdditionalTools(this._specialistTools);
  }

  // 获取当前工作区路径
  getWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }

  private _initEngine(): void {
    const previousEngine = this._engine;
    const nextEngine = this._configManager.isConfigured()
      ? new AIEngine(
        this._configManager.config,
        this._fileTools,
        this._fileWriteApprover,
        this._ragManager,
        this._fileTransactions,
        this._context.globalStorageUri.fsPath,
        this._specialistTools
      )
      : undefined;
    this._engine = nextEngine;
    previousEngine?.dispose();
  }

  get config(): AIConfig {
    return this._configManager.config;
  }

  get displayConfig(): AIConfig {
    return this._configManager.displayConfig;
  }

  get workflowConfig(): WorkflowConfig {
    return this._configManager.workflowConfig;
  }

  get displayWorkflowConfig(): WorkflowConfig {
    return this._configManager.displayWorkflowConfig;
  }

  get isConfigured(): boolean {
    return this._configManager.isConfigured();
  }

  get isParserConfigured(): boolean {
    return this._configManager.isParserConfigured();
  }

  async updateConfig(updates: Partial<AIConfig>): Promise<void> {
    await this._runConfigurationChange(async () => {
      await this._configManager.updateConfig(updates);
      this._ragManager.updateConfig(this._configManager.config, this._configManager.workflowConfig.parserModel);
      await this._ragManager.refreshStatus();
      this._initEngine();
      this._initSpecialists();
    });
  }

  async updateWorkflowConfig(updates: Partial<WorkflowConfig>): Promise<void> {
    await this._runConfigurationChange(async () => {
      await this._configManager.updateWorkflowConfig(updates);
      this._initSpecialists();
      this._ragManager.updateConfig(this._configManager.config, this._configManager.workflowConfig.parserModel);
      await this._ragManager.refreshStatus();
    });
  }

  async resetConfig(): Promise<void> {
    await this._runConfigurationChange(async () => {
      await this._configManager.resetConfig();
      this._ragManager.updateConfig(this._configManager.config, this._configManager.workflowConfig.parserModel);
      await this._ragManager.refreshStatus();
      this._initEngine();
      this._disposeSpecialists();
    });
  }

  private _disposeSpecialists(): void {
    this._specialistTools = [];
    this._engine?.setAdditionalTools([]);
  }

  async resetWorkflowConfig(): Promise<void> {
    await this._runConfigurationChange(async () => {
      await this._configManager.resetWorkflowConfig();
      this._initSpecialists();
    });
  }

  async sendMessage(
    userMessage: string,
    collectedTexts: CollectedText[]
  ): Promise<AIResponse> {
    const unavailableReason = this._requestUnavailableReason();
    if (unavailableReason) {
      return { content: '', success: false, error: unavailableReason };
    }
    if (!this._engine) {
      return {
        content: '',
        success: false,
        error: 'AI 模型未配置，请先配置 API Key'
      };
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    const engine = this._engine;
    this._activeRequests.set(requestId, controller);
    const workspacePath = this.getWorkspacePath();
    try {
      await this._prepareProjectMemoryForTurn(
        !engine.getHistory().some(message => message.role === 'user')
      );

      const collectedTextContent = this._formatCollectedTexts(collectedTexts);
      return await engine.sendMessage(
        userMessage, collectedTextContent, workspacePath,
        { requestId, controller, projectMemory: this._projectMemory.currentContent }
      );
    } finally {
      try {
        await this._projectMemory.refreshExisting(workspacePath);
      } catch (error) {
        console.warn('[AIManager] Failed to refresh AIWRITER.md after request:', error);
      }
      this._releaseRequest(requestId);
    }
  }

  async sendMessageStream(
    userMessage: string,
    collectedTexts: CollectedText[],
    callback: AIStreamCallback,
    progressCallback?: AIProgressCallback,
    statusCallback?: AIRequestStatusCallback,
    requestedId?: string,
    fileTransactionContext?: FileTransactionContext
  ): Promise<AIRequestResult> {
    const requestId = requestedId || randomUUID();
    const telemetry = new RequestTelemetry(requestId, this._context?.globalStorageUri?.fsPath, this._requestLogger);
    return traceWritingRequest(requestId, { userMessage, collectedTexts }, () => telemetry.run(async () => {
      let result: AIRequestResult;
      try {
        result = await this._sendMessageStream(userMessage, collectedTexts, callback, progressCallback,
          async event => { if (event.status === 'RUNNING') { await this._notifyStatus(statusCallback, event); } },
          requestId, fileTransactionContext);
      } catch (error) {
        result = { requestId, status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
        callback(result.error || '请求失败', true);
      }
      const summary = telemetry.snapshot();
      const reasons = [...new Set([...(result.reasonCodes || []), ...summary.reasonCodes])];
      result = { ...result, reasonCodes: reasons,
        taskOutcome: result.status !== 'COMPLETED' ? 'failed'
          : result.taskOutcome === 'failed' ? 'failed' : reasons.length ? 'degraded' : result.taskOutcome };
      await telemetry.complete(result);
      this._protocol?.sendMessage({ type: 'token/stats', data: {
        requestId, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, totalTokens: summary.totalTokens,
        contextUsagePercent: summary.contextUsagePercent ?? 0, shouldWarn: (summary.contextUsagePercent || 0) >= 80,
        scope: 'request', usageComplete: summary.usageComplete, unknownAttempts: summary.unknownAttempts,
      } });
      await this._notifyStatus(statusCallback, result);
      return result;
    }));
  }

  private async _sendMessageStream(
    userMessage: string,
    collectedTexts: CollectedText[],
    callback: AIStreamCallback,
    progressCallback?: AIProgressCallback,
    statusCallback?: AIRequestStatusCallback,
    requestedId?: string,
    fileTransactionContext?: FileTransactionContext
  ): Promise<AIRequestResult> {
    const requestId = requestedId || randomUUID();
    const unavailableReason = this._requestUnavailableReason();
    if (unavailableReason) {
      callback('', false);
      callback(unavailableReason, true);
      return { requestId, status: 'FAILED', error: unavailableReason };
    }
    if (this._activeRequests.has(requestId) || this._processedRequestIds.has(requestId)) {
      const error = `请求 ${requestId} 已存在，已拒绝重复提交`;
      console.warn(`[AIManager] ${error}`);
      callback('', false);
      callback(error, true);
      return { requestId, status: 'FAILED', error };
    }
    const engine = this._engine;
    if (!engine) {
      if (progressCallback) {
        progressCallback('error', 'AI 模型未配置');
      }
      callback('', false);
      callback('AI 模型未配置，请先配置 API Key', true);
      const result: AIRequestResult = { requestId, status: 'FAILED', error: 'AI 模型未配置' };
      await this._notifyStatus(statusCallback, result);
      return result;
    }

    this._rememberRequestId(requestId);
    const controller = new AbortController();
    this._activeRequests.set(requestId, controller);
    try {
      await this._notifyStatus(statusCallback, { requestId, status: 'RUNNING' });
      if (fileTransactionContext) {
        await this._fileTransactions.begin(requestId, fileTransactionContext);
      }

      // 设置 token 统计回调
      if (this._protocol) {
        engine.setTokenStatsCallback((stats: TokenStats) => {
          const telemetry = currentRequestTelemetry();
          if (telemetry) { telemetry.contextUsagePercent = stats.contextUsagePercent; }
          const usage = telemetry?.snapshot() || stats;
          console.log('[AIManager] Sending token stats to webview:', stats);
          this._protocol!.sendMessage({
            type: 'token/stats',
            data: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              requestId,
              scope: 'request',
              usageComplete: telemetry?.snapshot().usageComplete,
              unknownAttempts: telemetry?.snapshot().unknownAttempts,
              contextUsagePercent: stats.contextUsagePercent,
              shouldWarn: stats.shouldWarn,
            }
          });
        });
      } else {
        console.warn('[AIManager] Protocol not set, token stats will not be sent to UI');
      }

      const isFirstConversation = fileTransactionContext
        ? fileTransactionContext.conversationIndex === 0
        : !engine.getHistory().some(message => message.role === 'user');
      await this._prepareProjectMemoryForTurn(
        isFirstConversation,
        progressCallback,
        controller.signal
      );
      const collectedTextContent = this._formatCollectedTexts(collectedTexts);
      const workspacePath = this.getWorkspacePath();
      const result = await engine.sendMessageStream(
        userMessage, callback, collectedTextContent, workspacePath, progressCallback,
        { requestId, controller, projectMemory: this._projectMemory.currentContent }
      );
      await this._notifyStatus(statusCallback, result);
      return result;
    } catch (error) {
      const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const result: AIRequestResult = {
        requestId,
        status: interrupted ? 'INTERRUPTED' : 'FAILED',
        error: interrupted ? '请求已中断' : (error instanceof Error ? error.message : String(error))
      };
      callback(interrupted ? '' : result.error || '', true);
      await this._notifyStatus(statusCallback, result);
      return result;
    } finally {
      try {
        await this._fileTransactions.complete(requestId);
      } catch (error) {
        console.error('[AIManager] Failed to finalize file transaction:', error);
      }
      try {
        await this._projectMemory.refreshExisting(this.getWorkspacePath());
      } catch (error) {
        console.warn('[AIManager] Failed to refresh AIWRITER.md after request:', error);
      }
      this._releaseRequest(requestId);
    }
  }

  async rollbackFileTransactions(sessionId: string, conversationIndex: number): Promise<RollbackResult> {
    return this._fileTransactions.rollbackFrom(sessionId, conversationIndex);
  }

  cancelRequest(requestId: string): boolean {
    const controller = this._activeRequests.get(requestId);
    if (!controller) {
      return false;
    }
    controller.abort(new Error('用户停止生成'));
    return true;
  }

  private _rememberRequestId(requestId: string): void {
    this._processedRequestIds.add(requestId);
    this._requestIdOrder.push(requestId);
    while (this._requestIdOrder.length > 1_000) {
      const expired = this._requestIdOrder.shift();
      if (expired) {
        this._processedRequestIds.delete(expired);
      }
    }
  }

  private _requestUnavailableReason(): string | undefined {
    if (this._disposed) {
      return 'AI 管理器已停止，无法启动新请求';
    }
    if (this._configurationChangeInProgress) {
      return 'AI 配置正在更新，请稍后重试';
    }
    return undefined;
  }

  private async _runConfigurationChange(action: () => Promise<void>): Promise<void> {
    if (this._disposed) {
      throw new Error('AI 管理器已停止，无法修改配置');
    }
    while (this._configurationChange) {
      try { await this._configurationChange; } catch { /* A failed save must not block later saves. */ }
    }
    if (this._disposed) { throw new Error('AI 管理器已停止，无法修改配置'); }
    if (this._activeRequests.size > 0) {
      throw new Error('当前有正在运行的 AI 请求，请停止生成后再修改配置');
    }

    this._configurationChangeInProgress = true;
    const operation = action();
    this._configurationChange = operation;
    try {
      await operation;
    } finally {
      if (this._configurationChange === operation) {
        this._configurationChange = undefined;
        this._configurationChangeInProgress = false;
      }
    }
  }

  private _releaseRequest(requestId: string): void {
    this._activeRequests.delete(requestId);
    if (this._activeRequests.size === 0) {
      const waiters = this._idleWaiters.splice(0);
      waiters.forEach(resolve => resolve());
    }
  }

  private _waitForIdle(): Promise<void> {
    if (this._activeRequests.size === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this._idleWaiters.push(resolve));
  }

  async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._configurationChangeInProgress = true;
    try {
      await this._configurationChange;
    } catch (error) {
      console.warn('[AIManager] Configuration change failed during disposal:', error);
    }
    for (const controller of this._activeRequests.values()) {
      controller.abort(new Error('AI Writer 插件正在停止'));
    }
    await this._waitForIdle();

    this._engine?.dispose();
    this._engine = undefined;
    this._disposeSpecialists();
  }

  private _getParserConfig(): AIConfig {
    const main = this._configManager.config;
    const parser = this._configManager.workflowConfig.parserModel;
    if (!parser.enabled || !parser.apiKey.trim()) {
      return main;
    }
    return {
      ...main,
      provider: parser.provider,
      apiKey: parser.apiKey,
      baseUrl: parser.baseUrl,
      model: parser.model,
      temperature: parser.temperature,
    };
  }

  private async _prepareProjectMemoryForTurn(
    isFirstConversation: boolean,
    progressCallback?: AIProgressCallback,
    signal?: AbortSignal
  ): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (isFirstConversation) {
      await this._projectMemory.startSession(
        workspacePath,
        (stage, message) => progressCallback?.(stage, message),
        signal
      );
      return;
    }
    await this._projectMemory.loadExisting(workspacePath);
  }

  getRegisteredWorkers(): SpecialistDescriptor[] {
    return this._specialistTools.map(tool => ({
      id: tool.name, description: tool.description, mode: 'agent', examples: [],
    }));
  }

  loadHistory(messages: ChatMessage[], summary?: HistorySummary,
    onSummary?: (summary: HistorySummary) => Promise<void>): void {
    if (this._engine) {
      this._engine.loadHistory(messages, summary, onSummary);
    }
  }

  getHistory(): ChatMessage[] {
    return this._engine?.getHistory() || [];
  }

  clearHistory(): void {
    if (this._engine) {
      this._engine.clearHistory();
    }
  }

  private _formatCollectedTexts(collectedTexts: CollectedText[]): string | undefined {
    if (collectedTexts.length === 0) {
      return undefined;
    }

    return collectedTexts
      .map(ct => `文件: ${ct.displayName}\n\`\`\`\n${ct.contents}\n\`\`\``)
      .join('\n\n');
  }

  // 文件操作方法，提供给 AI 使用
  async readFile(filepath: string) {
    return await this._fileTools.readFile(filepath);
  }

  async writeFile(filepath: string, content: string) {
    return await this._fileTools.writeFile(filepath, content);
  }

  async editFile(filepath: string, content: string) {
    return await this._fileTools.editFile(filepath, content);
  }

  async listFiles(directory: string) {
    return await this._fileTools.listFiles(directory);
  }

}
