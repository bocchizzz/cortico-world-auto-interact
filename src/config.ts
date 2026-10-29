/** `worlds.auto-interact` 配置段、默认值与 WebUI 配置组。 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';

/** 判定的基础节奏：每 5 分钟一次，命中才叫醒模型。 */
export const BASE_INTERVAL_MS = 5 * 60_000;

/**
 * 频率档位：1 最疏、10 最密。数值是每次判定的命中概率，
 * 平均间隔 = 5 分钟 / 概率。配置里存档位字符串（`x-options` 下拉只回字符串）。
 */
export const FREQUENCY_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const PROBABILITY: Readonly<Record<number, number>> = {
  1: 0.05,
  2: 0.1,
  3: 0.15,
  4: 0.2,
  5: 0.3,
  6: 0.4,
  7: 0.5,
  8: 0.65,
  9: 0.8,
  10: 1,
};

const LEVEL_NAMES: Record<'zh' | 'en', string[]> = {
  zh: ['很低', '低', '偏低', '稍低', '中等', '稍高', '偏高', '高', '很高', '最高'],
  en: ['very low', 'low', 'low-ish', 'below average', 'medium', 'above average', 'high-ish', 'high', 'very high', 'maximum'],
};

/** 把配置值收成 1–10 的整数；读不懂时用默认档 5。 */
export function frequencyLevel(value: unknown): number {
  const level = Number(value);
  if (!Number.isFinite(level)) return 5;
  return Math.min(10, Math.max(1, Math.round(level)));
}

/** 这一档每次判定的命中概率。 */
export function frequencyProbability(value: unknown): number {
  return PROBABILITY[frequencyLevel(value)] ?? 0.3;
}

/** 平均多久命中一次，单位分钟；用来给人看。 */
export function frequencyMinutes(value: unknown): number {
  return Math.round(BASE_INTERVAL_MS / 60_000 / frequencyProbability(value));
}

/**
 * 连续未命中多少次之后保底放行一次。
 * 配置了就用配置值；没配（0）就按两倍期望算：低档位约 200 分钟才强推一次，高档位十来分钟。
 */
export function pityAfter(value: unknown, configured = 0): number {
  const fixed = Number(configured);
  if (Number.isFinite(fixed) && fixed > 0) return Math.min(50, Math.max(2, Math.round(fixed)));
  return Math.max(2, Math.ceil(2 / frequencyProbability(value)));
}

/** 模型调速后的实际概率，夹在 2% 到 100% 之间。 */
export function pacedProbability(level: unknown, factor: number): number {
  const base = frequencyProbability(level);
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return Math.min(1, Math.max(0.02, base * scale));
}

function spanText(minutes: number, english: boolean): string {
  return english ? `about every ${minutes} min` : `约每 ${minutes} 分钟`;
}

/** `x-options` 的候选：十个档位，带平均间隔说明。 */
export function frequencyOptions(language: Language): Array<{ value: string; label: string }> {
  const zh = language === 'zh';
  const names = LEVEL_NAMES[zh ? 'zh' : 'en'];
  const open = zh ? '（' : ' (';
  const close = zh ? '）' : ')';
  return FREQUENCY_LEVELS.map((level) => ({
    value: String(level),
    label: `${level} · ${names[level - 1]}${open}${spanText(frequencyMinutes(String(level)), !zh)}${close}`,
  }));
}

/** config.json 的 `worlds.auto-interact` 段；默认禁用，由部署启用。 */
export interface AutoInteractConfigSection {
  enabled: boolean;
  /** 互动频率的档位（`'1'`–`'10'`），决定每次判定的命中概率。 */
  frequency: string;
  /** 允许搭话的本地时段，`HH:MM-HH:MM`，可跨午夜。 */
  activeHours: string;
  /** 每天最多成功开口几次；没开口的邀约不计。 */
  maxPerDay: number;
  /** 每天最多把模型叫醒几次；0 表示不限。 */
  maxNudgesPerDay: number;
  /** 连续判定未命中多少次后强制互动一次；0 表示按频率自动计算。 */
  pityMisses: number;
  /** 允许模型用 auto_pace 临时调整频率。 */
  allowModelAdjust: boolean;
  /** 至少空闲这么久才搭话；0 表示完全不看空闲状态。 */
  idleMinMs: number;
  /** 空闲超过这么久视为用户离开，不搭话；最短空闲为 0 时不看这一项。 */
  idleMaxMs: number;
  /** 用户最后一次说话后，至少等这么久再搭话。 */
  afterUserMessageMs: number;
  /** 允许截图。默认关闭；打开后 auto_look 才能拿到屏幕。 */
  allowScreenshot: boolean;
  /** 截图缩放后的最大宽度，像素。 */
  screenshotMaxWidth: number;
  /** JPEG 质量。 */
  screenshotQuality: number;
  /** 回执和事件里带前台窗口标题。默认关闭，窗口标题可能包含文档名。 */
  shareWindowTitle: boolean;
  /** 允许它在你空闲时申请玩电脑；真正动手仍要先经你同意。 */
  allowComputerPlay: boolean;
  /** 部署者写给模型的一段说明，插进环境提示词。 */
  note: string;
}

export const AUTO_INTERACT_DEFAULTS: AutoInteractConfigSection = {
  enabled: false,
  frequency: '5',
  activeHours: '09:00-23:00',
  maxPerDay: 12,
  maxNudgesPerDay: 24,
  pityMisses: 0,
  allowModelAdjust: false,
  idleMinMs: 120_000,
  idleMaxMs: 2_700_000,
  afterUserMessageMs: 480_000,
  allowScreenshot: false,
  screenshotMaxWidth: 1280,
  screenshotQuality: 70,
  shareWindowTitle: false,
  allowComputerPlay: false,
  note: '',
};

