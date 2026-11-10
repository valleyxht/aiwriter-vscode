/** Limit model-visible reads only; editing/conflict checks still read complete files. */
export function boundedFileExcerpt(text: string, offset: unknown, requested: unknown): string {
  const start = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const limit = typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, 30000) : 6000;
  if (!text.length) { return '文件为空'; }
  if (start >= text.length) { return `起始偏移超出文件范围；总字符数 ${text.length}。`; }
  const end = Math.min(text.length, start + limit);
  const notice = end < text.length ? `内容未读完；下一页 offset=${end}。请优先检索相关片段，不要为局部问题遍历全文。` : '已到文件末尾。';
  return `[文件片段：字符 ${start}～${end}（末端不含），共 ${text.length} 字符。${notice}]\n${text.slice(start, end)}`;
}
