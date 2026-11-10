export interface ResearchSection {
  id: string;
  title: string;
  start: number;
  end: number;
  hash: string;
  generatedHash?: string;
  description?: string;
  summary?: string;
  updatedAt?: string;
  error?: string;
  needsRefresh?: boolean;
}

export interface ResearchFile {
  path: string;
  hash: string;
  sections: ResearchSection[];
  error?: string;
  /** Cheap disk identity for reuse; old catalogs without it are refreshed once. */
  sourceStamp?: string;
  editorVersion?: number;
}

export interface ResearchCatalog {
  version: 1;
  files: ResearchFile[];
}

export function sectionStatus(section: ResearchSection): 'pending' | 'current' | 'stale' {
  return !section.generatedHash ? 'pending' : !section.needsRefresh && section.generatedHash === section.hash ? 'current' : 'stale';
}
