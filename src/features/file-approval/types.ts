export interface FileWriteApprovalRequest {
  filepath: string;
  action: 'create' | 'edit';
  originalCharacters: number;
  proposedCharacters: number;
  originalLines: number;
  proposedLines: number;
}

export interface FileWriteApprovalOptions {
  requestId?: string;
}

export interface PendingFileWriteApproval extends FileWriteApprovalRequest {
  approvalId: string;
}

export interface FileWriteApprover {
  confirmFileWrite(
    filepath: string,
    action: 'create' | 'edit',
    originalContent: string,
    proposedContent: string,
    signal?: AbortSignal,
    options?: FileWriteApprovalOptions
  ): Promise<boolean>;
}
