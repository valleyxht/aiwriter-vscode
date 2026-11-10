import * as path from 'path';
import { FileOperationResult, IFileSystem } from '../types';
import { ContentVersionStore, textHash } from './content-store';

const STORAGE_KEY = 'aiwriter.fileTransactions.v1';

export type FileChangeOperation = 'create' | 'edit';
export type FileTransactionStatus = 'active' | 'completed' | 'rolled_back' | 'partial';

export interface FileChangeRecord {
  filepath: string;
  operation: FileChangeOperation;
  existedBefore: boolean;
  beforeBlobId?: string;
  beforeHash?: string;
  afterHash: string;
  applied: boolean;
  rolledBack?: boolean;
}

export interface FileTransaction {
  requestId: string;
  sessionId: string;
  conversationIndex: number;
  workspaceDirectory: string;
  createdAt: string;
  completedAt?: string;
  status: FileTransactionStatus;
  changes: FileChangeRecord[];
}

export interface FileTransactionContext {
  sessionId: string;
  conversationIndex: number;
  workspaceDirectory: string;
}

export interface RollbackIssue {
  filepath: string;
  reason: string;
}

export interface RollbackResult {
  restored: string[];
  deleted: string[];
  conflicts: RollbackIssue[];
  errors: RollbackIssue[];
}

export interface TransactionMetadataStore {
  getWorkspaceData<T>(key: string): Promise<T | undefined>;
  setWorkspaceData<T>(key: string, value: T): Promise<void>;
}

interface PreparedMutation {
  transaction: FileTransaction;
  change: FileChangeRecord;
  previousAfterHash?: string;
  previousApplied: boolean;
}

/**
 * Request-scoped write-ahead log for AI file mutations.
 * Each file keeps the content from before its first write in the request.
 */
export class FileTransactionManager {
  private transactions: FileTransaction[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly metadataStore: TransactionMetadataStore,
    private readonly contentStore: ContentVersionStore,
    private readonly fileSystem: IFileSystem
  ) {}

  async initialize(): Promise<void> {
    this.transactions = (await this.metadataStore.getWorkspaceData<FileTransaction[]>(STORAGE_KEY)) || [];
  }

  async begin(requestId: string, context: FileTransactionContext): Promise<void> {
    await this.serialized(async () => {
      if (this.transactions.some(item => item.requestId === requestId)) {
        return;
      }
      this.transactions.push({
        requestId,
        ...context,
        createdAt: new Date().toISOString(),
        status: 'active',
        changes: [],
      });
      await this.persist();
    });
  }

  async complete(requestId: string): Promise<void> {
    await this.serialized(async () => {
      const transaction = this.transactions.find(item => item.requestId === requestId);
      if (!transaction || transaction.status !== 'active') {
        return;
      }
      if (transaction.changes.length === 0) {
        this.transactions = this.transactions.filter(item => item !== transaction);
        await this.persist();
        return;
      }
      transaction.status = 'completed';
      transaction.completedAt = new Date().toISOString();
      await this.persist();
    });
  }

  async executeWrite(
    requestId: string | undefined,
    filepath: string,
    content: string,
    write: () => Promise<FileOperationResult>
  ): Promise<FileOperationResult> {
    if (!requestId) {
      return write();
    }

    const prepared = await this.serialized(() => this.prepareMutation(requestId, filepath, content));
    if (!prepared) {
      return write();
    }

    let result: FileOperationResult;
    try {
      result = await write();
    } catch (error) {
      await this.serialized(() => this.reconcileFailedMutation(prepared));
      throw error;
    }

    await this.serialized(async () => {
      if (result.success) {
        prepared.change.applied = true;
        await this.persist();
      } else {
        await this.reconcileFailedMutation(prepared);
      }
    });
    return result;
  }

