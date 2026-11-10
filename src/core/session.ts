/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * session.ts - 会话管理器
 * 功能：管理写作会话的创建、加载、保存、删除、重命名等
 * 包含：
 *   - 会话的持久化存储
 *   - 会话历史消息管理
 *   - 对话快照保存和恢复（用于回退）
 *   - 活跃会话跟踪
*/
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Session, SessionMetadata, ChatMessage, ConversationSnapshot, FileState, HistorySummary } from '../types';
import { validHistorySummary } from '../memory/history-summary-state';
import { StorageManager } from './storage';

export class SessionManager {
  private readonly SESSIONS_KEY = 'aiwriter.sessions';
  private readonly ACTIVE_SESSION_KEY = 'aiwriter.activeSession';
  private sessions: Map<string, Session> = new Map();
  private activeSessionId: string | null = null;

  constructor(
    _context: vscode.ExtensionContext,
    private readonly storage: StorageManager
  ) {}

  async initialize(): Promise<void> {
    const sessions = await this.storage.getGlobalData<Session[]>(this.SESSIONS_KEY);
    if (sessions) {
      sessions.forEach(session => {
        this.sessions.set(session.sessionId, session);
      });
    }

    const activeId = await this.storage.getGlobalData<string>(this.ACTIVE_SESSION_KEY);
    this.activeSessionId = activeId || null;
  }

  async createSession(title?: string): Promise<Session> {
    const sessionId = randomUUID();
    const workspaceDirectory = this.getWorkspacePath();
    const now = new Date().toISOString();

    const session: Session = {
      sessionId,
      title: title || ('会话 ' + (this.sessions.size + 1)),
      workspaceDirectory,
      dateCreated: now,
      dateModified: now,
      history: [],
      snapshots: []
    };

    this.sessions.set(sessionId, session);
    await this.saveAllSessions();

    return session;
  }

  async branchSession(sessionId: string, answer: { timestamp: string; requestId?: string }): Promise<Session> {
    const source = this.sessions.get(sessionId);
    if (!source || typeof answer.timestamp !== 'string' || !answer.timestamp) {
      throw new Error('未找到分支来源');
    }
    const index = source.history.findIndex(message => message.role === 'assistant'
      && message.timestamp === answer.timestamp && message.requestId === answer.requestId);
    const selected = source.history[index];
    if (!selected?.content.trim() || (selected.requestStatus && selected.requestStatus !== 'COMPLETED')) {
      throw new Error('只能从已完成的回答新建分支');
    }

    const history = structuredClone(source.history.slice(0, index + 1));
    const now = new Date().toISOString();
    const session: Session = {
      sessionId: randomUUID(),
      title: `${source.title} · 分支`,
      workspaceDirectory: source.workspaceDirectory,
      dateCreated: now,
      dateModified: now,
      history,
      snapshots: []
    };
    if (source.historySummary && validHistorySummary(history, source.historySummary)) {
      session.historySummary = { ...source.historySummary };
    }
    this.sessions.set(session.sessionId, session);
    try {
      await this.saveAllSessions();
    } catch (error) {
      this.sessions.delete(session.sessionId);
      throw error;
    }
    return session;
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }

