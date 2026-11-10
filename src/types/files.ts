export interface FileOperationResult {
  success: boolean;
  message: string;
  content?: string;
  filepath?: string;
  version?: string;
}

export interface SearchMatch {
  filepath: string;
  line: number;
  column: number;
  text: string;
  charStart?: number;
  charEnd?: number;
  version?: string;
}

export interface SearchResult {
  success: boolean;
  message: string;
  matches?: SearchMatch[];
  truncated?: boolean;
}

export interface CommandResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface IFileSystem {
  validatePath(filepath: string): Promise<FileOperationResult>;
  readFile(filepath: string): Promise<FileOperationResult>;
  writeFile(filepath: string, content: string): Promise<FileOperationResult>;
  createFile(filepath: string, content: string): Promise<FileOperationResult>;
  editFile(filepath: string, content: string): Promise<FileOperationResult>;
  deleteFile(filepath: string): Promise<FileOperationResult>;
  fileExists(filepath: string): Promise<boolean>;
  listFiles(directory: string): Promise<FileOperationResult>;
  searchFiles(baseDirectory: string, pattern: string): Promise<FileOperationResult>;
  searchInFiles(baseDirectory: string, searchText: string, filePattern?: string, contextLines?: number): Promise<SearchResult>;
  searchAndReplace(filepath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<FileOperationResult>;
}
