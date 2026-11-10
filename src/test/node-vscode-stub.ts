/*
 * Minimal vscode module shim for pure Node unit-test runs. The VS Code test
 * host provides the real module; this file is loaded only by the fallback
 * mocha command used when Electron cannot start.
 */
import Module = require('module');

const originalLoad = (Module as any)._load;

(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') {
    class Disposable {
      constructor(private readonly callback: () => void = () => undefined) {}
      dispose(): void { this.callback(); }
    }
    class EventEmitter<T> {
      readonly event = () => new Disposable();
      fire(_value: T): void {}
      dispose(): void {}
    }
    const makeUri = (scheme: string, path: string, fsPath = path) => ({
      scheme,
      path,
      fsPath,
      toString: () => `${scheme}:${path}`,
    });
    return {
      window: {
        createTextEditorDecorationType: () => ({ dispose: () => undefined }),
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
      },
      workspace: {
        workspaceFolders: undefined,
        getWorkspaceFolder: () => undefined,
        asRelativePath: (value: any) => value?.fsPath || String(value),
        registerFileSystemProvider: () => new Disposable(),
      },
      Uri: {
        file: (fsPath: string) => makeUri('file', fsPath, fsPath),
        from: ({ scheme, path }: any) => makeUri(scheme, path),
        parse: (value: string) => {
          const split = value.indexOf(':');
          return makeUri(value.slice(0, split), value.slice(split + 1));
        },
      },
      Disposable,
      EventEmitter,
      FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
      FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
      FileSystemError: {
        FileNotFound: (value: unknown) => new Error(`File not found: ${String(value)}`),
        NoPermissions: (value: unknown) => new Error(String(value)),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

export {};
