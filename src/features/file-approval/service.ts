import { randomUUID } from 'crypto';
import {
  FileWriteApprover,
  FileWriteApprovalRequest,
  PendingFileWriteApproval,
} from './types';

type ApprovalRequestedListener = (request: PendingFileWriteApproval) => void;
type ApprovalResolvedListener = (approvalId: string, approved: boolean) => void;

interface PendingApproval {
  request: PendingFileWriteApproval;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class FileApprovalService implements FileWriteApprover {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly requestedListeners = new Set<ApprovalRequestedListener>();
  private readonly resolvedListeners = new Set<ApprovalResolvedListener>();

  async confirmFileWrite(
    filepath: string,
    action: 'create' | 'edit',
    originalContent: string,
    proposedContent: string,
    signal?: AbortSignal,
    _options?: { requestId?: string }
  ): Promise<boolean> {
    if (signal?.aborted) {
      return false;
    }
    const request: FileWriteApprovalRequest = {
      filepath,
      action,
      originalCharacters: originalContent.length,
      proposedCharacters: proposedContent.length,
      originalLines: originalContent ? originalContent.split('\n').length : 0,
      proposedLines: proposedContent ? proposedContent.split('\n').length : 0,
    };
    return this.requestApproval(request, signal);
  }

  resolveApproval(approvalId: string, approved: boolean): void {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return;
    }
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    for (const listener of this.resolvedListeners) {
      listener(approvalId, approved);
    }
    pending.resolve(approved);
  }

  getPendingApprovals(): PendingFileWriteApproval[] {
    return Array.from(this.pending.values(), item => item.request);
  }

  onApprovalRequested(listener: ApprovalRequestedListener): () => void {
    this.requestedListeners.add(listener);
    return () => this.requestedListeners.delete(listener);
  }

  onApprovalResolved(listener: ApprovalResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  private requestApproval(request: FileWriteApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    const approvalId = randomUUID();
    const pendingRequest: PendingFileWriteApproval = { approvalId, ...request };
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => this.resolveApproval(approvalId, false), 5 * 60 * 1000);
      const abortHandler = signal ? () => this.resolveApproval(approvalId, false) : undefined;
      if (abortHandler) {
        signal!.addEventListener('abort', abortHandler, { once: true });
      }
      this.pending.set(approvalId, {
        request: pendingRequest,
        resolve,
        timer,
        signal,
        abortHandler,
      });
      if (signal?.aborted) {
        this.resolveApproval(approvalId, false);
        return;
      }
      for (const listener of this.requestedListeners) {
        listener(pendingRequest);
      }
    });
  }
}
