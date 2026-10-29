/**
 * 定时判断的纯函数：时区换算、活跃时段与放行条件，外加一次概率判定。
 * 这里不读时钟也不排定时器，调用方把当前时刻和探针读数传进来，好测。
 */

/** 判断用到的配置项；时间一律毫秒。 */
export interface RhythmConfig {
  activeHours: string;
  idleMinMs: number;
  idleMaxMs: number;
  afterUserMessageMs: number;
  /** 每天成功开口的上限。 */
  maxPerDay: number;
  /** 每天叫模型的上限；0 表示不限。 */
  maxNudgesPerDay: number;
}

/** 跨轮次保留的调度状态。 */
export interface NudgeState {
  /** 上次叫醒模型的时刻。 */
  lastNudgeAtMs: number | null;
  /** 用户最后一次说话的时刻。 */
  lastUserMessageAtMs: number | null;
  /** 安静期结束的时刻。 */
  quietUntilMs: number | null;
  /** 今天成功开口的次数。 */
  todaySpoken: number;
  /** 今天叫醒模型的次数，没开口的也算。 */
  todayNudges: number;
}

/** 不搭话的原因；写进日志。 */
export type NudgeBlockReason =
  | 'quiet'
  | 'outside-hours'
  | 'daily-cap'
  | 'nudge-cap'
  | 'user-speaking'
  | 'user-active'
  | 'user-away';

export type NudgeDecision = { allowed: true } | { allowed: false; reason: NudgeBlockReason };

/** 本地时间的日期与时刻。 */
export interface ZonedClock {
  /** `YYYY-MM-DD`，按配置时区。 */
  dayKey: string;
  hour: number;
  minute: number;
}

const MINUTE_MS = 60_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 按 `timeZone` 取本地日期与时分；时区名无效时抛错，由调用方决定怎么报。 */
export function localParts(nowMs: number, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // 部分平台把午夜报成 24 点。
  const hour = Number(at('hour')) % 24;
  return {
    dayKey: `${at('year')}-${at('month')}-${at('day')}`,
    hour,
    minute: Number(at('minute')),
  };
}

/** 本地时刻，`HH:MM`。 */
export function formatClock(nowMs: number, timeZone: string): string {
  const { hour, minute } = localParts(nowMs, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** 时段以当天的分钟数表示。 */
export interface ActiveHours {
  startMinute: number;
  endMinute: number;
}

/** 解析 `HH:MM-HH:MM`；格式不对返回 null，由调用方按全天处理并记一次 warn。 */
export function parseActiveHours(spec: string): ActiveHours | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!match) return null;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59) return null;
  if (endHour === 24 && endMinute !== 0) return null;
  return { startMinute: startHour * 60 + startMinute, endMinute: endHour * 60 + endMinute };
}

/** 当前时刻是否落在时段内；起止相同表示全天，结束早于开始表示跨午夜。 */
export function withinActiveHours(hours: ActiveHours, hour: number, minute: number): boolean {
  const now = hour * 60 + minute;
  if (hours.startMinute === hours.endMinute) return true;
  if (hours.startMinute < hours.endMinute) {
    return now >= hours.startMinute && now < hours.endMinute;
  }
  return now >= hours.startMinute || now < hours.endMinute;
}

/** 一次判断的输入。 */
export interface NudgeInput {
  nowMs: number;
  zoned: ZonedClock;
  /** 探针读到的空闲时长。 */
  idleMs: number;
  state: NudgeState;
}

/** 只用内存状态就能判断的部分，不需要探针读数。 */
export type StaticNudgeInput = Pick<NudgeInput, 'nowMs' | 'zoned' | 'state'>;

/**
 * 先查不依赖探针的条件：安静期、活跃时段、每日上限、用户刚说过话。
 * 调用方可以先跑这一步，被拦下时就不必再读 PowerShell 或扫事件库。
 */
export function checkStaticGates(
  cfg: RhythmConfig,
  input: StaticNudgeInput,
  hours: ActiveHours | null = parseActiveHours(cfg.activeHours),
): NudgeDecision {
  const { nowMs, zoned, state } = input;

  if (state.quietUntilMs !== null && nowMs < state.quietUntilMs) {
    return { allowed: false, reason: 'quiet' };
  }

  if (hours && !withinActiveHours(hours, zoned.hour, zoned.minute)) {
    return { allowed: false, reason: 'outside-hours' };
  }

  if (state.todaySpoken >= cfg.maxPerDay) {
    return { allowed: false, reason: 'daily-cap' };
  }

  if (cfg.maxNudgesPerDay > 0 && state.todayNudges >= cfg.maxNudgesPerDay) {
    return { allowed: false, reason: 'nudge-cap' };
  }

  if (
    state.lastUserMessageAtMs !== null
    && nowMs - state.lastUserMessageAtMs < cfg.afterUserMessageMs
  ) {
    return { allowed: false, reason: 'user-speaking' };
  }

  return { allowed: true };
}

/**
 * 依次检查放行条件，全部通过才做概率判定。
 * 顺序固定：越靠前的越常拦下，日志里也更好读。
 */
export function checkNudge(cfg: RhythmConfig, input: NudgeInput): NudgeDecision {
  const staticDecision = checkStaticGates(cfg, input);
  if (!staticDecision.allowed) return staticDecision;

  const { idleMs } = input;

  // 最短空闲为 0：这一项被关掉，最长空闲跟着失效，用户在与不在都按其余条件判断。
  if (cfg.idleMinMs > 0) {
    if (idleMs < cfg.idleMinMs) {
      return { allowed: false, reason: 'user-active' };
    }

    if (idleMs > cfg.idleMaxMs) {
      return { allowed: false, reason: 'user-away' };
    }
  }

  return { allowed: true };
}

/** 一次概率判定：命中放行；否则累计未命中，达到保底也放行。 */
export function passesChance(
  probability: number,
  misses: number,
  pity: number,
  random: () => number,
): { pass: boolean; forced: boolean } {
  const hit = random() < Math.min(1, Math.max(0, probability));
  if (hit) return { pass: true, forced: false };
  return { pass: misses + 1 >= pity, forced: true };
}
