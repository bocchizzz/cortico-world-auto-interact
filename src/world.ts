/**
 * 主动互动 World：定时判断此刻适不适合搭话，推一条 nudge 把模型叫醒，
 * 并把屏幕和系统状态作为工具交给模型。说不说话由 Persona 决定。
 */
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  EventEnvelope,
  OutputTap,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  AUTO_INTERACT_CONFIG_GROUP,
  AUTO_INTERACT_DEFAULTS,
  BASE_INTERVAL_MS,
  frequencyLevel,
  frequencyMinutes,
  frequencyProbability,
  pacedProbability,
  pityAfter,
  type AutoInteractConfigSection,
} from './config.ts';
import {
  MAX_RECORDS,
  outcomeLabel,
  skipLabel,
  type InteractionOutcome,
  type InteractionRecord,
} from './records.ts';
import { clearRecords, loadRecords, recordsPath, saveRecords } from './records-file.ts';
import {
  checkNudge,
  formatClock,
  localParts,
  parseActiveHours,
  passesChance,
  withinActiveHours,
  type ActiveHours,
  type NudgeState,
  type RhythmConfig,
} from './scheduler.ts';
import { createWindowsProbe, type AutoInteractProbe } from './probes/windows.ts';

export const WORLD_ID = 'auto-interact';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const MINUTE_MS = 60_000;

/** 连续这么多次被叫醒却没开口，就在事件里把要求写死。内部兜底，不做配置项。 */
const SILENT_ESCALATION = 3;

/** 全部工具的声明；定义的 describe 与 `tools()` 都取它。 */
export const AUTO_INTERACT_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'auto_status',
    description:
      "Read the current state of the user's computer: local time, idle time, "
      + 'foreground window title when the deployment shares it, CPU load, memory, '
      + 'disk free space and uptime. Use it before deciding whether the user is busy.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'auto_look',
    description:
      'Capture the screen (all monitors, scaled down) as a JPEG image so you can see '
      + 'what the user is doing. The image is attached only when the deployment allows '
      + 'screenshots and the active model accepts images; otherwise the receipt explains why.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'auto_plan',
    description:
      'Report the proactive-interaction plan: when the next check is due, how many '
      + 'invitations were sent today, whether a quiet period is active and whether now '
      + 'is inside the allowed hours.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'auto_quiet',
    description:
      'Stop initiating contact for a while. Use it when the user is busy, in a meeting '
      + 'or asks not to be interrupted. 0 cancels an active quiet period.',
    tags: ['flow'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: {
          type: 'integer',
          minimum: 0,
          maximum: 240,
          description: 'How long to stay quiet, in minutes. 0 cancels.',
        },
      },
    },
  },
  {
    name: 'auto_pace',
    description:
      'Temporarily scale how often you get woken up. 0.5 halves it, 2 doubles it; '
      + 'the change expires after the given minutes. Use it when the screen shows the user '
      + 'busy or ready to hang out. Only available when the deployment allows it.',
    tags: ['flow'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        factor: {
          type: 'number',
          minimum: 0.25,
          maximum: 3,
          description: 'Multiplier on the hit probability; 1 leaves it unchanged.',
        },
        minutes: {
          type: 'integer',
          minimum: 15,
          maximum: 240,
          description: 'How long the change lasts, in minutes. Defaults to 90.',
        },
      },
      required: ['factor'],
    },
  },
];

/**
 * 「允许申请玩电脑」打开时插进环境提示词的一段。
 * 电脑操作只认使用者主动说的理由：定时事件不算，所以必须先问、得到回答才动手。
 */
const COMPUTER_PLAY_GUIDANCE = '用户空闲时，你也可以先用 `pet_ask` 问一句能不能玩会儿电脑——用浏览器看网页、看 B 站、上 QQ，或者一起玩你看到的游戏。'
  + '得到「可以」之后才能用 `pet_cua_*`；这些工具不在工具表里，说明「习惯」页的「电脑操作」没开，别假装能玩。'
  + '玩之前先截图看清楚，不登录、不输密码、不发消息、不花钱；用户一动鼠标键盘就让开。';

