export const SEARCH_MAX_BYTES = 50 * 1024;

export function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) { break; }
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Merge overlapping line windows, retaining exact source offsets. */
export function searchWindows(text: string, query: string, contextLines = 0) {
  if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
    throw new Error('contextLines 必须是非负整数');
  }
  if (!query) { return []; }
  const lines = text.split('\n');
  const offsets = [0];
  for (const line of lines) { offsets.push(offsets[offsets.length - 1] + line.length + 1); }
  const windows: { start: number; end: number; line: number; column: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const column = lines[i].indexOf(query);
    if (column < 0) { continue; }
    const start = offsets[Math.max(0, i - contextLines)];
    const end = Math.min(text.length, offsets[Math.min(lines.length, i + contextLines + 1)]);
    const previous = windows[windows.length - 1];
    if (previous && start <= previous.end) { previous.end = Math.max(previous.end, end); }
    else { windows.push({ start, end, line: i + 1, column: column + 1 }); }
  }
  return windows;
}
