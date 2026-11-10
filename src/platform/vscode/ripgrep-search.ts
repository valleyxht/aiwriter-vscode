import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';

/** Native search is a candidate filter only; editor decoding and evidence offsets stay authoritative. */
export async function ripgrepCandidates(files: string[], query: string): Promise<Set<string>> {
  const { rgPath } = await import('@vscode/ripgrep');
  const hits = new Set<string>();
  // Bound Windows command-line size. Explicit file arguments preserve the caller's glob/ignore scope.
  const batches: string[][] = [];
  let current: string[] = [];
  let length = query.length + 512;
  for (const file of files) {
    if (current.length && length + file.length + 3 > 24000) { batches.push(current); current = []; length = query.length + 512; }
    current.push(file); length += file.length + 3;
  }
  if (current.length) { batches.push(current); }
  for (const batch of batches) {
    // auto handles UTF-8 and BOM-marked UTF-16; the second pass covers existing GBK/GB18030 manuscripts.
    const outputs = await Promise.all(['auto', 'gb18030'].map(encoding => new Promise<string>((resolve, reject) => {
      execFile(rgPath, ['--no-config', '--text', '--files-with-matches', '--null', '--fixed-strings',
        '--encoding', encoding, '--regexp', query, '--', ...batch],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error && (error as { code?: string | number }).code !== 1) { reject(error); }
        else { resolve(stdout); }
      });
    })));
    for (const output of outputs) {
      for (const file of output.split('\0')) { if (file) { hits.add(path.resolve(file)); } }
    }
  }
  return hits;
}

export async function selectSearchCandidates(
  files: string[], query: string, editorPaths: ReadonlySet<string>,
  nativeSearch = ripgrepCandidates,
): Promise<{ files: string[]; backend: string }> {
  // Process startup costs dominate small scopes; keep their direct search path.
  const disk = files.filter(file => !editorPaths.has(file));
  if (disk.length < 8 || /[\r\n]/.test(query) || query.length > 8000) { return { files, backend: 'direct' }; }
  try {
    const sizes = await Promise.all(disk.map(file => stat(file)));
    if (sizes.reduce((total, file) => total + file.size, 0) < 8 * 1024 * 1024) {
      return { files, backend: 'direct' };
    }
    const hits = await nativeSearch(disk, query);
    return { files: files.filter(file => editorPaths.has(file) || hits.has(path.resolve(file))), backend: 'ripgrep' };
  } catch (error) {
    console.warn('[Search] ripgrep unavailable; using document search:', (error as Error).message);
    return { files, backend: 'direct-fallback' };
  }
}