/** 「允许模型调速」打开时插进环境提示词的一段。 */
const PACE_GUIDANCE = '你可以用 `auto_pace` 临时调整自己出现的频率：看到用户在专注工作、开会或不想被打扰，就把倍率降到 0.5 或更低；'
  + '用户答应和你一起玩、或者明显在放松聊天，可以调到 1.5–2。倍率只管一段时间，到点自动回到 1；不要每轮都调，也不要一直拉满。';

/** 构造参数；测试替换探针、随机源与时钟。 */
export interface AutoInteractOptions {
  cfg: AutoInteractConfigSection;
  timezone: string;
  /** 部署数据目录；给了才把记录落盘。 */
  dataDir?: string;
  probe?: AutoInteractProbe;
  random?: () => number;
  clock?: () => number;
}

/** 给环境提示词用的一句话节奏说明。 */
export function rhythmText(cfg: AutoInteractConfigSection): string {
  const level = frequencyLevel(cfg.frequency);
  const percent = Math.round(frequencyProbability(level) * 100);
  return `每 5 分钟做一次判定，这一档的命中概率 ${percent}%，平均每 ${frequencyMinutes(level)} 分钟叫你一次；`
    + `只在本地时间 ${cfg.activeHours} 内、用户空闲 ${formatSpan(cfg.idleMinMs)}–${formatSpan(cfg.idleMaxMs)} 时判定，`
    + `每天最多成功开口 ${cfg.maxPerDay} 次。`;
}

/** 时长给人看：秒、分钟、小时或天。 */
function formatSpan(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/** 倍率给人看：最多两位小数，去掉末尾的零。 */
function formatFactor(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatGb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 部署里的 config.json 可能来自上一个版本：段里缺键时读到 undefined，定时器会拿到 NaN。
 * 这里只补类型不对或缺席的键，用户设的 false、0、空串都算有效值。
 */
function applyDefaults(cfg: AutoInteractConfigSection): void {
  const target = cfg as unknown as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(AUTO_INTERACT_DEFAULTS)) {
    const value = target[key];
    const valid = typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value));
    if (!valid) target[key] = fallback;
  }
}

export class AutoInteractWorld implements World {
  readonly id = WORLD_ID;

  private readonly cfg: AutoInteractConfigSection;
  private readonly timezone: string;
  private readonly probe: AutoInteractProbe;
  private readonly random: () => number;
  private readonly clock: () => number;
  /** 记录文件；没给数据目录时为 null，只留在内存里。 */
  private readonly recordsFile: string | null;

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private nextAtMs: number | null = null;
  private dayKey = '';
  private warnedHours = false;
  private readonly records: InteractionRecord[] = [];
  /** 本轮是不是由我们的 nudge 叫醒的，以及这轮里有没有说过话。 */
  private awaitingNudge = false;
  private sawSpeech = false;
  /** 连续多少次邀约都没开口。 */
  private silentStreak = 0;
  /** 连续未命中的次数，命中或保底后清零。 */
  private misses = 0;
  /** 模型临时调的倍率与到期时刻；到期后按 1 算。 */
  private paceFactor = 1;
  private paceUntilMs = 0;
  /** 这一轮调过的工具（本轮结束后清空）与本轮开始时刻。 */
  private readonly turnTools = new Set<string>();
  /** 工具名对应的补充说明，比如截图没成、调速后的倍率。 */
  private readonly turnToolNotes = new Map<string, string>();
  private turnStartedAt: number | null = null;
  private readonly state: NudgeState = {
    lastNudgeAtMs: null,
    lastUserMessageAtMs: null,
    quietUntilMs: null,
    todaySpoken: 0,
    todayNudges: 0,
  };

