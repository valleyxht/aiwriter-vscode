import { ChunkQualityReport } from '../../types';

export function analyzeChunkQuality(contents: string[], targetChunkSize: number): ChunkQualityReport {
  const lengths = contents.map(content => content.length);
  const totalCharacters = lengths.reduce((sum, length) => sum + length, 0);
  const averageChunkSize = lengths.length > 0 ? totalCharacters / lengths.length : 0;
  const variance = lengths.length > 0
    ? lengths.reduce((sum, length) => sum + Math.pow(length - averageChunkSize, 2), 0) / lengths.length
    : 0;
  const smallThreshold = Math.min(100, Math.max(30, Math.floor(targetChunkSize * 0.1)));
  const oversizedThreshold = Math.max(targetChunkSize * 1.1, targetChunkSize + 50);
  const smallChunkCount = lengths.filter(length => length > 0 && length < smallThreshold).length;
  const oversizedChunkCount = lengths.filter(length => length > oversizedThreshold).length;
  const garbledChunkCount = contents.filter(content => {
    const replacements = (content.match(/\uFFFD/g) || []).length;
    return replacements > 0 && replacements / Math.max(1, content.length) > 0.005;
  }).length;
  const warnings: string[] = [];
  if (smallChunkCount > 0) {
    warnings.push(`${smallChunkCount} 个片段短于 ${smallThreshold} 字`);
  }
  if (oversizedChunkCount > 0) {
    warnings.push(`${oversizedChunkCount} 个片段超过建议大小`);
  }
  if (garbledChunkCount > 0) {
    warnings.push(`${garbledChunkCount} 个片段疑似包含乱码`);
  }
  if (lengths.length > 1 && Math.sqrt(variance) > averageChunkSize * 0.75) {
    warnings.push('片段大小分布差异较大');
  }
  return {
    totalChunks: lengths.length,
    totalCharacters,
    averageChunkSize,
    minChunkSize: lengths.length > 0 ? Math.min(...lengths) : 0,
    maxChunkSize: lengths.length > 0 ? Math.max(...lengths) : 0,
    chunkSizeStdDev: Math.sqrt(variance),
    smallChunkCount,
    oversizedChunkCount,
    garbledChunkCount,
    warnings,
  };
}
