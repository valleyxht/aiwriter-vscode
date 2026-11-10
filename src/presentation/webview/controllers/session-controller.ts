import * as vscode from 'vscode';
import { SessionManager } from '../../../core/session';
import { SelectionManager } from '../../../core/selection';
import { SidebarWebviewProvider } from '../../../webview/provider';
import { WebviewProtocol } from '../../../webview/protocol';
import { ChatMessage } from '../../../types/session';

export class SessionController {
  constructor(
    private readonly sessions: SessionManager,
    private readonly selections: SelectionManager,
    private readonly protocol: WebviewProtocol,
    private readonly provider: SidebarWebviewProvider
  ) {}

  register(): void {
    this.protocol.onMessage('session/create', async data => {
      const session = await this.sessions.createSession(data?.title);
      await this.sessions.setActiveSession(session.sessionId);
      await this.provider.syncSessions();
      await this.provider.syncActiveSession();
      this.protocol.sendMessage({ type: 'session/created', data: session });
    });

    this.protocol.onMessage('session/load', async data => {
      await this.sessions.setActiveSession(data.sessionId);
      const session = await this.sessions.getActiveSession();
      await this.provider.syncSessions();
      await this.provider.syncActiveSession();
      if (session) {
        this.protocol.sendMessage({ type: 'session/loaded', data: session });
      }
    });

    this.protocol.onMessage('session/delete', async data => {
      await this.sessions.deleteSession(data.sessionId);
      await this.provider.syncSessions();
      this.protocol.sendMessage({ type: 'session/deleted', data: { sessionId: data.sessionId } });
    });

    this.protocol.onMessage('session/rename', async data => {
      await this.sessions.renameSession(data.sessionId, data.newTitle);
      await this.provider.syncSessions();
      this.protocol.sendMessage({
        type: 'session/renamed',
        data: { sessionId: data.sessionId, newTitle: data.newTitle }
      });
    });

    this.protocol.onMessage('selection/clear', async () => {
      await this.selections.clearSelections();
      await this.provider.syncSelections();
      this.protocol.sendMessage({ type: 'selection/cleared', data: undefined });
    });

    this.protocol.onMessage('selection/remove', async data => {
      await this.selections.removeSelection(data.id);
      await this.provider.syncSelections();
      this.protocol.sendMessage({ type: 'selection/removed', data: { id: data.id } });
    });

    this.protocol.onMessage('message/send', async data => {
      const session = await this.sessions.getActiveSession();
      if (!session) {
        vscode.window.showWarningMessage('请先创建或选择一个会话');
        return;
      }
      const message: ChatMessage = {
        role: 'user',
        content: data.content,
        timestamp: new Date().toISOString()
      };
      await this.sessions.addMessage(session.sessionId, message);
      this.protocol.sendMessage({ type: 'message/appended', data: message });
      vscode.window.showInformationMessage('消息已保存到会话');
    });
  }
}
