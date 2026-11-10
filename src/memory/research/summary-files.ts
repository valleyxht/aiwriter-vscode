import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ResearchFile, ResearchSection } from './types';

export interface SummaryMetadata {
  source: string;
  chapter: string;
  section_id?: string;
  occurrence?: number;
  source_sha256?: string;
}
export interface SummaryDocument { relative: string; text: string; body: string; metadata?: SummaryMetadata }

function readablePart(value: string): string {
  const clean = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || '未命名';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean);
  const clipped = Array.from(clean).slice(0, 60).join('');
  return reserved || clean !== value || clipped !== clean
    ? `${clipped}-${createHash('sha256').update(value).digest('hex').slice(0, 6)}` : clean;
}

/** Relative to research/. Keep the source extension to distinguish .md from .txt. */
export function summaryFilename(file: ResearchFile, section: ResearchSection): string {
  const title = section.title.replace(/^#{1,3}\s*/, '').trim();
  const siblings = file.sections.filter(item => item.title.replace(/^#{1,3}\s*/, '').trim().toLowerCase() === title.toLowerCase());
  const suffix = siblings.length > 1 ? `（${siblings.indexOf(section) + 1}）` : '';
  return ['summaries', ...file.path.split('/').map(readablePart), `${readablePart(title)}${suffix}.md`].join('/');
}

export function parseSummary(text: string): { body: string; metadata?: SummaryMetadata } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || !/^aiwriter_summary: 1$/m.test(match[1].replace(/\r/g, ''))) { return { body: text }; }
  const fields: Record<string, unknown> = {};
  try {
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^(source|chapter|section_id|occurrence|source_sha256): (.+)$/.exec(line);
      if (field) { fields[field[1]] = JSON.parse(field[2]); }
    }
    if (typeof fields.source !== 'string' || typeof fields.chapter !== 'string'
      || (fields.section_id !== undefined && typeof fields.section_id !== 'string')
      || (fields.occurrence !== undefined && (!Number.isInteger(fields.occurrence) || Number(fields.occurrence) < 1))
      || (fields.source_sha256 !== undefined && (typeof fields.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fields.source_sha256)))) {
      return { body: text };
    }
    return { body: text.slice(match[0].length).replace(/^\r?\n/, ''), metadata: fields as unknown as SummaryMetadata };
  } catch { return { body: text }; }
}

export function formatSummary(file: ResearchFile, section: ResearchSection, body: string, sourceHash = section.hash): string {
  const metadata: SummaryMetadata = { source: file.path, chapter: section.title, section_id: section.id,
    occurrence: file.sections.filter(item => item.title === section.title).indexOf(section) + 1,
    ...(/^[0-9a-f]{64}$/.test(sourceHash) ? { source_sha256: sourceHash } : {}) };
  return `---\naiwriter_summary: 1\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}`;
}

/** Only regular Markdown files are considered. User files are never garbage collected. */
export async function discoverSummaries(directory: string): Promise<SummaryDocument[]> {
  const result: SummaryDocument[] = [];
  const walk = async (relative: string): Promise<void> => {
    // Never traverse a linked summaries root or linked subdirectory.
    try { if (!(await fs.lstat(path.join(directory, relative))).isDirectory()) { return; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    let entries;
    try { entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { await walk(child); }
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const text = await fs.readFile(path.join(directory, child), 'utf8');
        result.push({ relative: child, text, ...parseSummary(text) });
      }
    }
  };
  await walk('summaries');
  return result;
}

export function findSummary(documents: SummaryDocument[], file: ResearchFile, section: ResearchSection): SummaryDocument | undefined {
  const occurrence = file.sections.filter(item => item.title === section.title).indexOf(section) + 1;
  const linked = documents.find(doc => doc.metadata?.source === file.path && doc.metadata.section_id === section.id)
    || documents.find(doc => doc.metadata?.source === file.path && doc.metadata.chapter === section.title
      && (doc.metadata.occurrence || 1) === occurrence);
  if (linked) { return linked; }
  // Headerless hand-written summaries are recognized by their readable location.
  return documents.find(doc => doc.relative === summaryFilename(file, section) && !doc.metadata);
}

export function applySummary(section: ResearchSection, document?: SummaryDocument): void {
  delete section.summary; delete section.description; delete section.generatedHash;
  delete section.error; delete section.needsRefresh; delete section.updatedAt;
  if (!document) { return; }
  section.summary = document.relative;
  section.description = document.body.split(/\r?\n/).find(line => line.trim())?.slice(0, 160);
  section.generatedHash = document.metadata?.source_sha256;
}