  async saveSession(session: Session): Promise<void> {
    session.dateModified = new Date().toISOString();
    this.sessions.set(session.sessionId, session);
    await this.saveAllSessions();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.saveAllSessions();

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      await this.storage.removeGlobalData(this.ACTIVE_SESSION_KEY);
    }
  }

  async saveHistorySummary(sessionId: string, summary: HistorySummary): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !validHistorySummary(session.history, summary)) { return; }
    session.historySummary = summary;
    await this.saveAllSessions();
  }

  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = newTitle;
      session.dateModified = new Date().toISOString();
      await this.saveAllSessions();
    }
  }

  async getAllSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values());
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      dateCreated: session.dateCreated,
      messageCount: session.history.length
    };
  }

  async getAllSessionMetadata(): Promise<SessionMetadata[]> {
    const sessions = await this.getAllSessions();
    return sessions.map(session => ({
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      dateCreated: session.dateCreated,
      messageCount: session.history.length
    }));
  }

  async getActiveSession(): Promise<Session | null> {
    if (!this.activeSessionId) {
      return null;
    }
    return this.sessions.get(this.activeSessionId) || null;
  }

  async setActiveSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error('Session ' + sessionId + ' not found');
    }

    await this.storage.setGlobalData(this.ACTIVE_SESSION_KEY, sessionId);
    this.activeSessionId = sessionId;
  }

  async addMessage(sessionId: string, message: ChatMessage): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session ' + sessionId + ' not found');
    }

    const duplicateIndex = message.requestId
      ? session.history.findIndex(item => item.requestId === message.requestId && item.role === message.role)
      : -1;
    if (duplicateIndex >= 0) {
      return false;
    }

    session.history.push(message);
    session.dateModified = new Date().toISOString();
    await this.saveAllSessions();
    return true;
  }

  async updateRequestStatus(
    sessionId: string,
    requestId: string,
    status: ChatMessage['requestStatus'],
    finishReason?: string,
    error?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session ' + sessionId + ' not found');
    }

    const message = session.history.find(item => item.requestId === requestId);
    if (!message) {
      return;
    }

    message.requestStatus = status;
    message.finishReason = finishReason;
    message.error = error;
    session.dateModified = new Date().toISOString();
    await this.saveAllSessions();
  }

  async clearHistory(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session ' + sessionId + ' not found');
    }

    session.history = [];
    session.dateModified = new Date().toISOString();
    await this.saveAllSessions();
  }

  /**
   * 保存对话快照
   * @param sessionId 会话 ID
   * @param conversationIndex 对话轮次索引
   * @param modifiedFiles 修改过的文件及其内容
   */
  async saveSnapshot(
    sessionId: string,
    conversationIndex: number,
    modifiedFiles: FileState[]
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session ' + sessionId + ' not found');
    }

    const snapshot: ConversationSnapshot = {
      conversationIndex,
      timestamp: new Date().toISOString(),
      files: modifiedFiles
    };

    const existingIndex = session.snapshots.findIndex(
      item => item.conversationIndex === conversationIndex
    );
    if (existingIndex >= 0) {
      session.snapshots[existingIndex] = snapshot;
    } else {
      session.snapshots.push(snapshot);
    }
    session.dateModified = new Date().toISOString();
    await this.saveAllSessions();
  }

  /**
   * 获取指定轮次的快照
   */
  getSnapshot(sessionId: string, conversationIndex: number): ConversationSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    return session.snapshots.find(s => s.conversationIndex === conversationIndex);
  }

  /**
   * 获取所有快照
   */
  getAllSnapshots(sessionId: string): ConversationSnapshot[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return session.snapshots;
  }

  /**
   * 获取当前对话轮次索引。失败/中断轮次可能没有 assistant，必须按 user 消息计数。
   */
  getCurrentConversationIndex(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return 0;
    }
    return session.history.filter(message => message.role === 'user').length;
  }

  /** 获取指定轮次的原始用户输入，用于撤回后恢复到编辑框。 */
  getConversationUserMessage(sessionId: string, conversationIndex: number): ChatMessage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isInteger(conversationIndex) || conversationIndex < 0) {
      return undefined;
    }
    return session.history.filter(message => message.role === 'user')[conversationIndex];
  }

  /** 截断到指定轮次开始前，不假设每个 user 都有对应 assistant。 */
  async truncateBeforeConversation(sessionId: string, conversationIndex: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    let seenUsers = 0;
    let keepMessages = session.history.length;
    for (let index = 0; index < session.history.length; index++) {
      if (session.history[index].role !== 'user') {
        continue;
      }
      if (seenUsers === conversationIndex) {
        keepMessages = index;
        break;
      }
      seenUsers++;
    }
    await this.truncateHistory(sessionId, keepMessages);
  }

  /**
   * 截断会话历史到指定消息数量
   * 用于恢复到之前某一轮对话
   */
  async truncateHistory(sessionId: string, keepMessages: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.history.length > keepMessages) {
      console.log(`[SessionManager] Truncating history from ${session.history.length} to ${keepMessages} messages`);
      session.history = session.history.slice(0, keepMessages);
      if (!validHistorySummary(session.history, session.historySummary)) {
        delete session.historySummary;
      }
      session.dateModified = new Date().toISOString();
      await this.saveAllSessions();
    }
  }

  private async saveAllSessions(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    await this.storage.setGlobalData(this.SESSIONS_KEY, sessions);
  }

  private getWorkspacePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return 'no-workspace';
    }
    return folders[0].uri.fsPath;
  }
}
