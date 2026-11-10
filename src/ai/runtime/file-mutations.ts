export interface FileMutationEdit {
  kind: 'create' | 'append' | 'replace';
  startBefore: number;
  endBefore: number;
  startAfter: number;
  endAfter: number;
  insertedText: string;
}

export interface FileMutationSummary {
  tool: 'createNewFile' | 'modifyFile' | 'rememberWritingPreference';
  filepath?: string;
  mode: 'create' | 'atomic-append-or-replace' | 'managed-writing-preferences';
  changed: boolean;
  beforeExists?: boolean;
  afterExists?: boolean;
  beforeChars?: number;
  afterChars?: number;
  beforeSha256?: string;
  afterSha256?: string;
  edits?: FileMutationEdit[];
}

export function collectFileMutationSummaries(toolResults: unknown): FileMutationSummary[] {
    if (!Array.isArray(toolResults)) {
        return [];
    }

  return toolResults.flatMap((item): FileMutationSummary[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, any>;
    if (record.tool === 'reviewWriting' && Array.isArray(record.fileMutations)) {
      return collectFileMutationSummaries(record.fileMutations.map((mutation: FileMutationSummary) => ({ tool: mutation.tool, mutation })));
    }
    if (record.tool !== 'createNewFile' && record.tool !== 'modifyFile') {
      return [];
    }
    const mutation = record.mutation;
    if (!mutation || typeof mutation !== 'object' || mutation.changed !== true) {
      return [];
    }
    return [{
      tool: record.tool,
      filepath: typeof mutation.filepath === 'string' ? mutation.filepath : undefined,
      mode: record.tool === 'createNewFile' ? 'create' : 'atomic-append-or-replace',
      changed: true,
      beforeExists: mutation.beforeExists,
      afterExists: mutation.afterExists,
      beforeChars: mutation.beforeChars,
      afterChars: mutation.afterChars,
      beforeSha256: mutation.beforeSha256,
      afterSha256: mutation.afterSha256,
      ...(Array.isArray(mutation.edits) ? {
        edits: mutation.edits.filter((edit: unknown) => !!edit && typeof edit === 'object'),
      } : {}),
    }];
  });
}