  constructor(opts: AutoInteractOptions) {
    this.cfg = opts.cfg;
    applyDefaults(this.cfg);
    this.timezone = opts.timezone;
    this.probe = opts.probe ?? createWindowsProbe();
    this.random = opts.random ?? Math.random;
    this.clock = opts.clock ?? (() => Date.now());
    this.recordsFile = opts.dataDir ? recordsPath(opts.dataDir) : null;
    if (this.recordsFile) this.records.push(...loadRecords(this.recordsFile));
  }

  /** 只报值；模板正文在 ENV_PROMPT.md，玩电脑与调速那两段由配置决定。 */
  envPromptVars(): Record<string, string> {
    return {
      'auto.rhythm': rhythmText(this.cfg),
      'auto.play': this.cfg.allowComputerPlay ? COMPUTER_PLAY_GUIDANCE : '',
      'auto.pace': this.cfg.allowModelAdjust ? PACE_GUIDANCE : '',
      'auto.note': this.cfg.note.slice(0, 200),
    };
  }

  tools(): ToolDef[] {
    const [status, look, plan, quiet, pace] = AUTO_INTERACT_TOOL_DECLS;
    return [
      { ...status, handler: async () => this.statusTool() },
      { ...look, handler: async () => this.lookTool() },
      { ...plan, handler: async () => this.planTool() },
      { ...quiet, handler: async (args: Record<string, unknown>) => this.quietTool(args) },
      ...(this.cfg.allowModelAdjust
        ? [{
          ...pace,
          handler: async (args: Record<string, unknown>) => this.paceTool(args),
        }]
        : []),
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const zh = language === 'zh';
    return {
      label: zh ? '自动互动' : 'Auto Interact',
      config: [AUTO_INTERACT_CONFIG_GROUP],
      promptDocs: [
        {
          key: `worlds.${WORLD_ID}.envPrompt`,
          title: zh ? '自动互动 · 环境提示词' : 'Auto Interact · Environment prompt',
          description: zh
            ? '主动互动写进 system 前缀的那一段。'
            : 'The section this World adds to the system prefix.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'auto.rhythm',
              description: zh ? '当前的频率、时段与次数上限。' : 'Current frequency, hours and daily cap.',
            },
            {
              name: 'auto.play',
              description: zh
                ? '打开「允许申请玩电脑」时的那段说明，关着时为空。'
                : 'How to ask before using the computer; empty when the switch is off.',
              multiline: true,
            },
            {
              name: 'auto.pace',
              description: zh
                ? '打开「允许模型调速」时的那段说明，关着时为空。'
                : 'How to scale the pace; empty when the switch is off.',
              multiline: true,
            },
            {
              name: 'auto.note',
              description: zh ? '部署者写的补充说明，可能为空。' : 'A note from the deployment; may be empty.',
            },
          ],
        },
      ],
      panels: [
        {
          id: 'guide',
          title: zh ? '使用说明' : 'Guide',
          description: zh ? '这个扩展做什么、配置项和记录怎么读。' : 'What this extension does, and how to read its settings and log.',
        },
        {
          id: 'records',
          title: zh ? '互动记录' : 'Interaction log',
          description: zh
            ? `最近 ${MAX_RECORDS} 条：什么时候叫醒、为什么跳过、之后有没有开口。`
            : `The last ${MAX_RECORDS} entries: when the model was woken, why one was skipped, and whether the pet spoke.`,
        },
      ],
      // 数据面必须挂在返回的对象上；框架读的是 `webUi().invoke`。
      invoke: async (panel: string, method: string) => {
        if (panel !== 'records') throw new Error(`unknown panel: ${panel}`);
        if (method === 'list') return { records: this.recordViews() };
        if (method === 'clear') {
          this.records.length = 0;
          this.misses = 0;
          if (this.recordsFile) clearRecords(this.recordsFile);
          return { records: [] };
        }
        throw new Error(`unknown method: ${method}`);
      },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    const nowMs = this.clock();
    this.rollDay(localParts(nowMs, this.timezone).dayKey);
    this.state.lastUserMessageAtMs = this.findLastUserMessageAt(host, nowMs);
    await host.pushEvent(
      {
        type: `${WORLD_ID}.started`,
        ts: nowIso(this.timezone),
        source: WORLD_ID,
        origin: 'internal',
        senderKey: WORLD_ID,
        text: `主动互动已挂载：${rhythmText(this.cfg)}`,
      },
      { deliver: false },
    );
    if (this.stopped) return;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAtMs = null;
    this.host = null;
  }

