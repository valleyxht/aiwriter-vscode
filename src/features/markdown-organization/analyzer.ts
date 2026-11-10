import { createHash } from 'crypto';
import { ExactRange, MarkdownDocument, MarkdownHeading, MarkdownMetadata, OrganizationOperation } from './types';

export function parseMarkdownDocument(sourcePath: string, relativePath: string, bytes: Uint8Array): MarkdownDocument {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) {
    throw new Error('空 Markdown 文件不需要整理，已跳过');
  }
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new Error('文件不是有效的 UTF-8 Markdown，已跳过');
  }
  const lineStarts = getLineStarts(text);
  const hasTrailingNewline = text.length > 0 && /(?:\r\n|\n|\r)$/.test(text);
  return {
    sourcePath, relativePath, bytes, text,
    sourceSha256: createHash('sha256').update(buffer).digest('hex'),
    metadata: parseFrontMatter(text), headings: detectHeadings(text),
    lineCount: Math.max(1, lineStarts.length - (hasTrailingNewline ? 1 : 0)),
  };
}

function parseFrontMatter(text: string): MarkdownMetadata {
  const opening = text.match(/^---(?:\r\n|\n|\r)/);
  if (!opening) {return {};}
  const rest = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/m.exec(rest);
  if (!closing) {return {};}
  const result: MarkdownMetadata = {};
  let activeListKey: string | undefined;
  for (const rawLine of rest.slice(0, closing.index).split(/\r\n|\n|\r/)) {
    const listItem = rawLine.match(/^\s*-\s+(.+?)\s*$/);
    if (listItem && activeListKey) {
      const current = Array.isArray(result[activeListKey]) ? result[activeListKey] as string[] : [];
      current.push(unquote(listItem[1])); result[activeListKey] = current; continue;
    }
    const pair = rawLine.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!pair) { activeListKey = undefined; continue; }
    const [key, value] = [pair[1], pair[2]];
    if (!value) { activeListKey = key; result[key] = []; }
    else { activeListKey = undefined; result[key] = parseScalar(value); }
  }
  return result;
}

function parseScalar(value: string): string | number | boolean | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(item => unquote(item.trim())).filter(Boolean);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {return Number(trimmed);}
  if (/^(?:true|false)$/i.test(trimmed)) {return trimmed.toLowerCase() === 'true';}
  return unquote(trimmed);
}
function unquote(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single ?? '');
}

function detectHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const headingText = match[2].trim();
    headings.push({ level: match[1].length, line: countLinesBefore(text, match.index) + 1,
      text: headingText });
  }
  return headings;
}
function countLinesBefore(text: string, index: number): number {
  return (text.slice(0, index).match(/\r\n|\n|\r/g) || []).length;
}
function getLineStarts(text: string): number[] {
  const starts = [0]; const newline = /\r\n|\n|\r/g; let match: RegExpExecArray | null;
  while ((match = newline.exec(text)) !== null) {starts.push(match.index + match[0].length);}
  return starts;
}
export function exactRangeForLines(document: MarkdownDocument, startLine: number, endLine: number): ExactRange {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > document.lineCount) {
    throw new Error(`行号范围无效，应在 1-${document.lineCount} 之间`);
  }
  const starts = getLineStarts(document.text);
  const startCharacter = starts[startLine - 1];
  const endCharacter = endLine < starts.length ? starts[endLine] : document.text.length;
  return { startLine, endLine, startByte: Buffer.byteLength(document.text.slice(0, startCharacter), 'utf8'),
    endByte: Buffer.byteLength(document.text.slice(0, endCharacter), 'utf8') };
}
export function validateLosslessCoverage(document: MarkdownDocument, operations: OrganizationOperation[]): boolean {
  const ranges = operations.map(operation => operation.range).sort((a, b) => a.startByte - b.startByte);
  if (!ranges.length || ranges[0].startByte !== 0 || ranges[ranges.length - 1].endByte !== document.bytes.byteLength) {return false;}
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (range.startByte < 0 || range.endByte <= range.startByte || range.endByte > document.bytes.byteLength) {return false;}
    if (index > 0 && ranges[index - 1].endByte !== range.startByte) {return false;}
  }
  return Buffer.concat(ranges.map(range => Buffer.from(document.bytes).subarray(range.startByte, range.endByte)))
    .equals(Buffer.from(document.bytes));
}
