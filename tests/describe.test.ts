import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { AUTO_INTERACT } from '../src/definition.ts';
import { buildDescribe } from './helpers/describe.ts';

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'auto-interact-describe-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('自描述', () => {
  it('describe.json 与代码生成的一致', () => {
    const ctx = fakeWorldContext(AUTO_INTERACT, { scratchDir });
    const expected = buildDescribe(AUTO_INTERACT, ctx);
    const actual: unknown = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
    expect(actual).toEqual(expected);
  });

  it('声明的工具名覆盖 tools() 的每一种配置', () => {
    const ctx = fakeWorldContext(AUTO_INTERACT, { scratchDir });
    ctx.cfg.allowModelAdjust = true;
    const names = AUTO_INTERACT.create(ctx).tools().map((tool) => tool.name).sort();
    const declared = (AUTO_INTERACT.describe?.tools ?? []).map((tool) => tool.name).sort();
    expect(declared).toEqual(names);
  });

  it('调速关着时不提供 auto_pace', () => {
    const ctx = fakeWorldContext(AUTO_INTERACT, { scratchDir });
    expect(AUTO_INTERACT.create(ctx).tools().map((tool) => tool.name)).not.toContain('auto_pace');
  });
});
