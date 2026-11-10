import * as vscode from 'vscode';
import { FileApprovalService, PendingFileWriteApproval } from '../../../features/file-approval';
import { WebviewProtocol } from '../../../webview/protocol';

export class FileApprovalController {
  private registered = false;

  constructor(
    private readonly protocol: WebviewProtocol,
    private readonly approvals: FileApprovalService
  ) {}

  register(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    this.approvals.onApprovalRequested(request => this.sendRequest(request));
    this.approvals.onApprovalResolved((approvalId, approved) => {
      this.protocol.sendMessage({
        type: 'file/approval/resolved',
        data: { approvalId, approved }
      });
    });
    this.protocol.onMessage('file/approval/respond', async data => {
      this.approvals.resolveApproval(data.approvalId, data.approved === true);
    });
  }

  resendPending(): void {
    for (const request of this.approvals.getPendingApprovals()) {
      this.sendRequest(request);
    }
  }

  private sendRequest(request: PendingFileWriteApproval): void {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(request.filepath));
    const displayPath = workspaceFolder
      ? vscode.workspace.asRelativePath(vscode.Uri.file(request.filepath), false)
      : request.filepath;
    this.protocol.sendMessage({
      type: 'file/approval/request',
      data: { ...request, displayPath }
    });
  }
}
