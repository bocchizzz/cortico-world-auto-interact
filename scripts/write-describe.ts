/**
 * 生成 describe.json。与 Cortico 仓库的 `pnpm describe:extension` 对 World 的输出同形，
 * 但不依赖框架检出。用法：pnpm describe:extension
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { AUTO_INTERACT } from '../src/definition.ts';
import { buildDescribe } from '../tests/helpers/describe.ts';

const scratchDir = mkdtempSync(join(tmpdir(), 'auto-interact-describe-'));
try {
  const ctx = fakeWorldContext(AUTO_INTERACT, { scratchDir });
  const describe = buildDescribe(AUTO_INTERACT, ctx);
  writeFileSync(new URL('../describe.json', import.meta.url), `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
  console.log(
    `describe.json: ${describe.tools.length} 个工具，${describe.events.length} 个事件，`
    + `${describe.prompts.length} 段提示词`,
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