/** World 配置的 JSON Schema 声明；键的顺序就是 WebUI 里的顺序。 */
export const AUTO_INTERACT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:auto-interact',
  owner: 'world:auto-interact',
  schema: {
    type: 'object',
    title: '主动互动',
    description: '每 5 分钟做一次判定，命中才把 Coo 叫醒；未命中不会调用模型。',
    properties: {
      'worlds.auto-interact.frequency': {
        type: 'string',
        title: '互动频率',
        enum: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
        'x-options': 'auto-interact.frequency',
        'x-hot': true,
        description: '档位越高，Coo 越容易来找你。每 5 分钟做一次判定：1 档平均 100 分钟才命中一次，5 档约 17 分钟，10 档每次都命中。未命中不会叫醒模型，也不产生模型调用；连续未命中会按保底强制互动一次。',
      },
      'worlds.auto-interact.activeHours': {
        type: 'string',
        title: '活跃时段',
        'x-hot': true,
        description: '本地时间 HH:MM-HH:MM；跨午夜写成 22:00-02:00。这段之外不做判定。',
      },
      'worlds.auto-interact.maxPerDay': {
        type: 'integer',
        title: '每天开口上限',
        minimum: 0,
        maximum: 96,
        'x-hot': true,
        'x-suffix': '次',
        description: '一天最多成功开口几次；被叫醒却没开口的不计。默认 12，填 0 表示不再主动搭话，工具仍然可用。',
      },
      'worlds.auto-interact.maxNudgesPerDay': {
        type: 'integer',
        title: '每天叫醒上限',
        minimum: 0,
        maximum: 96,
        'x-hot': true,
        'x-suffix': '次',
        description: '一天最多把 Coo 叫醒几次。判定命中就算一次，哪怕它没开口。默认 24，0 表示不限。',
      },
      'worlds.auto-interact.pityMisses': {
        type: 'integer',
        title: '保底互动',
        minimum: 0,
        maximum: 50,
        'x-hot': true,
        'x-suffix': '次',
        description: '连续这么多次判定未命中，就强制互动一次，免得一直等不到。0 表示按频率自动计算：低档约 40 次，高档 2 次。',
      },
      'worlds.auto-interact.allowModelAdjust': {
        type: 'boolean',
        title: '允许模型调速',
        'x-hot': true,
        description: '打开后，模型可以用 auto_pace 按屏幕内容临时调整频率：你在忙就调低，一起玩就调高；15–240 分钟后自动恢复。',
      },
      'worlds.auto-interact.idleMinMs': {
        type: 'integer',
        title: '最短空闲',
        minimum: 0,
        maximum: 7200000,
        'x-hot': true,
        'x-suffix': 'ms',
        description: '至少空闲这么久才搭话（毫秒）。默认 120000，即 2 分钟；你正在打字或点鼠标时不会打扰。填 0 表示完全不看空闲状态，「最长空闲」也随之失效。',
      },
      'worlds.auto-interact.idleMaxMs': {
        type: 'integer',
        title: '最长空闲',
        minimum: 10000,
        maximum: 28800000,
        'x-hot': true,
        'x-suffix': 'ms',
        description: '空闲超过这么久就当你不在电脑前，跳过这一轮。默认 2700000，即 45 分钟；「最短空闲」为 0 时不看这一项。',
      },
      'worlds.auto-interact.afterUserMessageMs': {
        type: 'integer',
        title: '用户说话后等待',
        minimum: 0,
        maximum: 14400000,
        'x-hot': true,
        'x-suffix': 'ms',
        description: '你刚说过话时，等这么久再主动开口。默认 480000，即 8 分钟。',
      },
      'worlds.auto-interact.allowScreenshot': {
        type: 'boolean',
        title: '允许截图',
        'x-hot': true,
        'x-warning': true,
        description: '关闭时 auto_look 直接拒绝。打开后只在你主动调用该工具时截图，图片会随模型请求发送到你配置的模型服务。',
      },
      'worlds.auto-interact.screenshotMaxWidth': {
        type: 'integer',
        title: '截图宽度',
        minimum: 640,
        maximum: 3840,
        'x-hot': true,
        'x-suffix': '像素',
        description: '截图按这个宽度等比缩小后再保存为 JPEG。默认 1280 像素。',
      },
      'worlds.auto-interact.screenshotQuality': {
        type: 'integer',
        title: '截图清晰度',
        minimum: 40,
        maximum: 90,
        'x-hot': true,
        description: '越高越清楚，体积也越大。默认 70。',
      },
      'worlds.auto-interact.shareWindowTitle': {
        type: 'boolean',
        title: '读取前台窗口标题',
        'x-hot': true,
        'x-warning': true,
        description: '打开后，事件和工具回执里会带当前前台窗口的标题。标题可能包含文档名或网页标题，默认关闭。',
      },
      'worlds.auto-interact.allowComputerPlay': {
        type: 'boolean',
        title: '允许申请玩电脑',
        'x-hot': true,
        'x-warning': true,
        description: '打开后，它可以在空闲时先征求你的同意，再用「电脑操作」浏览网页、看 B 站或上 QQ。还需要在「习惯」页打开「电脑操作」。',
      },
      'worlds.auto-interact.note': {
        type: 'string',
        title: '补充说明',
        'x-hot': true,
        description: '写进环境提示词的一句话，用来交代它的说话风格，比如「你是只有点粘人的橘猫，晚上别太吵」。最多 200 字。',
      },
    },
  },
};
