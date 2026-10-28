import { describe, expect, it } from 'vitest';
import { getByPath } from 'cortico/core/config-schema.ts';
import {
  AUTO_INTERACT_CONFIG_GROUP,
  AUTO_INTERACT_DEFAULTS,
  BASE_INTERVAL_MS,
  frequencyLevel,
  frequencyMinutes,
  frequencyOptions,
  frequencyProbability,
  pacedProbability,
  pityAfter,
} from '../src/config.ts';

const PREFIX = 'worlds.auto-interact.';

describe('配置段', () => {
  it('默认禁用，由部署启用', () => {
    expect(AUTO_INTERACT_DEFAULTS.enabled).toBe(false);
  });

  it('采集项、玩电脑、模型调速默认关闭', () => {
    expect(AUTO_INTERACT_DEFAULTS.allowScreenshot).toBe(false);
    expect(AUTO_INTERACT_DEFAULTS.shareWindowTitle).toBe(false);
    expect(AUTO_INTERACT_DEFAULTS.allowComputerPlay).toBe(false);
    expect(AUTO_INTERACT_DEFAULTS.allowModelAdjust).toBe(false);
  });

  it('时间项一律毫秒', () => {
    expect(AUTO_INTERACT_DEFAULTS.idleMinMs).toBe(2 * 60_000);
    expect(AUTO_INTERACT_DEFAULTS.idleMaxMs).toBe(45 * 60_000);
    expect(AUTO_INTERACT_DEFAULTS.afterUserMessageMs).toBe(8 * 60_000);
  });

  it('开口、叫醒、保底与频率档各就各位', () => {
    expect(AUTO_INTERACT_DEFAULTS.frequency).toBe('5');
    expect(AUTO_INTERACT_DEFAULTS.maxPerDay).toBe(12);
    expect(AUTO_INTERACT_DEFAULTS.maxNudgesPerDay).toBe(24);
    expect(AUTO_INTERACT_DEFAULTS.pityMisses).toBe(0);
  });

  it('每个声明的路径都在默认值里有对应项', () => {
    const paths = Object.keys(AUTO_INTERACT_CONFIG_GROUP.schema.properties);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith(PREFIX)).toBe(true);
      expect(getByPath(AUTO_INTERACT_DEFAULTS as unknown as Record<string, unknown>, path.slice(PREFIX.length)))
        .not.toBeUndefined();
    }
  });

  it('配置组归这个 World', () => {
    expect(AUTO_INTERACT_CONFIG_GROUP.owner).toBe('world:auto-interact');
    expect(AUTO_INTERACT_CONFIG_GROUP.id).toBe('world:auto-interact');
  });
});

describe('互动频率的档位', () => {
  it('基础节奏是 5 分钟一次', () => {
    expect(BASE_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('档位换算成命中概率与平均间隔', () => {
    expect(frequencyProbability('1')).toBe(0.05);
    expect(frequencyProbability('5')).toBe(0.3);
    expect(frequencyProbability('10')).toBe(1);
    expect(frequencyMinutes('1')).toBe(100);
    expect(frequencyMinutes('5')).toBe(17);
    expect(frequencyMinutes('10')).toBe(5);
  });

  it('读不懂的档位落在中间', () => {
    expect(frequencyLevel(undefined)).toBe(5);
    expect(frequencyLevel('abc')).toBe(5);
    expect(frequencyLevel(0)).toBe(1);
    expect(frequencyLevel(99)).toBe(10);
    expect(frequencyLevel('7')).toBe(7);
  });

  it('保底默认按两倍期望算，也可以手动指定', () => {
    expect(pityAfter('1')).toBe(40);
    expect(pityAfter('5')).toBe(7);
    expect(pityAfter('10')).toBe(2);
    expect(pityAfter('5', 10)).toBe(10);
    expect(pityAfter('5', 0)).toBe(7);
    expect(pityAfter('5', 1)).toBe(2);
  });

  it('模型调速乘在概率上，夹在 2% 到 100%', () => {
    expect(pacedProbability('5', 2)).toBeCloseTo(0.6);
    expect(pacedProbability('5', 0.5)).toBeCloseTo(0.15);
    expect(pacedProbability('10', 3)).toBe(1);
    expect(pacedProbability('1', 0.1)).toBeCloseTo(0.02);
  });

  it('下拉给十个带平均间隔的选项', () => {
    const options = frequencyOptions('zh');
    expect(options).toHaveLength(10);
    expect(options[0]).toEqual({ value: '1', label: '1 · 很低（约每 100 分钟）' });
    expect(options[9].label).toContain('最高');
    expect(frequencyOptions('en')[0].label).toBe('1 · very low (about every 100 min)');
  });
});
