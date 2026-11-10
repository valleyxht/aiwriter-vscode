export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface RangeInFile {
  filepath: string;
  range: Range;
}

export interface RangeInFileWithContents {
  filepath: string;
  range: Range;
  contents: string;
}

export interface CollectedText {
  id: string;
  filepath: string;
  range: Range;
  contents: string;
  displayName: string;
  timestamp: string;
}

export interface DiffResult {
  originalContent: string;
  modifiedContent: string;
  filepath: string;
}
