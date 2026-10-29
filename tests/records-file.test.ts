import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRecords, loadRecords, recordsPath, saveRecords } from '../src/records-file.ts';
import type { InteractionRecord } from '../src/records.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-interact-records-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('记录文件', () => {
  it('存了能原样读回来', () => {
    const file = recordsPath(dir);
    const rows: InteractionRecord[] = [
      { atMs: 1, kind: 'skip', reason: 'quiet' },
      { atMs: 2, kind: 'nudge', outcome: 'spoke' },
    ];
    saveRecords(file, rows);
    expect(loadRecords(file)).toEqual(rows);
  });

  it('工具的补充说明能原样读回来', () => {
    const file = recordsPath(dir);
    const rows: InteractionRecord[] = [{
      atMs: 1,
      kind: 'nudge',
      outcome: 'spoke',
      tools: ['auto_look', 'auto_pace'],
      toolNotes: {
        auto_look: '看了屏幕',
        auto_pace: '0.5 倍，约每 10 分钟一次，到 10:35 恢复',
      },
    }];
    saveRecords(file, rows);
    expect(loadRecords(file)).toEqual(rows);
  });

  it('文件不存在或 JSON 坏了都当作没有记录', () => {
    expect(loadRecords(recordsPath(dir))).toEqual([]);
    const file = recordsPath(dir);
    writeFileSync(file, '{ nope', 'utf8');
    expect(loadRecords(file)).toEqual([]);
  });

  it('改坏的行丢掉，好的留着', () => {
    const file = recordsPath(dir);
    writeFileSync(file, JSON.stringify({
      version: 1,
      records: [
        { atMs: 1, kind: 'skip', reason: 'quiet' },
        { atMs: 'x', kind: 'skip', reason: 'quiet' },
        { atMs: 3, kind: 'skip', reason: 'made-up' },
        { atMs: 4, kind: 'nudge', outcome: 'weird' },
        { atMs: 5, kind: 'nudge' },
        { atMs: 6, kind: 'nudge', toolNotes: { auto_look: 1 } },
        { atMs: 7, kind: 'nudge', toolNotes: [] },
      ],
    }), 'utf8');
    expect(loadRecords(file)).toEqual([
      { atMs: 1, kind: 'skip', reason: 'quiet' },
      { atMs: 5, kind: 'nudge' },
    ]);
  });

  it('清除后文件不在', () => {
    const file = recordsPath(dir);
    saveRecords(file, []);
    expect(loadRecords(file)).toEqual([]);
    clearRecords(file);
    expect(() => readFileSync(file)).toThrow();
  });
});
