import { describe, expect, it } from 'vitest';
import {
  checkNudge,
  formatClock,
  localParts,
  parseActiveHours,
  passesChance,
  withinActiveHours,
  type NudgeState,
  type RhythmConfig,
} from '../src/scheduler.ts';

const MINUTE = 60_000;

const RHYTHM: RhythmConfig = {
  activeHours: '09:00-23:00',
  idleMinMs: 120_000,
  idleMaxMs: 2_700_000,
  afterUserMessageMs: 480_000,
  maxPerDay: 12,
  maxNudgesPerDay: 24,
};

const STATE: NudgeState = {
  lastNudgeAtMs: null,
  lastUserMessageAtMs: null,
  quietUntilMs: null,
  todaySpoken: 0,
  todayNudges: 0,
};

const AT_NOON = Date.parse('2026-10-28T10:00:00+08:00');

function input(overrides: Partial<{ idleMs: number; state: NudgeState; nowMs: number }> = {}) {
  return {
    nowMs: AT_NOON,
    zoned: { dayKey: '2026-10-28', hour: 10, minute: 0 },
    idleMs: 10 * MINUTE,
    state: { ...STATE },
    ...overrides,
  };
}

describe('活跃时段', () => {
  it('解析 HH:MM-HH:MM', () => {
    expect(parseActiveHours('09:00-23:00')).toEqual({ startMinute: 540, endMinute: 1380 });
    expect(parseActiveHours('22:30-02:15')).toEqual({ startMinute: 1350, endMinute: 135 });
  });

  it('格式不对返回 null', () => {
    expect(parseActiveHours('9 点到 23 点')).toBeNull();
    expect(parseActiveHours('25:00-26:00')).toBeNull();
    expect(parseActiveHours('09:70-10:00')).toBeNull();
  });

  it('普通时段与跨午夜时段', () => {
    const day = parseActiveHours('09:00-23:00')!;
    expect(withinActiveHours(day, 9, 0)).toBe(true);
    expect(withinActiveHours(day, 22, 59)).toBe(true);
    expect(withinActiveHours(day, 23, 0)).toBe(false);
    expect(withinActiveHours(day, 8, 59)).toBe(false);

    const night = parseActiveHours('22:00-02:00')!;
    expect(withinActiveHours(night, 23, 30)).toBe(true);
    expect(withinActiveHours(night, 1, 0)).toBe(true);
    expect(withinActiveHours(night, 12, 0)).toBe(false);
  });

  it('起止相同当作全天', () => {
    const all = parseActiveHours('00:00-00:00')!;
    expect(withinActiveHours(all, 3, 0)).toBe(true);
    expect(withinActiveHours(all, 23, 59)).toBe(true);
  });
});

describe('本地时间', () => {
  it('按配置时区取日期与时分', () => {
    const at = Date.parse('2026-10-28T03:05:00+08:00');
    expect(localParts(at, 'Asia/Shanghai')).toEqual({ dayKey: '2026-10-28', hour: 3, minute: 5 });
    // 同一时刻在 UTC 还是前一天。
    expect(localParts(at, 'UTC')).toEqual({ dayKey: '2026-10-27', hour: 19, minute: 5 });
    expect(formatClock(at, 'Asia/Shanghai')).toBe('03:05');
  });
});

describe('放行条件', () => {
  it('都满足时放行', () => {
    expect(checkNudge(RHYTHM, input())).toEqual({ allowed: true });
  });

  it('安静期挡下', () => {
    expect(checkNudge(RHYTHM, input({ state: { ...STATE, quietUntilMs: AT_NOON + 1_000 } })))
      .toEqual({ allowed: false, reason: 'quiet' });
  });

  it('时段外挡下', () => {
    const late = { nowMs: Date.parse('2026-10-28T23:30:00+08:00'), zoned: { dayKey: '2026-10-28', hour: 23, minute: 30 } };
    expect(checkNudge(RHYTHM, input(late))).toEqual({ allowed: false, reason: 'outside-hours' });
  });

  it('开口上限挡下', () => {
    expect(checkNudge(RHYTHM, input({ state: { ...STATE, todaySpoken: 12 } })))
      .toEqual({ allowed: false, reason: 'daily-cap' });
  });

  it('叫模型上限挡下，没开口的也算', () => {
    expect(checkNudge(RHYTHM, input({ state: { ...STATE, todayNudges: 24 } })))
      .toEqual({ allowed: false, reason: 'nudge-cap' });
  });

  it('叫模型上限为 0 表示不限', () => {
    expect(checkNudge({ ...RHYTHM, maxNudgesPerDay: 0 }, input({ state: { ...STATE, todayNudges: 999 } })))
      .toEqual({ allowed: true });
  });

  it('用户刚说过话挡下', () => {
    expect(checkNudge(RHYTHM, input({ state: { ...STATE, lastUserMessageAtMs: AT_NOON - 300_000 } })))
      .toEqual({ allowed: false, reason: 'user-speaking' });
  });

  it('用户正在操作挡下', () => {
    expect(checkNudge(RHYTHM, input({ idleMs: 30_000 }))).toEqual({ allowed: false, reason: 'user-active' });
  });

  it('用户离开太久挡下', () => {
    expect(checkNudge(RHYTHM, input({ idleMs: 5 * 3_600_000 })))
      .toEqual({ allowed: false, reason: 'user-away' });
  });
});

describe('概率判定', () => {
  it('命中就放行，不算保底', () => {
    expect(passesChance(0.5, 99, 4, () => 0.1)).toEqual({ pass: true, forced: false });
  });

  it('未命中就不放行', () => {
    expect(passesChance(0.1, 0, 40, () => 0.9)).toEqual({ pass: false, forced: true });
  });

  it('连续未命中到保底时强制放行', () => {
    expect(passesChance(0.05, 39, 40, () => 0.9)).toEqual({ pass: true, forced: true });
  });

  it('概率收在 0 到 1 之间', () => {
    expect(passesChance(2, 0, 2, () => 0.99).pass).toBe(true);
    expect(passesChance(-1, 0, 2, () => 0).pass).toBe(false);
  });
});