  /** 主 session 的输出流：记录这一轮调了哪些工具，并判断有没有真的说出口。 */
  outputTap(): OutputTap {
    return {
      externalizes: () => false,
      onEvent: (event) => {
        const name = functionCallName(event);
        if (!name) return;
        if (this.awaitingNudge) this.turnTools.add(name);
        if (name === 'pet_say' || name === 'pet_ask') this.sawSpeech = true;
      },
    };
  }

  /** nudge 写进主 session 才开始等回应；被操作者清掉就直接记下。 */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    if (!events.some((event) => event.type === `${WORLD_ID}.nudge`)) return;
    if (outcome === 'discarded') {
      this.finishOutcome('dropped');
      return;
    }
    this.awaitingNudge = true;
    this.sawSpeech = false;
    this.turnTools.clear();
    this.turnToolNotes.clear();
    this.turnStartedAt = this.clock();
  }

  /** 一轮结束：这一轮没调 `pet_say` / `pet_ask` 就算没开口，工具、说明与耗时一并记下。 */
  onTurnEnded(): void {
    if (!this.awaitingNudge) return;
    const startedAt = this.turnStartedAt;
    const ms = startedAt === null ? undefined : Math.max(0, this.clock() - startedAt);
    this.finishOutcome(
      this.sawSpeech ? 'spoke' : 'silent',
      [...this.turnTools],
      ms,
      this.turnToolNotes.size > 0 ? Object.fromEntries(this.turnToolNotes) : undefined,
    );
    this.awaitingNudge = false;
    this.turnStartedAt = null;
    this.turnTools.clear();
    this.turnToolNotes.clear();
  }

  /** 判断用到的条件；配置热改后每次现算。 */
  private rhythm(): RhythmConfig {
    return {
      activeHours: this.cfg.activeHours,
      idleMinMs: this.cfg.idleMinMs,
      idleMaxMs: this.cfg.idleMaxMs,
      afterUserMessageMs: this.cfg.afterUserMessageMs,
      maxPerDay: this.cfg.maxPerDay,
      maxNudgesPerDay: this.cfg.maxNudgesPerDay,
    };
  }

  /** 当前生效的命中概率：档位概率乘上还没过期的调速倍率。 */
  private probability(nowMs: number): number {
    const factor = nowMs < this.paceUntilMs ? this.paceFactor : 1;
    return pacedProbability(this.cfg.frequency, factor);
  }

  /** 每 5 分钟排一次；概率判定在 tick 里做。 */
  private schedule(): void {
    if (this.stopped) return;
    this.nextAtMs = this.clock() + BASE_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.tick();
    }, BASE_INTERVAL_MS);
    // 定时器不该拖住进程退出。
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || !this.host) return;
    const host = this.host;
    try {
      if (!this.cfg.enabled) return;
      const nowMs = this.clock();
      const zoned = localParts(nowMs, this.timezone);
      this.rollDay(zoned.dayKey);
      // 最短空闲为 0：不看空闲状态，也就不用起 PowerShell 去读。
      let idleMs: number | null = null;
      if (this.cfg.idleMinMs > 0) {
        const idle = await this.probe.idleMs();
        if (this.stopped) return;
        if (!idle.ok) {
          host.log.warn('读取空闲时长失败，这一轮不搭话', { error: idle.error });
          return;
        }
        idleMs = idle.value;
      }
      this.state.lastUserMessageAtMs = this.findLastUserMessageAt(host, nowMs);
      const decision = checkNudge(this.rhythm(), { nowMs, zoned, idleMs: idleMs ?? 0, state: this.state });
      if (!decision.allowed) {
        host.log.debug(`这一轮不搭话：${decision.reason}`);
        this.remember({ atMs: nowMs, kind: 'skip', reason: decision.reason });
        return;
      }

      // 到点只做一次概率判定；未命中就不叫模型，也不产生调用。连续未命中到保底才强制叫一次。
      const chance = passesChance(
        this.probability(nowMs),
        this.misses,
        pityAfter(this.cfg.frequency, this.cfg.pityMisses),
        this.random,
      );
      if (!chance.pass) {
        this.misses += 1;
        return;
      }
      this.misses = 0;

      await this.pushNudge(host, nowMs, idleMs, chance.forced);
      this.remember({ atMs: nowMs, kind: 'nudge', outcome: 'pending', ...(chance.forced ? { pity: true } : {}) });
      this.state.lastNudgeAtMs = nowMs;
      this.state.todayNudges += 1;
    } catch (error) {
      host.log.error('主动互动的定时判断出错', error);
    } finally {
      this.schedule();
    }
  }

  private async pushNudge(host: WorldHost, nowMs: number, idleMs: number | null, pity: boolean): Promise<void> {
    const clock = formatClock(nowMs, this.timezone);
    const head = idleMs === null
      ? `现在是 ${clock}。`
      : `现在是 ${clock}，${idleMs < MINUTE_MS ? '用户刚刚还在操作电脑' : `用户已经 ${formatSpan(idleMs)}没有操作电脑`}。`;
    const lines = [
      head,
      '这一次轮到你开口了：请调用 `pet_say` 说一句，内容由你定。',
      `这是今天的第 ${this.state.todayNudges + 1} 次邀约；此前成功开口 ${this.state.todaySpoken} 次。`,
    ];
    if (pity) {
      lines.push('这次是保底：连续几次判定都没有命中，所以把你叫醒了。');
    }

    // 连续沉默太多次时，下一次把要求写死：模型仍可能不听，但至少不会再随便略过。
    // 模型没照做、连续沉默时把要求写死；这是内部兜底，不单独占配置项。
    if (this.silentStreak >= SILENT_ESCALATION) {
      lines.push(`你最近连续 ${this.silentStreak} 次被叫醒都没开口；这一次请一定说点什么，哪怕只有一句。`);
      this.silentStreak = 0;
    }

    await host.pushEvent(
      {
        type: `${WORLD_ID}.nudge`,
        ts: nowIso(this.timezone),
        source: WORLD_ID,
        origin: 'internal',
        senderKey: WORLD_ID,
        text: lines.join('\n'),
      },
      { trigger: 'flush' },
    );
  }

  private async statusTool(): Promise<ToolOutcome> {
    const result = await this.probe.status({ includeWindowTitle: this.cfg.shareWindowTitle });
    if (!result.ok) return { text: `读取系统状态失败：${result.error}`, failed: true };
    const status = result.value;
    const lines = [
      `时间：${formatClock(this.clock(), this.timezone)}（${this.timezone}）`,
      `空闲：${formatSpan(status.idleMs)}`,
    ];
    if (this.cfg.shareWindowTitle) {
      lines.push(`前台窗口：${status.windowTitle ?? '读不到标题'}`);
    }
    if (status.cpuPercent !== null) lines.push(`CPU：${status.cpuPercent}%`);
    lines.push(`内存：已用 ${formatGb(status.memTotalMb - status.memFreeMb)} / ${formatGb(status.memTotalMb)} GB`);
    for (const disk of status.disks.slice(0, 4)) {
      lines.push(`磁盘 ${disk.mount}：剩余 ${formatGb(disk.freeMb)} / ${formatGb(disk.totalMb)} GB`);
    }
    lines.push(`已开机：${formatSpan(status.uptimeMinutes * MINUTE_MS)}`);
    return { text: lines.join('\n') };
  }

  private async lookTool(): Promise<ToolOutcome> {
    const cfg = this.cfg;
    if (!cfg.allowScreenshot) {
      this.noteTool('auto_look', '没看屏幕（截图已关闭）');
      return {
        text: '截图已关闭，这里拿不到画面。要让这个工具可用，需要在 World 页打开「允许截图」。',
        failed: true,
      };
    }
    const shot = await this.probe.capture({ maxWidth: cfg.screenshotMaxWidth, quality: cfg.screenshotQuality });
    if (!shot.ok) {
      this.noteTool('auto_look', '没看屏幕（截图失败）');
      return { text: `截图失败：${shot.error}`, failed: true };
    }
    const value = shot.value;
    const head = `截屏 ${value.width}×${value.height}，原图 ${value.sourceWidth}×${value.sourceHeight}，`
      + `${Math.max(1, Math.round(value.bytes.byteLength / 1024))} KB。`;
    const accepts = this.host?.modelFacts.accepts('image/jpeg') ?? false;
    if (!accepts) {
      this.noteTool('auto_look', '截了图，但当前模型不收图');
      return { text: `${head}\n当前模型端点不接受图片，只有这段文字。` };
    }
    this.noteTool('auto_look', '看了屏幕');
    return {
      text: head,
      blobs: [{
        bytes: value.bytes,
        mime: value.mime,
        name: 'screen.jpg',
        fallbackText: `屏幕截图 ${value.width}×${value.height}`,
      }],
    };
  }

  private planTool(): string {
    const nowMs = this.clock();
    const cfg = this.cfg;
    const lines: string[] = [];
    const level = frequencyLevel(cfg.frequency);
    const probability = this.probability(nowMs);
    lines.push(`频率：${level} 档，命中概率 ${Math.round(probability * 100)}%，平均 ${Math.max(1, Math.round(5 / probability))} 分钟叫醒一次`);
    lines.push(`连续未命中：${this.misses} 次（到 ${pityAfter(cfg.frequency, cfg.pityMisses)} 次保底）`);
    if (nowMs < this.paceUntilMs) {
      lines.push(`模型调速：${this.paceFactor} 倍，到 ${formatClock(this.paceUntilMs, this.timezone)} 恢复`);
    }
    if (this.nextAtMs === null) {
      lines.push('定时判断没有在跑：World 可能还没挂载。');
    } else {
      const remaining = Math.max(0, this.nextAtMs - nowMs);
      lines.push(`下次判定：约 ${formatClock(this.nextAtMs, this.timezone)}（${formatSpan(remaining)}后）`);
    }
    lines.push(`今日已开口：${this.state.todaySpoken} / ${cfg.maxPerDay}`);
    lines.push(`今日已叫醒：${this.state.todayNudges}${cfg.maxNudgesPerDay > 0 ? ` / ${cfg.maxNudgesPerDay}` : ''}`);
    if (this.state.quietUntilMs !== null && this.state.quietUntilMs > nowMs) {
      lines.push(`安静期：到 ${formatClock(this.state.quietUntilMs, this.timezone)}`);
    } else {
      lines.push('安静期：无');
    }
    const zoned = localParts(nowMs, this.timezone);
    const hours = this.readActiveHours();
    const inside = hours ? withinActiveHours(hours, zoned.hour, zoned.minute) : true;
    lines.push(`活跃时段：${cfg.activeHours}（现在${inside ? '在' : '不在'}时段内）`);
    if (this.state.lastNudgeAtMs !== null) {
      lines.push(`上次叫醒：${formatClock(this.state.lastNudgeAtMs, this.timezone)}`);
    }
    return lines.join('\n');
  }

  private async quietTool(args: Record<string, unknown>): Promise<string> {
    const raw = Number(args.minutes);
    const minutes = Number.isFinite(raw) ? clamp(Math.round(raw), 0, 240) : 30;
    const nowMs = this.clock();
    const host = this.host;
    if (minutes === 0) {
      this.state.quietUntilMs = null;
      if (host) await this.pushQuietEvent(host, null);
      return '已取消安静期，下一轮判断照常进行。';
    }
    this.state.quietUntilMs = nowMs + minutes * MINUTE_MS;
    if (host) await this.pushQuietEvent(host, this.state.quietUntilMs);
    return `接下来 ${minutes} 分钟不主动搭话，安静到 ${formatClock(this.state.quietUntilMs, this.timezone)}。`;
  }

  /** 模型临时调速：倍率乘在命中概率上，到点自动回到 1。 */
  private async paceTool(args: Record<string, unknown>): Promise<string> {
    const rawFactor = Number(args.factor);
    const factor = clamp(Number.isFinite(rawFactor) ? rawFactor : 1, 0.25, 3);
    const rawMinutes = Number(args.minutes);
    const minutes = Number.isFinite(rawMinutes) ? clamp(Math.round(rawMinutes), 15, 240) : 90;
    const nowMs = this.clock();
    this.paceFactor = factor;
    this.paceUntilMs = nowMs + minutes * MINUTE_MS;
    const probability = this.probability(nowMs);
    const between = Math.max(1, Math.round(BASE_INTERVAL_MS / MINUTE_MS / probability));
    const until = formatClock(this.paceUntilMs, this.timezone);
    this.noteTool('auto_pace', `${formatFactor(factor)} 倍，约每 ${between} 分钟一次，到 ${until} 恢复`);
    return `接下来 ${minutes} 分钟按 ${factor} 倍调速，到 ${until} 恢复；`
      + `命中概率现在 ${Math.round(probability * 100)}%，平均 ${between} 分钟叫醒一次。`;
  }

  private async pushQuietEvent(host: WorldHost, untilMs: number | null): Promise<void> {    const text = untilMs === null
      ? '主动互动：安静期已取消。'
      : `主动互动：安静到 ${formatClock(untilMs, this.timezone)}。`;
    await host.pushEvent(
      {
        type: `${WORLD_ID}.quiet`,
        ts: nowIso(this.timezone),
        source: WORLD_ID,
        origin: 'internal',
        senderKey: WORLD_ID,
        text,
      },
      { deliver: false },
    );
  }

  /** 事件库里最近一条用户发言；只看 24 小时内，类型由 `latestUserEventAt` 判定。 */
  private findLastUserMessageAt(host: WorldHost, nowMs: number): number | null {
    try {
      const since = new Date(nowMs - 24 * 60 * MINUTE_MS).toISOString();
      let latest: number | null = null;
      // 分来源查，免得桌宠或别的 World 的高频事件把真正的发言挤出最近 200 条。
      for (const source of USER_SPEECH_SOURCES) {
        const events = host.store.range({ source, fromTs: since, limit: 200 });
        for (const event of events) latest = latestUserEventAt(event, latest);
      }
      return latest;
    } catch (error) {
      host.log.debug('读事件库失败，跳过「用户刚说过话」这项判断', { error });
      return null;
    }
  }

  private readActiveHours(): ActiveHours | null {
    const hours = parseActiveHours(this.cfg.activeHours);
    if (!hours && !this.warnedHours) {
      this.warnedHours = true;
      this.host?.log.warn(`活跃时段格式不对："${this.cfg.activeHours}"，按全天处理`);
    }
    return hours;
  }

  private rollDay(dayKey: string): void {
    if (this.dayKey === dayKey) return;
    this.dayKey = dayKey;
    this.state.todaySpoken = 0;
    this.state.todayNudges = 0;
  }

  private remember(record: InteractionRecord): void {
    const last = this.records[this.records.length - 1];
    // 每 5 分钟一次判断，同一个跳过原因连着来只留第一条，别把日志刷满。
    if (record.kind === 'skip' && last?.kind === 'skip' && last.reason === record.reason) return;
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.persist();
  }

  /** 记下这一轮某个工具的补充说明；不在邀约轮次里就不记。 */
  private noteTool(name: string, note: string): void {
    if (!this.awaitingNudge) return;
    this.turnToolNotes.set(name, note);
  }

  /** 把最近一条还没回应的邀约改成就绪的结果，并结算今天的开口次数。 */
  private finishOutcome(
    outcome: InteractionOutcome,
    tools?: string[],
    ms?: number,
    toolNotes?: Record<string, string>,
  ): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record.kind === 'nudge' && record.outcome === 'pending') {
        record.outcome = outcome;
        if (tools?.length) record.tools = tools;
        if (toolNotes && Object.keys(toolNotes).length > 0) record.toolNotes = toolNotes;
        if (ms !== undefined) record.ms = ms;
        if (outcome === 'spoke') {
          this.state.todaySpoken += 1;
          this.silentStreak = 0;
        } else if (outcome === 'silent') {
          this.silentStreak += 1;
        }
        this.persist();
        return;
      }
    }
  }

  /** 每次变化都整份重写；记录最多 60 条，几 KB。 */
  private persist(): void {
    if (!this.recordsFile) return;
    saveRecords(this.recordsFile, this.records);
  }

  /** 给面板的视图：新的在前；detail 记这一轮做了什么、花了多久。 */
  private recordViews(): Array<{ at: string; text: string; outcome: string; tone: string; detail: string }> {
    return this.records.slice().reverse().map((record) => {
      const at = formatClock(record.atMs, this.timezone);
      if (record.kind === 'skip') {
        return {
          at,
          text: record.reason ? `跳过：${skipLabel(record.reason)}` : '跳过',
          outcome: '',
          tone: 'muted',
          detail: '',
        };
      }
      const outcome = record.outcome ?? 'pending';
      return {
        at,
        text: record.pity ? '保底叫醒' : '主动搭话',
        outcome: outcomeLabel(outcome),
        tone: outcome === 'spoke' ? 'ok' : outcome === 'silent' ? 'warn' : 'muted',
        detail: turnDetail(record),
      };
    });
  }
}

