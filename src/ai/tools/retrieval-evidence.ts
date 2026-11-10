import { utf8Prefix } from './search-context';

export interface EvidencePiece {
  filepath: string;
  version: string;
  start: number;
  end: number;
  content: string;
  chunkId?: string;
  id?: string;
}

/** Full delivered source text survives eviction from an individual agent's input. */
export class EvidenceCache {
  readonly records: EvidencePiece[] = [];
  store(record: EvidencePiece): void {
    if (!record.id) { return; }
    const index = this.records.findIndex(item => item.id === record.id);
    if (index >= 0) {
      if (record.content.length > this.records[index].content.length) { this.records[index] = { ...record }; }
    }
    else { this.records.push({ ...record }); }
  }
}

/** Per-agent visibility, never shared across requests. Only actually returned text is recorded. */
export class EvidenceLedger {
  readonly records: EvidencePiece[];
  added = 0;
  duplicates = 0;
  private nextId = 1;
  constructor(records: EvidencePiece[] = [], private readonly idPrefix = 'E', readonly cache = new EvidenceCache()) {
    this.records = [...records];
    records.forEach(record => cache.store(record));
  }
  find(id: string): EvidencePiece | undefined { return this.records.find(item => item.id === id); }
  /** Match source bodies, not merely IDs mentioned in planning or tool arguments. */
  visibleIn(text: string, candidates = this.records): EvidencePiece[] {
    return candidates.flatMap(record => {
      if (!record.id) { return []; }
      const marker = `[${record.id}｜${record.filepath}｜字符 ${record.start}～`;
      const start = text.indexOf(marker);
      if (start < 0) { return []; }
      const lineEnd = text.indexOf('\n', start);
      if (lineEnd < 0) { return []; }
      const headerTail = text.slice(start + marker.length, lineEnd);
      if (!headerTail.endsWith(`｜版本 ${record.version}]`)) { return []; }
      const declaredEnd = Number(headerTail.split('｜')[0]);
      if (!Number.isSafeInteger(declaredEnd) || declaredEnd <= record.start || declaredEnd > record.end) { return []; }
      const body = text.slice(lineEnd + 1, lineEnd + 1 + declaredEnd - record.start);
      let chars = 0;
      while (chars < record.content.length && chars < body.length && record.content[chars] === body[chars]) { chars++; }
      return chars ? [{ ...record, content: record.content.slice(0, chars), end: record.start + chars }] : [];
    });
  }
  retainVisible(text: string): void {
    const visible = this.visibleIn(text, this.cache.records);
    this.records.splice(0, this.records.length, ...visible);
  }
  importVisible(records: EvidencePiece[], text: string): EvidencePiece[] {
    const visible = new EvidenceLedger(records).visibleIn(text);
    for (const record of visible) {
      if (!this.find(record.id!)) { this.records.push(record); }
      this.cache.store(record);
    }
    return visible;
  }
  fresh(piece: EvidencePiece): EvidencePiece[] {
    let ranges = [[piece.start, piece.end]];
    for (const old of this.records) {
      if (old.filepath !== piece.filepath || old.version !== piece.version) { continue; }
      ranges = ranges.flatMap(([start, end]) => old.end <= start || old.start >= end ? [[start, end]]
        : [[start, Math.min(end, old.start)], [Math.max(start, old.end), end]].filter(([a, b]) => b > a));
    }
    return ranges.map(([start, end]) => ({ ...piece, start, end, content: piece.content.slice(start - piece.start, end - piece.start) }))
      .filter(item => item.content.trim().length > 0);
  }
  deliver(pieces: EvidencePiece[], budget = 6000, byteBudget = Number.MAX_SAFE_INTEGER): string {
    const output: string[] = [];
    const covered = new Set<string>();
    let remaining = budget;
    let remainingBytes = byteBudget - 512;
    let truncated = false;
    for (const piece of pieces) {
      const fresh = this.fresh(piece);
      if (!fresh.length) {
        this.duplicates++;
        for (const old of this.records) {
          if (old.filepath === piece.filepath && old.version === piece.version && old.start < piece.end && old.end > piece.start && old.id) { covered.add(old.id); }
        }
      }
      for (const part of fresh) {
        if (remaining <= 0) { break; }
        let id: string;
        do { id = `${this.idPrefix}${this.nextId++}`; } while (this.cache.records.some(item => item.id === id));
        const headerReserve = Buffer.byteLength(`[${id}｜${part.filepath}｜字符 ${part.start}～${part.end}｜版本 ${part.version}]\n\n`, 'utf8');
        const content = utf8Prefix(part.content.slice(0, remaining), Math.max(0, remainingBytes - headerReserve));
        if (content.length < part.content.length) { truncated = true; }
        if (!content) { continue; }
        const record = { ...part, content, end: part.start + content.length, id };
        this.records.push(record);
        this.cache.store(record);
        this.added++;
        remaining -= content.length;
        remainingBytes -= headerReserve + Buffer.byteLength(content, 'utf8');
        output.push(`[${record.id}｜${record.filepath}｜字符 ${record.start}～${record.end}｜版本 ${record.version}]\n${content}`);
      }
    }
    if (covered.size) { output.push(utf8Prefix(`此前证据已覆盖：${[...covered].join(', ')}；无需重复搜索同一资料。`, Math.max(0, remainingBytes))); }
    if (truncated && byteBudget !== Number.MAX_SAFE_INTEGER) { output.push('结果达到大小上限，部分正文未返回；仅在仍缺必要证据时缩小范围补查。'); }
    return output.length ? output.join('\n\n') : '无新增有效证据。不要为凑数量扩大到不相关内容；请回答已有结论，或针对明确缺口改换检索方式。';
  }
}
