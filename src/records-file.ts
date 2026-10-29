/**
 * 互动记录落盘：部署数据目录里的一个小 JSON，重启后还在。
 * 文件读不懂就当没有记录，不拦 World 启动。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isBlockReason,
  isOutcome,
  MAX_RECORDS,
  type InteractionRecord,
} from './records.ts';

export const RECORDS_FILE = 'auto-interact-records.json';

interface RecordsFile {
  version: 1;
  records: InteractionRecord[];
}

export function recordsPath(dataDir: string): string {
  return join(dataDir, RECORDS_FILE);
}

function isRecord(value: unknown): value is InteractionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.atMs !== 'number' || !Number.isFinite(record.atMs)) return false;
  if (record.pity !== undefined && typeof record.pity !== 'boolean') return false;
  if (record.ms !== undefined && (typeof record.ms !== 'number' || !Number.isFinite(record.ms))) return false;
  if (
    record.tools !== undefined
    && (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== 'string'))
  ) return false;
  if (record.toolNotes !== undefined) {
    const notes = record.toolNotes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return false;
    if (Object.entries(notes).some(([name, note]) => !name || typeof note !== 'string')) return false;
  }
  if (record.kind === 'skip') return isBlockReason(record.reason);
  if (record.kind !== 'nudge') return false;
  return record.outcome === undefined || isOutcome(record.outcome);
}

/** 读不存在的文件、坏 JSON、改坏的行都当作没有记录。 */
export function loadRecords(file: string): InteractionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RecordsFile>;
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records.filter(isRecord).slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

/** 先写临时文件再换名，写到一半崩掉也不会留下半个 JSON。 */
export function saveRecords(file: string, records: readonly InteractionRecord[]): void {
  const body: RecordsFile = { version: 1, records: [...records] };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  try {
    renameSync(temp, file);
  } catch {
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    rmSync(temp, { force: true });
  }
}

export function clearRecords(file: string): void {
  rmSync(file, { force: true });
}
