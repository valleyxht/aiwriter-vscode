import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IFileSystem } from '../../types';
import { defineTool, ToolDef, toolError, toolSuccess } from '../../ai/tools/contract';
import { contentHash } from './catalog';
import { ResearchCatalog } from './types';
import { applySummary, discoverSummaries, findSummary, parseSummary } from './summary-files';
import prompts from './prompts.json';

const PAGE_CHARS = 8000;
const PAGE_ITEMS = 30;

/** Derived navigation stays separate from the verbatim evidence ledger. */
export async function createResearchNavigation(root: string | undefined, fileSystem: IFileSystem): Promise<{ context?: string; tools: ToolDef[] }> {
  if (!root || !path.isAbsolute(root)) { return { tools: [] }; }
  const directory = path.join(root, '.aiwriter', 'research');
  const inside = (base: string, relative: string) => {
    const absolute = path.resolve(base, relative);
    const check = path.relative(base, absolute);
    if (path.isAbsolute(relative) || check === '..' || check.startsWith('..' + path.sep)) { throw new Error('目录包含越界路径'); }
    return absolute;
  };
  const readDerived = async (relative: string) => {
    const filename = inside(directory, relative);
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(filename);
    const check = path.relative(realRoot, realFile);
    if (path.isAbsolute(check) || check === '..' || check.startsWith('..' + path.sep)) { throw new Error('资料路径指向工作区之外'); }
    return fs.readFile(realFile, 'utf8');
  };
  const load = async (): Promise<ResearchCatalog> => {
    const catalog = JSON.parse(await readDerived('catalog.json')) as ResearchCatalog;
    if (catalog.version !== 1 || !Array.isArray(catalog.files)) { throw new Error('资料目录格式无效'); }
    for (const file of catalog.files) {
      inside(root, file.path);
      if (!Array.isArray(file.sections)) { throw new Error('章节目录格式无效'); }
      for (const section of file.sections) {
        if (typeof section.id !== 'string' || typeof section.title !== 'string'
          || !Number.isInteger(section.start) || !Number.isInteger(section.end)
          || section.start < 0 || section.end < section.start
          || (section.description !== undefined && typeof section.description !== 'string')) {
          throw new Error('章节目录格式无效');
        }
      }
    }
    const documents = await discoverSummaries(directory);
    for (const file of catalog.files) {
      for (const section of file.sections) {
        let document = findSummary(documents, file, section);
        // Backward-compatible reads until the workspace scan migrates old filenames.
        if (!document && section.summary && /^summaries\/[0-9a-f-]{36}-[0-9a-f]{64}\.md$/.test(section.summary)) {
          const legacy = documents.find(item => item.relative === section.summary);
          if (legacy) { document = { ...legacy, metadata: { source: file.path, chapter: section.title, source_sha256: section.generatedHash } }; }
        }
        applySummary(section, document);
      }
    }
    return catalog;
  };
  const listing = (catalog: ResearchCatalog, filepath?: string, offset = 0) => {
    const file = filepath ? catalog.files.find(entry => entry.path === filepath) : undefined;
    if (filepath && !file) { throw new Error('目录中没有该文件，请使用普通文件工具定位'); }
    const rows = file ? file.sections.map(section => JSON.stringify({
      sectionId: section.id, title: section.title.slice(0, 120), description: section.description?.slice(0, 160),
      hasSummary: !!section.summary,
    })) : catalog.files.map(entry => JSON.stringify({
      filepath: entry.path, sections: entry.sections.length,
      description: entry.sections.length === 1 ? entry.sections[0].description?.slice(0, 160) : undefined,
      summaries: entry.sections.filter(section => section.summary).length,
    }));
    const page: string[] = [];
    let chars = 0;
    for (const row of rows.slice(offset, offset + PAGE_ITEMS)) {
      if (chars + row.length > PAGE_CHARS) { break; }
      page.push(row); chars += row.length + 1;
    }
    const next = offset + page.length;
    if (!page.length && offset < rows.length) { throw new Error('目录项异常过长，请重新生成目录'); }
    return [prompts.navigationNotice, `范围：${filepath || '文件概览'}；共 ${rows.length} 项；本页 ${offset}～${next}（不含末端）。`,
      ...page, next < rows.length ? `未展示全部；listResearchCatalog 下一页 offset=${next}${filepath ? `，filepath=${filepath}` : ''}。` : '此层目录已展示完毕。',
    ].join('\n');
  };
  let context: string;
  try { context = listing(await load()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { tools: [] }; }
    return { context: '资料目录暂不可用，请使用现有文件搜索与 RAG 工具。', tools: [] };
  }
  const tools: ToolDef[] = [
    defineTool({
      name: 'listResearchCatalog', description: prompts.catalogTool,
      schema: { type: 'object', properties: {
        filepath: { type: 'string', description: '文件概览中返回的相对路径；省略时列文件' },
        offset: { type: 'integer', minimum: 0, description: '目录分页起点，默认 0' },
      } },
      func: async args => toolSuccess(listing(await load(), args.filepath as string | undefined, args.offset as number | undefined)),
    }),
    defineTool({
      name: 'readChapterSummary', description: prompts.summaryTool,
      schema: { type: 'object', properties: {
        filepath: { type: 'string', minLength: 1 }, sectionId: { type: 'string', minLength: 1 },
      }, required: ['filepath', 'sectionId'] },
      func: async (args, signal) => {
        const latest = await load();
        const file = latest.files.find(entry => entry.path === args.filepath);
        const section = file?.sections.find(entry => entry.id === args.sectionId);
        if (!file || !section) { return toolError('section_missing', '章节已移除或目录变化，请重新查看目录。'); }
        const filepath = inside(root, file.path);
        const source = await fileSystem.readFile(filepath);
        signal?.throwIfAborted();
        if (!source.success) { return toolError('source_unavailable', '无法核对当前正文，请使用普通文件搜索定位。'); }
        const hash = contentHash(source.content || '');
        const positionsCurrent = hash === file.hash;
        let summary = '尚未生成摘要，可直接读取正文；本工具不自动生成。';
        if (section.summary) {
          if (!section.summary.startsWith('summaries/') || !section.summary.endsWith('.md')) { throw new Error('摘要路径无效'); }
          try { summary = parseSummary(await readDerived(section.summary)).body; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } summary = '摘要文件缺失，可读取正文。'; }
        }
        if (summary.length > PAGE_CHARS) { return toolError('summary_too_large', '摘要异常过长，请从原文检索或手动重新生成摘要。'); }
        const status = !section.summary ? 'missing' : !section.generatedHash ? 'unverified'
          : positionsCurrent && !file.error && section.generatedHash === section.hash ? 'current' : 'stale';
        const read = positionsCurrent ? { filepath, offset: section.start,
          maxChars: Math.max(1, Math.min(6000, section.end - section.start)), expectedSha256: hash } : undefined;
        return toolSuccess([
          `【章节摘要，非原文证据｜${file.path}｜${section.title}｜状态 ${status}】`, summary,
          positionsCurrent ? `当前章节范围：${section.start}～${section.end}（末端不含）。readFile 参数：${JSON.stringify(read)}。分页只读至章节末端，每页保留 expectedSha256。`
            : '当前正文与目录版本不同，旧摘要仅供定位，旧字符范围已停用；请用 searchInFiles 定位当前章节，或手动刷新目录。',
          status === 'unverified' ? '手写摘要或来源版本未记录，尚未核对与正文的一致性。' : '',
          '摘要不能作为逐字引文；需要引用、核对细节或修改时读取原文。',
        ].join('\n\n'));
      },
    }),
  ];
  return { context, tools };
}
