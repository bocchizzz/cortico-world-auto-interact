import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { AUTO_INTERACT_DEFAULTS, frequencyOptions, type AutoInteractConfigSection } from './config.ts';
import { AUTO_INTERACT_TOOL_DECLS, AutoInteractWorld } from './world.ts';

export const AUTO_INTERACT: WorldDefinition<AutoInteractConfigSection> = {
  id: 'auto-interact',
  label: 'Auto Interact',
  defaults: () => ({ ...AUTO_INTERACT_DEFAULTS }),
  // 频率的十个档位；别的 kind 返回空数组，框架继续问其他 World。
  configOptions: (kind: string, language: Language) => (
    kind === 'auto-interact.frequency' ? frequencyOptions(language) : []
  ),
  // `ctx.cfg` 是 `worlds.auto-interact` 的活引用：热改的键现读即生效。
  create: (ctx) => new AutoInteractWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir }),
  // 自描述：可能出现的全部工具与会推出的全部事件，不进提示词。
  describe: {
    tools: describeTools(AUTO_INTERACT_TOOL_DECLS, {
      auto_status: {
        zh: '读一次时间、空闲时长、前台窗口、CPU、内存和磁盘。',
        en: 'Reads time, idle time, foreground window, CPU, memory and disks.',
      },
      auto_look: {
        zh: '截一张全屏图交给模型看，模型不支持图片时只回文字。',
        en: 'Captures the screen as an image for the model; text only when images are unsupported.',
      },
      auto_plan: {
        zh: '报频率、保底进度、今日次数、安静期和是否在活跃时段。',
        en: 'Reports the frequency, pity progress, today counts, quiet period and whether now is inside the hours.',
      },
      auto_quiet: {
        zh: '安静一段时间，不再主动搭话。',
        en: 'Stays quiet for a while and stops initiating contact.',
      },
      auto_pace: {
        zh: '按屏幕内容临时调高或调低出现频率，到点自动恢复。',
        en: 'Scales the wake-up rate for a while, then restores it.',
      },
    }),
    events: [
      {
        type: 'auto-interact.started',
        description: { zh: 'World 挂载完成，记下当前的节奏。', en: 'The World was mounted and recorded its rhythm.' },
      },
      {
        type: 'auto-interact.nudge',
        description: {
          zh: '到点且通过全部条件，邀请模型决定要不要主动开口。',
          en: 'A check passed every condition; the model is invited to speak up.',
        },
        trigger: 'flush',
      },
      {
        type: 'auto-interact.quiet',
        description: { zh: 'quiet 工具设下或取消了安静期。', en: 'The quiet tool set or cleared a quiet period.' },
      },
    ],
  },
};
