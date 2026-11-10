/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/chunker.ts - 文本切块器
 * 功能：把一篇（可能百万字的）小说原文切分成带元数据的块
 *
 * 【RAG 技术点：Chunking】
 * - 优先按语义边界（章节标题、场景分隔符）切分，让每块是一个自洽的叙事单元；
 *   这比固定长度切分更利于检索——一块就是一个完整场景，命中更精准。
 * - 无法识别章节的连续长文降级为"固定长度 + 重叠"切分。重叠是为了避免把一句话
 *   /一个语义单元从中间切断，导致检索时上下文丢失。
 * - 每块携带 charStart/charEnd/chapterIndex 等元数据，供后续检索过滤使用。
 */
import { Chunk, ChunkMetadata } from './types';

// 章节标题匹配：第X章 / 第X回 / Chapter X / Markdown 标题 ##
const CHAPTER_PATTERNS: RegExp[] = [
  /^\s*第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回节卷篇][^\n]*/,
  /^\s*#{1,3}\s+.+/,           // Markdown 标题
  /^\s*Chapter\s+\d+/i,
];

// 场景分隔符（章节内进一步切分）：* * * / --- / ===
const SCENE_SEPARATOR = /\n\s*(?:[*＊]\s*){3,}\s*\n|\n\s*[-—=]{3,}\s*\n/;

export interface ChunkerOptions {
  chunkSize: number;
  chunkOverlap: number;
}

/**
 * 简单稳定的字符串 hash（用于生成 filepathHash / contentHash），避免引入额外依赖。
 */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(36);
}

interface RawSection {
  title: string;
  headingPath: string;
  content: string;
  charStart: number;   // 正文在原文件中的起始偏移
}

function parseHeading(line: string): { level: number; title: string } | undefined {
  const markdown = /^\s*(#{1,3})\s+(.+?)\s*$/.exec(line);
  if (markdown) {
    return { level: markdown[1].length, title: markdown[2].trim() };
  }
  const chinese = /^\s*第\s*[0-9零一二三四五六七八九十百千万]+\s*([章回节卷篇])[^\n]*/.exec(line);
  if (chinese) {
    return { level: /[卷篇]/.test(chinese[1]) ? 1 : 2, title: line.trim() };
  }
  if (CHAPTER_PATTERNS.some(re => re.test(line))) {
    return { level: 1, title: line.trim() };
  }
  return undefined;
}

/**
 * 按章节标题把整篇原文切成若干 section。识别不到任何标题时，返回单个 section。
 */
function splitIntoChapters(text: string): RawSection[] {
  const lines = text.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let offset = 0;
  const headingStack: string[] = [];

  for (const line of lines) {
    const lineWithNl = line + '\n';
    const heading = parseHeading(line);
    if (heading) {
      // 遇到新章节标题，结束上一节
      if (current) {
        sections.push(current);
      }
      headingStack.length = heading.level - 1;
      headingStack[heading.level - 1] = heading.title;
      current = {
        title: heading.title,
        headingPath: headingStack.filter(Boolean).join(' > '),
        content: '',
        charStart: offset + lineWithNl.length,
      };
    } else {
      if (!current) {
        // 文件开头在第一个标题之前的内容（如序言）
        current = { title: '', headingPath: '', content: '', charStart: offset };
      }
      current.content += lineWithNl;
    }
    offset += lineWithNl.length;
  }
  if (current) {
    sections.push(current);
  }
  // 完全没有内容时兜底
  if (sections.length === 0) {
    sections.push({ title: '', headingPath: '', content: text, charStart: 0 });
  }
  return sections;
}

/**
 * 对单个 section 的内容做二次切分：
 * 1. 先按场景分隔符切；
 * 2. 每个场景若仍超过 chunkSize，再按固定长度+重叠切。
 * 返回 [片段文本, 相对该 section 起始的偏移] 列表。
 */
function splitSectionBody(body: string, opts: ChunkerOptions): Array<[string, number]> {
  const pieces: Array<[string, number]> = [];

  // 记录场景在 body 中的偏移
  const scenes: Array<[string, number]> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const sepRe = new RegExp(SCENE_SEPARATOR, 'g');
  while ((match = sepRe.exec(body)) !== null) {
    scenes.push([body.slice(lastIndex, match.index), lastIndex]);
    lastIndex = match.index + match[0].length;
  }
  scenes.push([body.slice(lastIndex), lastIndex]);

  for (const [scene, sceneOffset] of scenes) {
    const trimmed = scene.trim();
    if (!trimmed) {
      continue;
    }
    if (scene.length <= opts.chunkSize) {
      pieces.push([scene, sceneOffset]);
    } else {
      // 固定长度 + 重叠 切分
      const step = Math.max(1, opts.chunkSize - opts.chunkOverlap);
      for (let start = 0; start < scene.length; start += step) {
        const slice = scene.slice(start, start + opts.chunkSize);
        if (slice.trim()) {
          pieces.push([slice, sceneOffset + start]);
        }
        if (start + opts.chunkSize >= scene.length) {
          break;
        }
      }
    }
  }
  return pieces;
}

/**
 * 切块主入口：把一个文件的完整文本切成带元数据的 Chunk[]。
 */
export function chunkFile(filepath: string, text: string, opts: ChunkerOptions): Chunk[] {
  const filepathHash = stableHash(filepath);
  const sections = splitIntoChapters(text);
  const chunks: Chunk[] = [];

  // 是否识别到了真正的章节（有标题）；否则章节序号记为 -1
  const hasChapters = sections.some((s) => s.title !== '');

  sections.forEach((section, chapterIdx) => {
    const chapterIndex = hasChapters ? chapterIdx : -1;
    const pieces = splitSectionBody(section.content, opts);

    pieces.forEach(([piece, relOffset], seq) => {
      const charStart = section.charStart + relOffset + piece.length - piece.trimStart().length;
      const metadata: ChunkMetadata = {
        chunkId: `${filepathHash}:${chapterIdx}:${seq}`,
        filepath,
        filepathHash,
        chapterIndex,
        title: section.title,
        headingPath: section.headingPath,
        charStart,
        charEnd: charStart + piece.trim().length,
        seq,
      };
      chunks.push({ content: piece.trim(), metadata });
    });
  });

  return chunks.filter((c) => c.content.length > 0);
}