/** 这一轮用过的工具翻成一句人话，并带上这一轮的说明与耗时。 */
function turnDetail(record: InteractionRecord): string {
  const parts: string[] = [];
  const tools = record.tools ?? [];
  const notes = record.toolNotes ?? {};
  if (tools.includes('auto_look')) parts.push(notes.auto_look ?? '调用过截图');
  if (tools.includes('auto_status')) parts.push('看了状态');
  if (tools.includes('auto_quiet')) parts.push('设了安静');
  if (tools.includes('auto_pace')) {
    parts.push(notes.auto_pace ? `调了频率：${notes.auto_pace}` : '调了频率');
  }
  if (tools.includes('pet_ask')) parts.push('问了你');
  if (record.ms !== undefined && record.ms > 0) {
    parts.push(`${Math.max(1, Math.round(record.ms / 1000))} 秒`);
  }
  return parts.join(' · ');
}

/**
 * 输出流里的函数调用名。适配层不一定在 `output_item.added` 就带上名字，
 * 所以 `added` 与 `done` 都看；拿不到名字就当作不认识。
 */
function functionCallName(event: { type: string; item?: unknown }): string | null {
  if (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') return null;
  const item = event.item as { type?: string; name?: string } | null | undefined;
  if (!item || item.type !== 'function_call' || !item.name) return null;
  return item.name;
}

/**
 * 用户发言的事件类型。
 * 不能只看 `origin === 'external'`：World 推的事件默认就是 external，桌宠自己的
 * `desktop-pet.self`、生态箱公告等都会落库，把它们当成用户刚说过话会误挡下一轮。
 */
const USER_SPEECH_TYPES: ReadonlySet<string> = new Set([
  'console.message',
  'desktop-pet.message',
  'desktop-pet.speech',
  'desktop-pet.answer',
]);

/** 上面这些事件可能出现的 World；按来源查，避免被别的高频事件挤掉。 */
const USER_SPEECH_SOURCES: readonly string[] = ['console', 'desktop-pet'];

/** 用户消息的判定：只认真正由使用者打字、说话或作答的事件。 */
function latestUserEventAt(event: EventEnvelope, latest: number | null): number | null {
  if (event.source === WORLD_ID) return latest;
  if (!USER_SPEECH_TYPES.has(event.type)) return latest;
  const at = Date.parse(event.ts);
  if (Number.isNaN(at)) return latest;
  return latest === null || at > latest ? at : latest;
}
