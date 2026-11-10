import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { contentHash, mapSections, ResearchCatalogStore } from '../memory/research/catalog';
import { parseSummary, summaryFilename } from '../memory/research/summary-files';
import { ResearchCatalog, sectionStatus } from '../memory/research/types';
import { generateSummaries, GenerationProgress, splitSummaryInput, SummaryCall } from '../memory/research/summarizer';

suite('Research catalog generation', () => {
  let root: string;
  let store: ResearchCatalogStore;
  let catalog: ResearchCatalog;
  const progress = (): GenerationProgress => ({ completed: 0, total: 0, failed: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0, message: '' });
  const write = async (relative: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  };
  const run = async (call: SummaryCall, full = false, controller = new AbortController()) => {
    const state = progress();
    await generateSummaries(store, catalog, call, { sectionIds: full ? new Set(catalog.files.flatMap(file => file.sections.map(section => section.id))) : undefined, maxChars: 1000, signal: controller.signal, progress: state, report: () => undefined });
    return state;
  };
  setup(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), 'out', 'research-test-'));
    store = new ResearchCatalogStore(root, absolute => fs.readFile(absolute, 'utf8'));
    catalog = await store.load();
  });
  teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('Git ignore directories, negation and glob rules define scope; own output is always excluded', async () => {
    await write('.aiwriterignore', '/*\n!/小说/\n/小说/秘密*\n!/小说/秘密公开.md\n');
    await write('小说/正文.txt', '正文');
    await write('小说/秘密.md', '私密');
    await write('小说/秘密公开.md', '公开');
    await write('其他.md', '其他');
    await write('小说/.aiwriter/test.md', '生成产物');
    await store.scan(catalog);
    assert.deepStrictEqual(catalog.files.map(f => f.path).sort(), ['小说/正文.txt', '小说/秘密公开.md'].sort());
  });

  test('chapter mapping preserves all source characters including CRLF and reuses shifted chapters', () => {
    const source = '前言\r\n第一章 起点\r\n你好\r\n第二章 终点\r\n再见';
    const original = mapSections(source);
    assert.strictEqual(original.map(s => source.slice(s.start, s.end)).join(''), source);
    original.forEach(s => { s.generatedHash = s.hash; });
    const changed = mapSections(source.replace('你好', '很长的新增正文'), original);
    assert.strictEqual(changed[2].id, original[2].id);
    assert.strictEqual(sectionStatus(changed[2]), 'current');
    assert.strictEqual(sectionStatus(changed[1]), 'stale');
  });

  test('default generation preserves existing summaries even when source changes', async () => {
    await write('稿件.md', '# 第一章\n原文一\n# 第二章\n原文二');
    await store.scan(catalog);
    const calls: string[] = [];
    const call: SummaryCall = async text => { calls.push(text); return '章节说明\n事件与变化。'; };
    await run(call);
    const second = { ...catalog.files[0].sections[1] };
    await write('稿件.md', '# 第一章\n更长的新原文一\n# 第二章\n原文二');
    await store.scan(catalog);
    calls.length = 0;
    await run(call);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(catalog.files[0].sections[1].summary, second.summary);
    await store.scan(catalog);
    assert.strictEqual((await fs.readdir(path.join(store.directory, 'summaries', '稿件.md'))).length, 2);
  });

  test('new and deleted files update catalog without model calls', async () => {
    await write('设定.md', '世界设定');
    await store.scan(catalog);
    assert.strictEqual(sectionStatus(catalog.files[0].sections[0]), 'pending');
    await fs.unlink(path.join(root, '设定.md'));
    await write('时间线.txt', '第一天');
    await store.scan(catalog);
    assert.deepStrictEqual(catalog.files.map(f => f.path), ['时间线.txt']);
  });

  test('failed regeneration retains the old summary and exposes stale state', async () => {
    await write('稿件.md', '原文');
    await store.scan(catalog);
    await run(async () => '旧摘要');
    const old = catalog.files[0].sections[0].summary!;
    await write('稿件.md', '修改后的原文');
    await store.scan(catalog);
    const state = await run(async () => { throw new Error('模型不可用'); }, true);
    assert.strictEqual(state.failed, 1);
    assert.strictEqual(catalog.files[0].sections[0].summary, old);
    assert.strictEqual(sectionStatus(catalog.files[0].sections[0]), 'stale');
    assert.strictEqual(parseSummary(await fs.readFile(path.join(store.directory, old), 'utf8')).body, '旧摘要');
  });

  test('source edit during a model call never commits a fresh-looking summary', async () => {
    await write('稿件.md', '旧文');
    await store.scan(catalog);
    await run(async () => { await write('稿件.md', '新文'); return '过期结果'; });
    assert.strictEqual(catalog.files[0].sections[0].generatedHash, undefined);
    await store.scan(catalog);
    assert.strictEqual(catalog.files[0].hash, contentHash('新文'));
  });

  test('cancelled selected updates never leave a persistent pending-work registry', async () => {
    await write('稿件.md', '# 一\n内容\n# 二\n内容');
    await store.scan(catalog);
    await run(async () => '旧摘要');
    const abort = new AbortController();
    let calls = 0;
    await assert.rejects(run(async () => {
      if (++calls === 2) { abort.abort(); abort.signal.throwIfAborted(); }
      return '新摘要';
    }, true, abort));
    catalog = await store.load();
    await store.scan(catalog);
    assert.ok(catalog.files[0].sections.every(section => section.summary));
    calls = 0;
    await run(async () => { calls++; return '不应覆盖'; });
    assert.strictEqual(calls, 0);
    const saved = await fs.readFile(store.catalogPath, 'utf8');
    assert.ok(!/generatedHash|needsRefresh|updatedAt/.test(saved));
  });

  test('large sections are completely covered before merging', async () => {
    const source = '第一段。\n'.repeat(600);
    assert.strictEqual(splitSummaryInput(source, 1000).join(''), source);
    await write('稿件.txt', source);
    await store.scan(catalog);
    let parts = 0;
    let merges = 0;
    await run(async (_text, merge) => { if (merge) { merges++; } else { parts++; } return '简要摘要'; });
    assert.ok(parts > 1);
    assert.strictEqual(merges, 1);
    assert.strictEqual(sectionStatus(catalog.files[0].sections[0]), 'current');
  });

  test('unreadable file preserves existing evidence with a visible file error', async () => {
    await write('稿件.md', '原文');
    await store.scan(catalog);
    await run(async () => '摘要');
    const broken = new ResearchCatalogStore(root, async () => { throw new Error('编码错误'); });
    await broken.scan(catalog, undefined, { force: true });
    assert.match(catalog.files[0].error!, /编码错误/);
    assert.ok(catalog.files[0].sections[0].summary);
  });

  test('deleted generated summary is scheduled for regeneration', async () => {
    await write('稿件.md', '原文');
    await store.scan(catalog);
    await run(async () => '摘要');
    await fs.unlink(path.join(store.directory, catalog.files[0].sections[0].summary!));
    await store.scan(catalog);
    assert.strictEqual(catalog.files[0].sections[0].summary, undefined);
    let calls = 0;
    await run(async () => { calls++; return '恢复摘要'; });
    assert.strictEqual(calls, 1);
  });

  test('authentication failure stops the batch instead of calling every remaining chapter', async () => {
    await write('稿件.md', '# 一\n内容\n# 二\n内容');
    await store.scan(catalog);
    let calls = 0;
    await assert.rejects(run(async () => { calls++; throw Object.assign(new Error('Unauthorized'), { status: 401 }); }));
    assert.strictEqual(calls, 1);
    const persisted = await store.load();
    assert.strictEqual(persisted.files[0].sections[0].error, undefined);
    assert.strictEqual(sectionStatus(persisted.files[0].sections[1]), 'pending');
  });

  test('unchanged scan reads no source and does not rewrite the catalog; one edit reads one file', async () => {
    const reads: string[] = [];
    store = new ResearchCatalogStore(root, async file => { reads.push(path.basename(file)); return fs.readFile(file, 'utf8'); });
    for (let i = 0; i < 20; i++) { await write(`${i}.md`, '# 章\n正文'); }
    await store.scan(catalog);
    assert.strictEqual(reads.length, 20);
    const saved = await fs.stat(store.catalogPath);
    reads.length = 0;
    await store.scan(catalog);
    assert.deepStrictEqual(reads, []);
    assert.strictEqual((await fs.stat(store.catalogPath)).mtimeMs, saved.mtimeMs);
    await write('3.md', '# 章\n新正文');
    await store.scan(catalog);
    assert.deepStrictEqual(reads, ['3.md']);
  });

  test('watcher invalidation and manual verification bypass metadata reuse', async () => {
    let reads = 0;
    store = new ResearchCatalogStore(root, async file => { reads++; return fs.readFile(file, 'utf8'); });
    await write('小说/a.md', '正文');
    await write('设定.md', '设定');
    await store.scan(catalog);
    reads = 0;
    await store.scan(catalog, undefined, { changedPaths: new Set(['小说']) });
    assert.strictEqual(reads, 1);
    reads = 0;
    await store.scan(catalog, undefined, { force: true });
    assert.strictEqual(reads, 2);
  });

  test('dirty editor cannot reuse a saved entry; changed editor version is re-read', async () => {
    let reads = 0;
    const editor = { version: 1, dirty: false };
    store = new ResearchCatalogStore(root, async file => { reads++; return fs.readFile(file, 'utf8'); }, () => editor);
    await write('稿件.md', '正文');
    await store.scan(catalog);
    editor.dirty = true;
    await store.scan(catalog);
    assert.match(catalog.files[0].error!, /未保存/);
    assert.strictEqual(reads, 1);
    editor.dirty = false;
    editor.version++;
    await store.scan(catalog);
    assert.strictEqual(catalog.files[0].error, undefined);
    assert.strictEqual(reads, 2);
    editor.version++;
    await store.scan(catalog);
    assert.strictEqual(reads, 3);
  });

  test('ignore changes and deleted files are reconciled even when sources are cached', async () => {
    await write('稿件.md', '正文');
    await write('设定.md', '设定');
    await store.scan(catalog);
    await write('.aiwriterignore', '设定.md');
    await store.scan(catalog);
    assert.deepStrictEqual(catalog.files.map(file => file.path), ['稿件.md']);
    await fs.unlink(path.join(root, '稿件.md'));
    await store.scan(catalog);
    assert.strictEqual(catalog.files.length, 0);
  });

  test('changes during reading are not cached as valid', async () => {
    await write('稿件.md', '旧文');
    store = new ResearchCatalogStore(root, async file => {
      const text = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, '读取过程中发生修改');
      return text;
    });
    await store.scan(catalog);
    assert.match(catalog.files[0].error!, /读取期间/);
    assert.strictEqual(catalog.files[0].sourceStamp, undefined);
  });

  test('empty workspace still persists the catalog so later file events can synchronize it', async () => {
    await store.scan(catalog);
    await fs.access(store.catalogPath);
    await write('新增.md', '新增正文');
    await store.scan(catalog);
    assert.strictEqual(catalog.files.length, 1);
  });
  test('handwritten summaries and edits are recognized from Markdown; unknown files survive scanning', async () => {
    await write('稿件.md', '# 第一章 大学\n原文');
    await store.scan(catalog);
    const file = catalog.files[0];
    const section = file.sections[0];
    const relative = summaryFilename(file, section);
    assert.strictEqual(relative, 'summaries/稿件.md/第一章 大学.md');
    await write('.aiwriter/research/' + relative, '作者手写摘要\n事件');
    await write('.aiwriter/research/summaries/随手笔记.md', '保留我');
    await store.scan(catalog);
    assert.strictEqual(section.summary, relative);
    assert.strictEqual(section.generatedHash, undefined);
    await run(async () => { throw new Error('不应调用模型'); });
    await write('.aiwriter/research/' + relative, '手动修订后的摘要');
    await store.scan(catalog);
    assert.strictEqual(section.description, '手动修订后的摘要');
    assert.strictEqual(await fs.readFile(path.join(store.directory, 'summaries/随手笔记.md'), 'utf8'), '保留我');
  });

  test('source links survive summary rename and a rebuilt catalog', async () => {
    await write('稿件.md', '# 第一章\n原文');
    await store.scan(catalog);
    await run(async () => '作者可编辑的摘要');
    const section = catalog.files[0].sections[0];
    const renamed = 'summaries/我重命名的摘要.md';
    await fs.rename(path.join(store.directory, section.summary!), path.join(store.directory, renamed));
    await fs.unlink(store.catalogPath);
    catalog = await store.load();
    await store.scan(catalog);
    assert.strictEqual(catalog.files[0].sections[0].summary, renamed);
    assert.strictEqual(sectionStatus(catalog.files[0].sections[0]), 'current');
  });

  test('legacy summaries migrate to readable Markdown with a backup and no model calls', async () => {
    await write('稿件.md', '# 第一章\n原文');
    await store.scan(catalog);
    const file = catalog.files[0];
    const section = file.sections[0];
    const legacy = `summaries/${section.id}-${section.hash}.md`;
    await write('.aiwriter/research/' + legacy, '原有摘要');
    section.summary = legacy;
    section.generatedHash = section.hash;
    await fs.writeFile(store.catalogPath, JSON.stringify(catalog));
    await store.scan(catalog);
    assert.strictEqual(section.summary, 'summaries/稿件.md/第一章.md');
    const text = await fs.readFile(path.join(store.directory, section.summary!), 'utf8');
    assert.strictEqual(parseSummary(text).body, '原有摘要');
    assert.strictEqual(parseSummary(text).metadata?.source_sha256, section.hash);
    assert.strictEqual(await fs.readFile(path.join(store.directory, 'legacy-summaries', path.basename(legacy)), 'utf8'), '原有摘要');
  });

  test('generation never replaces an author edit made while the model is running', async () => {
    await write('稿件.md', '原文');
    await store.scan(catalog);
    await run(async () => '已有摘要');
    const target = path.join(store.directory, catalog.files[0].sections[0].summary!);
    const state = await run(async () => { await fs.writeFile(target, '作者刚写的内容'); return '模型新摘要'; }, true);
    assert.strictEqual(state.failed, 1);
    assert.strictEqual(await fs.readFile(target, 'utf8'), '作者刚写的内容');
  });

  test('duplicate chapter titles use distinct readable files and bindings', async () => {
    await write('稿件.md', '# 同名章\n第一处\n# 同名章\n第二处');
    await store.scan(catalog);
    await run(async text => text.includes('第二处') ? '第二摘要' : '第一摘要');
    await store.scan(catalog);
    const sections = catalog.files[0].sections;
    assert.notStrictEqual(sections[0].summary, sections[1].summary);
    assert.strictEqual(sections[0].description, '第一摘要');
    assert.strictEqual(sections[1].description, '第二摘要');
  });

});
