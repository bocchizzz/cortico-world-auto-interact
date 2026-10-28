/**
 * 自描述的复算：与 `pnpm describe:extension` 对 World 的输出同形
 * （工具、事件，以及 `webUi('zh')` 里 role=envPrompt 的模板原文）。
 * 生成脚本与测试共用，保证 describe.json 不落后于代码。
 */
import { readFileSync } from 'node:fs';
import type { WorldContext, WorldDefinition, WorldSection } from 'cortico/world.ts';

export interface DescribePrompt {
  key: string;
  title: string;
  role?: string;
  content: string;
}

export interface DescribeFile {
  tools: unknown[];
  events: unknown[];
  prompts: DescribePrompt[];
}

export function buildDescribe<S extends WorldSection>(
  def: WorldDefinition<S>,
  ctx: WorldContext<S>,
): DescribeFile {
  if (!def.describe) throw new Error(`World "${def.id}" has no describe block`);
  const instance = def.create(ctx);
  const decl = instance.webUi?.('zh');
  const prompts: DescribePrompt[] = [];
  for (const doc of decl?.promptDocs ?? []) {
    if (doc.role !== 'envPrompt') continue;
    prompts.push({
      key: doc.key,
      title: doc.title,
      role: doc.role,
      content: readFileSync(doc.path, 'utf8'),
    });
  }
  return { tools: [...def.describe.tools], events: [...def.describe.events], prompts };
}
