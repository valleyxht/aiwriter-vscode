/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * protocol.ts - Webview 通信协议
 * 功能：定义扩展和 webview 之间的双向通信
 * 包含：
 *   - 消息类型定义
 *   - 消息发送和接收
 *   - 消息处理器注册
*/
import * as vscode from 'vscode';
import { Session, SessionMetadata, CollectedText, ChatMessage, DiffResult, AIConfig, WorkflowConfig, AIRequestStatus, RagStatusSnapshot } from '../types';
import { PendingFileWriteApproval } from '../features/file-approval';

/**
 * Token 统计数据，发送给前端显示
 */
export interface TokenStatsData {
  requestId?: string;
  scope?: 'request';
  usageComplete?: boolean;
  unknownAttempts?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextUsagePercent: number;
  shouldWarn: boolean;
}

export interface Message<T = any> {
  type: string;
  id: string;
  data: T;
  timestamp: string;
}

export type ExtensionToWebviewMessage =
  | { type: 'session/list'; data: SessionMetadata[] }
  | { type: 'session/active'; data: Session | null }
  | { type: 'session/created'; data: Session }
  | { type: 'session/branch_finished'; data: undefined }
  | { type: 'session/deleted'; data: { sessionId: string } }
  | { type: 'session/renamed'; data: { sessionId: string; newTitle: string } }
  | { type: 'session/loaded'; data: Session }
  | { type: 'conversation/restored'; data: { conversationIndex: number; content: string } }
  | { type: 'selection/list'; data: CollectedText[] }
  | { type: 'selection/added'; data: CollectedText }
  | { type: 'selection/removed'; data: { id: string } }
  | { type: 'selection/cleared'; data: undefined }
  | { type: 'diff/pending'; data: { filepath: string; diffs?: any[] } }
  | { type: 'diff/decision'; data: { filepath: string; decision: 'accepted' | 'rejected' | 'dismissed' } }
  | { type: 'diff/shown'; data: DiffResult }
  | { type: 'file/approval/request'; data: PendingFileWriteApproval & { displayPath: string } }
  | { type: 'file/approval/resolved'; data: { approvalId: string; approved: boolean } }
  | { type: 'message/appended'; data: ChatMessage }
  // AI 相关消息
  | { type: 'ai/config'; data: AIConfig }
  | { type: 'ai/workflow_config'; data: { workflowConfig: WorkflowConfig; registeredWorkers: Array<{ id: string; description: string; mode: string }>; isParserConfigured: boolean } }
  | { type: 'ai/start'; data: { requestId: string } }
  | { type: 'ai/status'; data: { requestId: string; status: AIRequestStatus; finishReason?: string; error?: string; taskOutcome?: 'full' | 'degraded' | 'failed'; reasonCodes?: string[] } }
  | { type: 'ai/progress'; data: { stage: string; message: string } }
  | { type: 'ai/response'; data: { content: string } }
  | { type: 'ai/stream'; data: { content: string; done: boolean } }
  | { type: 'ai/error'; data: { message: string } }
  | { type: 'rag/status'; data: RagStatusSnapshot }
  | { type: 'research/status'; data: { message: string } }
  | { type: 'organization/status'; data: { state: 'running' | 'completed' | 'no_changes' | 'cancelled' | 'error'; message: string } }
  // Token 统计
  | { type: 'token/stats'; data: TokenStatsData };

export type WebviewToExtensionMessage =
  | { type: 'session/create'; data: { title?: string } }
  | { type: 'session/branch'; data: { sessionId: string; timestamp: string; requestId?: string } }
  | { type: 'session/load'; data: { sessionId: string } }
  | { type: 'session/delete'; data: { sessionId: string } }
  | { type: 'session/rename'; data: { sessionId: string; newTitle: string } }
  | { type: 'conversation/restore'; data: { conversationIndex: number } }
  | { type: 'selection/clear'; data: undefined }
  | { type: 'selection/remove'; data: { id: string } }
  | { type: 'diff/accept'; data: { filepath: string } }
  | { type: 'diff/reject'; data: { filepath: string } }
  | { type: 'file/approval/respond'; data: { approvalId: string; approved: boolean } }
  | { type: 'message/send'; data: { content: string } }
  // AI 相关消息
  | { type: 'ai/send'; data: { content: string } }
  | { type: 'ai/cancel'; data: { requestId: string } }
  | { type: 'ai/get_config'; data: undefined }
  | { type: 'ai/update_config'; data: Partial<AIConfig> }
  | { type: 'rag/get_status'; data: undefined }
  | { type: 'research/action'; data: { action: string } }
  | { type: 'rag/build_index'; data: undefined }
  | { type: 'organization/start'; data: undefined }
  | { type: 'ai/get_workflow_config'; data: undefined }
  | { type: 'ai/update_workflow_config'; data: Partial<WorkflowConfig> };

export type WebviewMessageHandler<T = any> = (data: T) => Promise<any>;
export type WebviewMessageListener<T = any> = (data: T) => void;

export class WebviewProtocol {
  private messageHandlers = new Map<string, WebviewMessageHandler>();
  private messageListeners = new Map<string, WebviewMessageListener[]>();
  private webview: vscode.Webview | undefined;

  constructor(_context: vscode.ExtensionContext) {}

  setWebview(webview: vscode.Webview): void {
    this.webview = webview;
  }

  sendMessage(message: ExtensionToWebviewMessage): void {
    if (!this.webview) {
      console.warn('Webview not initialized');
      return;
    }

    const fullMessage: Message = {
      ...message,
      id: this.generateId(),
      timestamp: new Date().toISOString()
    };

    const visible = ({ modelContext: _context, ...rest }: ChatMessage) => rest;
    if (message.type === 'message/appended') {
      fullMessage.data = visible(message.data);
    } else if (['session/active', 'session/created', 'session/loaded'].includes(message.type) && message.data) {
      const session = message.data as Session;
      fullMessage.data = { ...session, history: session.history.map(visible) };
    }

    this.webview.postMessage(fullMessage);
  }

  onMessage<T = any>(
    type: string,
    handler: WebviewMessageHandler<T>
  ): void {
    this.messageHandlers.set(type, handler);
  }

  async handleMessage(message: Message): Promise<any> {
    const handler = this.messageHandlers.get(message.type);
    if (!handler) {
      console.warn(`No handler for message type: ${message.type}`);
      return;
    }

    try {
      return await handler(message.data);
    } catch (error) {
      console.error(`Error handling message ${message.type}:`, error);
      vscode.window.showErrorMessage(
        `处理消息时出错: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  addListener<T = any>(
    type: string,
    listener: WebviewMessageListener<T>
  ): void {
    if (!this.messageListeners.has(type)) {
      this.messageListeners.set(type, []);
    }
    this.messageListeners.get(type)!.push(listener);
  }

  removeListener(type: string, listener: WebviewMessageListener): void {
    const listeners = this.messageListeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }
  }

  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
