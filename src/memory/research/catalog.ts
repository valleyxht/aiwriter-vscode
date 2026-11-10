import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ignore from 'ignore';
import { ResearchCatalog, ResearchFile, ResearchSection } from './types';
import { applySummary, discoverSummaries, findSummary, formatSummary, parseSummary, summaryFilename } from './summary-files';

export const IGNORE_FILE = '.aiwriterignore';
export const DEFAULT_IGNORE = '# AI Writer 资料目录范围（Git ignore 语法）\n# 支持目录、*、** 和 ! 例外；仅处理 .md、.txt 文件。\n# 示例：\n# 草稿废弃/\n# **/私人笔记.md\n# 排除全部后只收录小说目录：\n# /*\n# !/小说/\n';
const INTERNAL = new Set(['.git', '.aiwriter', 'node_modules', '.vscode']);
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

interface ScanOptions {
  force?: boolean;
  changedPaths?: ReadonlySet<string>;
}

function diskStamp(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

/** Offsets include headings and cover every source character; hashes are independent of position. */
export function mapSections(text: string, previous: ResearchSection[] = []): ResearchSection[] {
  const headings = [...text.matchAll(/^(?:[ \t]*#{1,3}[ \t]+[^\r\n]+|[ \t]*第[ \t]*[0-9零〇一二三四五六七八九十百千万两]+[ \t]*[章回节卷篇][^\r\n]*|[ \t]*Chapter[ \t]+\d+[^\r\n]*)/gim)];
  const boundaries = headings.map(m => ({ start: m.index!, title: m[0].trim() }));
  if (!boundaries.length || boundaries[0].start !== 0) { boundaries.unshift({ start: 0, title: headings.length ? '序文' : '全文' }); }
  const unused = new Set(previous);
  return boundaries.map((entry, index) => {
    const end = boundaries[index + 1]?.start ?? text.length;
    const hash = contentHash(text.slice(entry.start, end));
    const old = [...unused].find(s => s.hash === hash) || [...unused].find(s => s.title === entry.title);
    if (old) { unused.delete(old); }
    return { ...old, id: old?.id || randomUUID(), title: entry.title, start: entry.start, end, hash };
  });
}

export class ResearchCatalogStore {
  readonly directory: string;
  readonly catalogPath: string;
  constructor(
    readonly root: string,
    private readonly read: (absolutePath: string) => Promise<string>,
    private readonly editorState: (absolutePath: string) => { version: number; dirty: boolean } | undefined = () => undefined,
  ) {
    this.directory = path.join(root, '.aiwriter', 'research');
    this.catalogPath = path.join(this.directory, 'catalog.json');
  }

  async load(): Promise<ResearchCatalog> {
    try {
      const catalog = JSON.parse(await fs.readFile(this.catalogPath, 'utf8')) as ResearchCatalog;
      if (catalog.version !== 1 || !Array.isArray(catalog.files)) { throw new Error('不支持的资料目录格式'); }
      return catalog;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1, files: [] }; }
      throw error;
    }
  }

  async save(catalog: ResearchCatalog): Promise<void> {
    // This is a disposable navigation index, not a generation-status registry.
    const index = { ...catalog, files: catalog.files.map(file => ({ ...file, sections: file.sections.map(section => {
      const { generatedHash, needsRefresh, error, updatedAt, ...entry } = section;
      return entry;
    }) })) };
    const text = JSON.stringify(index, null, 2);
    try { if (await fs.readFile(this.catalogPath, 'utf8') === text) { return; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    await this.writeAtomic(this.catalogPath, text);
  }

  async writeAtomic(target: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, target); break; }
        catch (error) {
          if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { throw error; }
          await delay(40 * (attempt + 1));
        }
      }
    }
    finally { await fs.rm(temporary, { force: true }); }
  }

  async rules(): Promise<ReturnType<typeof ignore>> {
    let text = '';
    try { text = await fs.readFile(path.join(this.root, IGNORE_FILE), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    return ignore().add(text);
  }

  async scan(catalog: ResearchCatalog, signal?: AbortSignal, options: ScanOptions = {}): Promise<void> {
    const before = JSON.stringify(catalog);
    const rules = await this.rules();
    const summaries = await discoverSummaries(this.directory);
    const previous = new Map(catalog.files.map(file => [file.path, file]));
    const files: ResearchCatalog['files'] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(this.root, directory), { withFileTypes: true })) {
        signal?.throwIfAborted();
        const relative = [directory, entry.name].filter(Boolean).join('/');
        if (entry.isSymbolicLink() || INTERNAL.has(entry.name) || rules.ignores(relative + (entry.isDirectory() ? '/' : ''))) { continue; }
        if (entry.isDirectory()) { await walk(relative); continue; }
        if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) { continue; }
        const old = previous.get(relative);
        try {
          const absolute = path.join(this.root, relative);
          const stamp = diskStamp(await fs.stat(absolute));
          const editor = this.editorState(absolute);
          if (editor?.dirty) { throw new Error('文件有未保存修改，请保存后更新摘要'); }
          const invalidated = options.force || [...(options.changedPaths || [])]
            .some(changed => relative === changed || relative.startsWith(changed + '/'));
          let file: ResearchFile;
          if (!old || old.error || invalidated || old.sourceStamp !== stamp || old.editorVersion !== editor?.version) {
            const text = await this.readSource(relative);
            const afterEditor = this.editorState(absolute);
            if (diskStamp(await fs.stat(absolute)) !== stamp || afterEditor?.dirty
              || (editor && editor.version !== afterEditor?.version)) {
              throw new Error('读取期间文件变化，请稍后刷新');
            }
            const hash = contentHash(text);
            file = { path: relative, hash, sourceStamp: stamp, editorVersion: afterEditor?.version,
              sections: old?.hash === hash ? old.sections : mapSections(text, old?.sections) };
          } else { file = old; }
          for (const section of file.sections) {
            let document = findSummary(summaries, file, section);
            // Upgrade old generated filenames once, preserving their content and source version.
            const legacy = section.summary;
            if (!document && legacy && /^summaries\/[0-9a-f-]{36}-[0-9a-f]{64}\.md$/.test(legacy)) {
              const oldDocument = summaries.find(item => item.relative === legacy);
              if (oldDocument) {
                const relative = summaryFilename(file, section);
                const target = path.join(this.directory, relative);
                await fs.mkdir(path.dirname(target), { recursive: true });
                const text = formatSummary(file, section, oldDocument.body, section.generatedHash || '');
                try { await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' }); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
                const saved = await fs.readFile(target, 'utf8');
                document = { relative, text: saved, ...parseSummary(saved) };
                // Keep the original as a backup; never delete authors' work during scanning.
                const backup = path.join(this.directory, 'legacy-summaries', path.basename(legacy));
                await fs.mkdir(path.dirname(backup), { recursive: true });
                try { await fs.copyFile(path.join(this.directory, legacy), backup, 1); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
                await fs.unlink(path.join(this.directory, legacy));
              }
            }
            applySummary(section, document);
          }
          files.push(file);
        } catch (error) {
          files.push({ path: relative, hash: old?.hash || '', sections: old?.sections || [], error: String(error) });
        }
      }
    };
    await walk('');
    catalog.files = files.sort((a, b) => a.path.localeCompare(b.path));
    signal?.throwIfAborted();
    let needsSave = JSON.stringify(catalog) !== before;
    if (!needsSave) {
      try { await fs.access(this.catalogPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } needsSave = true; }
    }
    if (needsSave) { await this.save(catalog); }
  }

  async summarySnapshot(relative: string): Promise<string | undefined> {
    const absolute = path.resolve(this.directory, relative);
    const inside = path.relative(path.join(this.directory, 'summaries'), absolute);
    if (path.isAbsolute(inside) || inside === '..' || inside.startsWith('..' + path.sep)) { throw new Error('摘要路径超出目录'); }
    if (this.editorState(absolute)?.dirty) { throw new Error('摘要有未保存修改，请先保存'); }
    try { return await fs.readFile(absolute, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
  }

  readSource(relative: string): Promise<string> {
    const absolute = path.resolve(this.root, relative);
    const check = path.relative(this.root, absolute);
    if (check.startsWith('..') || path.isAbsolute(check)) { throw new Error('资料路径超出工作区'); }
    return this.read(absolute);
  }
}
