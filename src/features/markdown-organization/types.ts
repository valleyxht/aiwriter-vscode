import { AIConfig } from '../../types';

export const ORGANIZATION_DIRECTORIES = ['正文', '人物', '世界观', '大纲', '资料'] as const;

export type MarkdownMetadata = Record<string, unknown>;
export interface MarkdownHeading {
  level: number; line: number; text: string;
}
export interface MarkdownDocument {
  sourcePath: string; relativePath: string; sourceSha256: string; bytes: Uint8Array;
  text: string; metadata: MarkdownMetadata; headings: MarkdownHeading[]; lineCount: number;
}
export interface ExactRange { startByte: number; endByte: number; startLine: number; endLine: number; }
export interface OrganizationOperation {
  sourcePath: string; sourceRelativePath: string; sourceSha256: string;
  targetRelativePath: string; range: ExactRange;
}
export interface SkippedDocument { sourceRelativePath: string; reason: string; }
export interface OrganizationPlan {
  sourceRoot: string; outputDirectoryName: 'AIWriter整理结果';
  operations: OrganizationOperation[]; skipped: SkippedDocument[];
}
export interface OrganizationExecutionResult { created: string[]; skipped: SkippedDocument[]; }
export type AIConfigProvider = () => AIConfig;
