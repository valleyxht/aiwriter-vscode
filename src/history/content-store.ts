import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

/**
 * Content-addressed storage used by file history.
 *
 * A future isomorphic-git implementation can store/retrieve Git blobs behind
 * this interface without changing transaction or restore semantics.
 */
export interface ContentVersionStore {
  put(content: Uint8Array): Promise<string>;
  get(id: string): Promise<Uint8Array | undefined>;
  has(id: string): Promise<boolean>;
}

export function contentHash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function textHash(content: string): string {
  return contentHash(Buffer.from(content, 'utf8'));
}

/** Lightweight local blob storage. Metadata stays in workspaceState. */
export class LocalBlobVersionStore implements ContentVersionStore {
  constructor(private readonly root: vscode.Uri) {}

  async put(content: Uint8Array): Promise<string> {
    const hash = contentHash(content);
    const target = this.uriForHash(hash);
    if (!(await this.exists(target))) {
      const directory = vscode.Uri.joinPath(this.root, hash.slice(0, 2));
      const temporary = vscode.Uri.joinPath(directory, `${hash}.${randomUUID()}.tmp`);
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(temporary, gzipSync(Buffer.from(content)));
      try {
        await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
      } catch (error) {
        try {
          await vscode.workspace.fs.delete(temporary);
        } catch {
          // Best-effort cleanup; the stable blob is never replaced.
        }
        if (!(await this.exists(target))) {
          throw error;
        }
      }
    }
    return `sha256:${hash}`;
  }

  async get(id: string): Promise<Uint8Array | undefined> {
    const hash = this.parseId(id);
    if (!hash) {
      return undefined;
    }
    try {
      const compressed = await vscode.workspace.fs.readFile(this.uriForHash(hash));
      return gunzipSync(Buffer.from(compressed));
    } catch {
      return undefined;
    }
  }

  async has(id: string): Promise<boolean> {
    const hash = this.parseId(id);
    return hash ? this.exists(this.uriForHash(hash)) : false;
  }

  private uriForHash(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, hash.slice(0, 2), `${hash}.gz`);
  }

  private parseId(id: string): string | undefined {
    const match = /^sha256:([a-f0-9]{64})$/.exec(id);
    return match?.[1];
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }
}
