import type { ExportJob, ExportSettings } from './types';

export const DEFAULT_CHUNK_SIZE = 8_000;
export const ASSUMED_EXPORT_LIMIT = 10_000;
const SYS_ID_SPACE = 16n ** 32n;

export function chunkCount(rows: number | null, size = DEFAULT_CHUNK_SIZE): number | null {
  if (rows === null || !Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(size) || size < 1) return null;
  return Math.ceil(rows / size);
}

export function normalizeFields(fields: string): string {
  if (!fields.trim()) return '';
  const names = fields.split(',').map(field => field.trim());
  if (names.some(field => !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field))) {
    throw new Error('Fields must be comma-separated field names or dot-walked names.');
  }
  return [...new Set(names)].join(',');
}

// Add the range to every top-level NQ branch, preserving nested related-list
// filters. End-query and outer sort directives must not bypass the new range.
export function constrainQuery(query: string, constraints: string[]): string {
  const branches: string[][] = [[]];
  let relatedDepth = 0;
  for (let token of query.split('^')) {
    if (!token) continue;
    if (relatedDepth === 0 && token.startsWith('NQ')) {
      branches.push([]);
      token = token.slice(2);
      if (!token) continue;
    }
    if (relatedDepth === 0 && (/^ORDERBY(?:DESC)?/.test(token) || token === 'EQ')) continue;
    branches[branches.length - 1].push(token);
    if (token.startsWith('RLQUERY')) relatedDepth++;
    if (token === 'ENDRLQUERY') relatedDepth--;
    if (relatedDepth < 0) throw new Error('The query contains an unmatched related-list filter.');
  }
  if (relatedDepth !== 0) throw new Error('The query contains an incomplete related-list filter.');
  return branches.map(branch => [...branch, ...constraints].join('^')).join('^NQ') +
    (branches.some(branch => branch.length) || constraints.length ? '^' : '') + 'ORDERBYsys_id';
}

export function planExport(settings: ExportSettings): ExportJob[] {
  const count = chunkCount(settings.rowCount, settings.targetChunkSize);
  if (!count) {
    throw new Error('Use a positive row count and a positive whole-number chunk target.');
  }
  if (!Number.isSafeInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > count) {
    throw new Error(`Concurrency must be a whole number from 1 to ${count}.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.table)) throw new Error('A valid list table is required.');
  normalizeFields(settings.fields);
  return Array.from({ length: count }, (_, index) => {
    const constraints: string[] = [];
    if (index > 0) constraints.push(`sys_id>=${((BigInt(index) * SYS_ID_SPACE) / BigInt(count)).toString(16).padStart(32, '0')}`);
    if (index < count - 1) constraints.push(`sys_id<${((BigInt(index + 1) * SYS_ID_SPACE) / BigInt(count)).toString(16).padStart(32, '0')}`);
    return { id: index + 1, query: constrainQuery(settings.query, constraints), status: 'queued' };
  });
}
