import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AIManager } from '../../../ai';
import { DiffManager } from '../../../core/diff';
import { SelectionManager } from '../../../core/selection';
import { SessionManager } from '../../../core/session';
import { ChatMessage } from '../../../types/session';
import { SidebarWebviewProvider } from '../../../webview/provider';
import { WebviewProtocol } from '../../../webview/protocol';

export class ChatController {
  private pendingSends = 0;
  private branching = false;
  constructor(
    private readonly sessions: SessionManager,
    private readonly selections: SelectionManager,
    private readonly diffs: DiffManager,
    private readonly protocol: WebviewProtocol,
    private readonly provider: SidebarWebviewProvider,
    private readonly ai: AIManager
  ) {}

  register(): void {
    this.protocol.onMessage('ai/cancel', async data => {
      this.ai.cancelRequest(data.requestId);
    });
    this.protocol.onMessage('ai/send', async data => {
      if (this.branching) { return; }
      this.pendingSends++;
      try {
        await this.send(data.content);
      } finally {
        this.pendingSends--;
      }
    });
    this.protocol.onMessage<{ sessionId: string; timestamp: string; requestId?: string }>('session/branch', async data => {
      if (this.branching) { return; }
      this.branching = true;
      try {
        if (this.pendingSends > 0) {
          throw new Error('请等当前回答结束后再新建分支');
        }
        const source = await this.sessions.getActiveSession();
        if (!source || source.sessionId !== data?.sessionId) {
          throw new Error('会话已切换，请重新选择分支起点');
        }
        const branch = await this.sessions.branchSession(source.sessionId, data);
        await this.provider.syncSessions();
        const active = await this.sessions.getActiveSession();
        if (active?.sessionId === source.sessionId) {
          await this.sessions.setActiveSession(branch.sessionId);
          this.protocol.sendMessage({ type: 'session/loaded', data: branch });
        }
      } finally {
        this.branching = false;
        this.protocol.sendMessage({ type: 'session/branch_finished', data: undefined });
      }
    });
    this.protocol.onMessage('conversation/restore', async data => {
      await this.restore(data.conversationIndex);
    });
  }

  private async send(content: string): Promise<void> {
    let session = await this.sessions.getActiveSession();
    if (!session) {
      session = await this.sessions.createSession();
      await this.sessions.setActiveSession(session.sessionId);
      await this.provider.syncSessions();
      await this.provider.syncActiveSession();
    }
    const conversationIndex = this.sessions.getCurrentConversationIndex(session.sessionId);
    const requestId = randomUUID();
    this.ai.loadHistory([...session.history], session.historySummary,
      summary => this.sessions.saveHistorySummary(session.sessionId, summary));
    const userMessage: ChatMessage = {
      role: 'user', content, timestamp: new Date().toISOString(), requestId, requestStatus: 'RUNNING'
    };
    if (await this.sessions.addMessage(session.sessionId, userMessage)) {
      this.protocol.sendMessage({ type: 'message/appended', data: userMessage });
    }
    this.protocol.sendMessage({ type: 'ai/start', data: { requestId } });
    const selectedTexts = await this.selections.getSelections();
    let responseContent = '';
    const result = await this.ai.sendMessageStream(
      content,
      selectedTexts,
      async (chunk, done) => {
        if (!done) {
          responseContent += chunk;
          this.protocol.sendMessage({ type: 'ai/stream', data: { content: chunk, done: false } });
        } else if (chunk) {
          this.protocol.sendMessage({ type: 'ai/error', data: { message: chunk } });
        }
      },
      (stage, message) => this.protocol.sendMessage({ type: 'ai/progress', data: { stage, message } }),
      async event => {
        await this.sessions.updateRequestStatus(
          session.sessionId, event.requestId, event.status, event.finishReason, event.error
        );
        this.protocol.sendMessage({ type: 'ai/status', data: event });
      },
      requestId,
      { sessionId: session.sessionId, conversationIndex, workspaceDirectory: session.workspaceDirectory }
    );
    if (result.status === 'COMPLETED' && responseContent) {
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: responseContent,
        timestamp: new Date().toISOString(),
        requestId,
        requestStatus: 'COMPLETED',
        finishReason: result.finishReason,
        taskOutcome: result.taskOutcome,
        reasonCodes: result.reasonCodes,
        modelContext: this.ai.getHistory().at(-1)?.modelContext,
      };
      if (await this.sessions.addMessage(session.sessionId, assistantMessage)) {
        this.protocol.sendMessage({ type: 'message/appended', data: assistantMessage });
      }
    }
  }

  private async restore(conversationIndex: number): Promise<void> {
    const session = await this.sessions.getActiveSession();
    if (!session) {
      vscode.window.showWarningMessage('请先创建或选择一个会话');
      return;
    }
    const restoredUserMessage = this.sessions.getConversationUserMessage(session.sessionId, conversationIndex);
    if (!restoredUserMessage) {
      vscode.window.showWarningMessage('未找到要撤回的用户消息，对话保持不变。');
      return;
    }
    const rollback = await this.ai.rollbackFileTransactions(session.sessionId, conversationIndex);
    if (rollback.conflicts.length) {
      const filenames = rollback.conflicts.slice(0, 3).map(item => path.basename(item.filepath)).join('、');
      vscode.window.showWarningMessage(
        `未撤销对话：${filenames || '文件'} 的当前内容与事务日志不一致。为避免覆盖你的修改，文件和对话均保持不变。`
      );
      return;
    }
    if (rollback.errors.length) {
      const filenames = rollback.errors.slice(0, 3).map(item => path.basename(item.filepath)).join('、');
      const changedCount = rollback.restored.length + rollback.deleted.length;
      vscode.window.showErrorMessage(
        `文件撤销失败：${filenames || '未知文件'}。${changedCount ? '部分文件已恢复，' : ''}对话记录未删除，请先检查文件。`
      );
      return;
    }
    await this.sessions.truncateBeforeConversation(session.sessionId, conversationIndex);
    this.diffs.clearAllDiffs();
    const updatedSession = await this.sessions.getActiveSession();
    if (updatedSession) {
      this.protocol.sendMessage({ type: 'session/loaded', data: updatedSession });
    }
    this.protocol.sendMessage({
      type: 'conversation/restored',
      data: { conversationIndex, content: restoredUserMessage.content }
    });
    const changedCount = rollback.restored.length + rollback.deleted.length;
    vscode.window.showInformationMessage(
      `已撤销第 ${conversationIndex + 1} 轮及之后的对话${changedCount ? `，并恢复 ${changedCount} 个文件` : ''}`
    );
  }
}
