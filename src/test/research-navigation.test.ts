import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createResearchNavigation } from '../memory/research/navigation';
import { contentHash } from '../memory/research/catalog';
import { ResearchCatalog } from '../memory/research/types';
import { createReadOnlyFileTools } from '../ai/tools/tools';
import { normalizeToolEvidence } from '../ai/runtime/evidence-normalizer';
import { createSpecialistTools } from '../workers/specialists';
import { DEFAULT_AI_CONFIG } from '../types';
import { AIMessage } from '../ai/messages';

suite('Lazy research navigation', () => {
  let root: string;
  let directory: string;
  let source: string;
  let reads: number;
  let catalog: ResearchCatalog;
  const fileSystem: any = { readFile: async () => { reads++; return { success: true, content: source }; } };
  const save = () => fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog));
  setup(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), 'out', 'navigation-test-'));
    directory = path.join(root, '.aiwriter', 'research');
    await fs.mkdir(path.join(directory, 'summaries'), { recursive: true });
    source = '第一章 原文细节'; reads = 0;
    const hash = contentHash(source);
    const summary = `summaries/11111111-1111-1111-1111-111111111111-${hash}.md`;
    catalog = { version: 1, files: [{ path: 'novel.md', hash, sections: [{
      id: 'chapter-1', title: '第一章', start: 0, end: source.length, hash, generatedHash: hash,
      description: '简短导航', summary,
    }] }] };
    await fs.writeFile(path.join(directory, summary), '简短导航\n只有选中后才出现的摘要正文');
    await save();
  });
  teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('initial context is metadata only; selected summary returns versioned original coordinates', async () => {
    const navigation = await createResearchNavigation(root, fileSystem);
    assert.match(navigation.context!, /novel.md/);
    assert.ok(!navigation.context!.includes('摘要正文') && !navigation.context!.includes(source));
    assert.equal(reads, 0);
    const result = await navigation.tools[1].func({ filepath: 'novel.md', sectionId: 'chapter-1' });
    assert.equal(result.status, 'success');
    assert.match(result.content, /只有选中后才出现/);
    assert.match(result.content, /expectedSha256/);
    assert.equal(reads, 1);
    assert.equal(normalizeToolEvidence([{ toolName: 'readChapterSummary', args: {}, content: result.content }])[0].sourceType, 'navigation');
  });

  test('chapter pages have explicit continuation and never load original text', async () => {
    const section = catalog.files[0].sections[0];
    catalog.files[0].sections = Array.from({ length: 35 }, (_, i) => ({ ...section, id: `chapter-${i}`, title: `章节${i}` }));
    await save();
    const navigation = await createResearchNavigation(root, fileSystem);
    const first = await navigation.tools[0].func({ filepath: 'novel.md' });
    assert.match(first.content, /offset=30/);
    assert.ok(!first.content.includes('章节30'));
    const last = await navigation.tools[0].func({ filepath: 'novel.md', offset: 30 });
    assert.match(last.content, /章节34/);
    assert.match(last.content, /已展示完毕/);
    assert.equal(reads, 0);
  });

  test('source edits retain stale navigation but never offer obsolete coordinates', async () => {
    const navigation = await createResearchNavigation(root, fileSystem);
    source = '插入前言' + source;
    const result = await navigation.tools[1].func({ filepath: 'novel.md', sectionId: 'chapter-1' });
    assert.match(result.content, /stale/);
    assert.match(result.content, /旧字符范围已停用/);
    assert.ok(!result.content.includes('expectedSha256'));
  });

  test('versioned original reads reject changes between summary and read', async () => {
    const read = createReadOnlyFileTools(fileSystem).find(tool => tool.name === 'readFile')!;
    const args = { filepath: 'novel.md', offset: 0, expectedSha256: contentHash(source) };
    assert.equal((await read.func(args)).status, 'success');
    source += '后续修改';
    assert.equal((await read.func(args)).code, 'source_changed');
  });

  test('missing or invalid catalog leaves ordinary retrieval available', async () => {
    await fs.unlink(path.join(directory, 'catalog.json'));
    assert.deepEqual(await createResearchNavigation(root, fileSystem), { tools: [] });
    catalog.files[0].path = '../outside.md';
    await save();
    const result = await createResearchNavigation(root, fileSystem);
    assert.equal(result.tools.length, 0);
    assert.match(result.context!, /现有文件搜索/);
  });

  test('missing summary keeps original access and rejects unknown sections', async () => {
    await fs.unlink(path.join(directory, catalog.files[0].sections[0].summary!));
    const navigation = await createResearchNavigation(root, fileSystem);
    const result = await navigation.tools[1].func({ filepath: 'novel.md', sectionId: 'chapter-1' });
    assert.match(result.content, /尚未生成摘要/);
    assert.match(result.content, /expectedSha256/);
    assert.equal((await navigation.tools[1].func({ filepath: 'novel.md', sectionId: 'missing' })).code, 'section_missing');
  });

  test('only researcher receives navigation; parent receives only final packet', async () => {
    const tools = createSpecialistTools({ parserConfig: DEFAULT_AI_CONFIG, reviewConfig: DEFAULT_AI_CONFIG,
      fileSystem, approver: { confirmFileWrite: async () => true },
      agentFactory: ((...args: any[]) => {
        const options = args[12];
        const research = options.operation === 'specialist.researchWorkspace';
        assert.equal(!!options.referenceContext, research);
        assert.equal(options.tools.some((tool: any) => tool.name === 'readChapterSummary'), research);
        return { invoke: async (input: any) => {
          assert.equal(input.collectedTexts, '用户提供的上下文');
          assert.ok(!String(input.messages[0].content).includes('简短导航'));
          return { messages: [new AIMessage('仅最终资料包')] };
        } };
      }) as any,
    });
    for (const name of ['researchWorkspace', 'decomposeScene', 'reviewWriting']) {
      const result = await tools.find(tool => tool.name === name)!.func({ task: '理解章节' }, undefined, {
        agentInput: { workspacePath: root, originalRequest: '分析作品', suppliedContext: '用户提供的上下文' },
      });
      assert.equal(result.status, 'success');
      assert.equal(result.content, '仅最终资料包');
    }
  });
});