  /** Restore all non-restored transactions from the selected turn onward. */
  async rollbackFrom(sessionId: string, conversationIndex: number): Promise<RollbackResult> {
    return this.serialized(async () => {
      const result: RollbackResult = { restored: [], deleted: [], conflicts: [], errors: [] };
      const candidates = this.transactions
        .filter(item => item.sessionId === sessionId
          && item.conversationIndex >= conversationIndex
          && item.status !== 'rolled_back')
        .sort((a, b) => b.conversationIndex - a.conversationIndex
          || b.createdAt.localeCompare(a.createdAt));

      const operations = candidates.flatMap(transaction =>
        [...transaction.changes]
          .reverse()
          .filter(change => !change.rolledBack && (change.applied || change.afterHash))
          .map(change => ({ transaction, change }))
      );

      // Preflight the complete reverse chain before writing. For a file changed
      // in several turns, the simulated result of the newer undo must match the
      // expected after-state of the older transaction.
      const simulated = new Map<string, { exists: boolean; hash?: string }>();
      for (const { change } of operations) {
        const key = path.resolve(change.filepath);
        let current = simulated.get(key);
        if (!current) {
          const actual = await this.readCurrent(change.filepath);
          current = { exists: actual.exists, hash: actual.hash };
        }
        const matchesAfter = current.exists && current.hash === change.afterHash;
        const alreadyRestored = change.existedBefore
          ? current.exists && current.hash === change.beforeHash
          : !current.exists;
        if (matchesAfter || alreadyRestored) {
          simulated.set(key, change.existedBefore
            ? { exists: true, hash: change.beforeHash }
            : { exists: false });
          continue;
        }
        result.conflicts.push({
          filepath: change.filepath,
          reason: '文件在 AI 修改后又发生了变化，为避免覆盖当前内容，已停止撤销。',
        });
      }

      const missingBlobs = await Promise.all(operations
        .filter(({ change }) => change.existedBefore && !!change.beforeBlobId)
        .map(async ({ change }) => ({ change, exists: await this.contentStore.has(change.beforeBlobId!) })));
      for (const item of missingBlobs) {
        if (!item.exists) {
          result.errors.push({ filepath: item.change.filepath, reason: '找不到修改前的本地内容版本。' });
        }
      }
      if (result.conflicts.length || result.errors.length) {
        return result;
      }

      for (const { transaction, change } of operations) {
        try {
          const current = await this.readCurrent(change.filepath);
          if (!change.existedBefore) {
            if (current.exists) {
              const deletion = await this.fileSystem.deleteFile(change.filepath);
              if (!deletion.success) {
                throw new Error(deletion.message);
              }
              result.deleted.push(change.filepath);
            }
          } else if (current.hash !== change.beforeHash) {
            const bytes = await this.contentStore.get(change.beforeBlobId!);
            if (!bytes) {
              throw new Error('找不到修改前的本地内容版本');
            }
            const restored = await this.fileSystem.writeFile(
              change.filepath,
              Buffer.from(bytes).toString('utf8')
            );
            if (!restored.success) {
              throw new Error(restored.message);
            }
            result.restored.push(change.filepath);
          }
          change.rolledBack = true;
          transaction.status = transaction.changes.every(item => item.rolledBack || !item.applied)
            ? 'rolled_back'
            : 'partial';
        } catch (error) {
          transaction.status = 'partial';
          result.errors.push({
            filepath: change.filepath,
            reason: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
      await this.persist();
      return result;
    });
  }

  private async prepareMutation(
    requestId: string,
    filepath: string,
    content: string
  ): Promise<PreparedMutation | undefined> {
    const transaction = this.transactions.find(item => item.requestId === requestId);
    if (!transaction || transaction.status !== 'active') {
      return undefined;
    }
    const normalized = path.resolve(filepath);
    let change = transaction.changes.find(item => path.resolve(item.filepath) === normalized);
    const previousAfterHash = change?.afterHash;
    const previousApplied = change?.applied || false;
    if (!change) {
      const current = await this.readCurrent(filepath);
      let beforeBlobId: string | undefined;
      if (current.exists) {
        beforeBlobId = await this.contentStore.put(Buffer.from(current.content!, 'utf8'));
      }
      change = {
        filepath,
        operation: current.exists ? 'edit' : 'create',
        existedBefore: current.exists,
        beforeBlobId,
        beforeHash: current.hash,
        afterHash: textHash(content),
        applied: false,
      };
      transaction.changes.push(change);
    } else {
      change.afterHash = textHash(content);
    }
    // Persist the intended after-state before touching the workspace file.
    await this.persist();
    return { transaction, change, previousAfterHash, previousApplied };
  }

  private async reconcileFailedMutation(prepared: PreparedMutation): Promise<void> {
    const current = await this.readCurrent(prepared.change.filepath);
    if (current.exists && current.hash === prepared.change.afterHash) {
      prepared.change.applied = true;
    } else if (!prepared.change.existedBefore && !current.exists && !prepared.previousApplied) {
      prepared.transaction.changes = prepared.transaction.changes.filter(item => item !== prepared.change);
    } else if (prepared.previousAfterHash) {
      prepared.change.afterHash = prepared.previousAfterHash;
      prepared.change.applied = prepared.previousApplied;
    }
    await this.persist();
  }

  private async readCurrent(filepath: string): Promise<{ exists: boolean; content?: string; hash?: string }> {
    if (!(await this.fileSystem.fileExists(filepath))) {
      return { exists: false };
    }
    const result = await this.fileSystem.readFile(filepath);
    if (!result.success) {
      throw new Error(result.message);
    }
    const content = result.content || '';
    return { exists: true, content, hash: textHash(content) };
  }

  private async persist(): Promise<void> {
    await this.metadataStore.setWorkspaceData(STORAGE_KEY, this.transactions);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    // A failed operation is still returned to its caller, but must not poison
    // the queue and prevent later independent transactions from running.
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
