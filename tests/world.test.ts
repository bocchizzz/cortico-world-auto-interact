import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { EventEnvelope, ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { AUTO_INTERACT } from '../src/definition.ts';
import type { AutoInteractConfigSection } from '../src/config.ts';
import { AutoInteractWorld, WORLD_ID } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { fakeProbe, type FakeProbe, type FakeProbeInit } from './helpers/fake-probe.ts';

const TZ = 'Asia/Shanghai';
const MINUTE = 60_000;

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'auto-interact-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(scratchDir, { recursive: true, force: true });
});

interface Setup {
  world: AutoInteractWorld;
  host: FakeHost;
  cfg: AutoInteractConfigSection;
  probe: FakeProbe;
}

function setup(
  overrides: Partial<AutoInteractConfigSection> = {},
  probeInit: FakeProbeInit = {},
  random: () => number = () => 0.5,
): Setup {
  const ctx = fakeWorldContext(AUTO_INTERACT, { scratchDir });
  // 默认满命中，测试不用为随机数操心；要测概率的用例自己传 random 与频率档位。
  Object.assign(ctx.cfg, { enabled: true, frequency: '10' }, overrides);
  const probe = fakeProbe(probeInit);
  const world = new AutoInteractWorld({
    cfg: ctx.cfg,
    timezone: TZ,
    dataDir: scratchDir,
    probe,
    random,
    clock: () => Date.now(),
  });
  return { world, host: new FakeHost(), cfg: ctx.cfg, probe };
}

function nudges(host: FakeHost): EventEnvelope[] {
  return host.events.filter((e) => e.type === `${WORLD_ID}.nudge`);
}

async function runTool(
  world: AutoInteractWorld,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const tool = world.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  const result = await tool.handler(args, {} as ToolCallContext);
  return typeof result === 'string' ? { text: result } : result;
}

describe('构造与声明', () => {
  it('干装载不报失败', async () => {
    const report = await dryMountWorld(AUTO_INTERACT, { scratchDir, hasWebUiClient: true });
    expect(report.failures).toEqual([]);
  });

  it('旧版本留下的配置缺键时按默认值补齐', () => {
    const legacy = {
      enabled: true,
      style: 'gentle',
      intervalMinutes: 5,
    } as unknown as AutoInteractConfigSection;
    new AutoInteractWorld({ cfg: legacy, timezone: TZ, probe: fakeProbe(), clock: () => Date.now() });
    expect(legacy.frequency).toBe('5');
    expect(legacy.allowModelAdjust).toBe(false);
    expect(legacy.maxNudgesPerDay).toBe(24);
    expect(legacy.note).toBe('');
  });

  it('挂载时记一条 started，不唤醒模型', async () => {
    const { world, host } = setup();
    await world.start(host);
    const started = host.events.find((e) => e.type === `${WORLD_ID}.started`);
    expect(started?.origin).toBe('internal');
    expect(host.pushOpts[0]).toEqual({ deliver: false });
    await world.stop();
  });
});

describe('定时判断', () => {
  it('到点且条件满足时推 nudge 并立即投递', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    const [nudge] = nudges(host);
    expect(nudge).toBeTruthy();
    expect(nudge.text).toContain('10:05');
    expect(nudge.text).toContain('今天的第 1 次邀约');
    expect(host.pushOpts[host.events.indexOf(nudge)]).toEqual({ trigger: 'flush' });
    await world.stop();
  });

  it('活跃时段外不搭话', async () => {
    vi.setSystemTime(new Date('2026-10-28T03:00:00+08:00'));
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('用户正在操作时不打扰', async () => {
    const { world, host } = setup({}, { idle: { ok: true, value: 20_000 } });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('用户离开太久时跳过', async () => {
    const { world, host } = setup({}, { idle: { ok: true, value: 5 * 60 * MINUTE } });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('最短空闲为 0 时不看空闲状态，也不起探针', async () => {
    const { world, host, probe } = setup({ idleMinMs: 0 }, { idle: { ok: true, value: 5 * 60 * MINUTE } });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const [nudge] = nudges(host);
    expect(nudge).toBeTruthy();
    expect(nudge.text).toContain('现在是 10:05。');
    expect(nudge.text).not.toContain('没有操作电脑');
    expect(probe.calls.idle).toBe(0);
    await world.stop();
  });

  it('每天上限用完就停', async () => {
    const { world, host } = setup({ maxPerDay: 0 });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('未命中就叫不醒模型', async () => {
    const { world, host } = setup({ frequency: '1' }, {}, () => 0.99);
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('连续未命中到保底会强制叫一次', async () => {
    const { world, host } = setup({ frequency: '1' }, {}, () => 0.99);
    await world.start(host);
    // 1 档保底 40 次；前 39 次都不中，第 40 次强制放行。
    await vi.advanceTimersByTimeAsync(39 * 5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const [nudge] = nudges(host);
    expect(nudge.text).toContain('保底');
    await world.stop();
  });

  it('用户刚说过话就等一等', async () => {
    const { world, host } = setup();
    host.stored = [{
      cursor: 1,
      type: 'console.message',
      ts: '2026-10-28T10:23:00+08:00',
      source: 'console',
      origin: 'internal',
      text: '在吗',
    } as EventEnvelope];
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it.each(['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.answer'])(
    '%s 算用户说话，挡住下一轮',
    async (type) => {
      const { world, host } = setup();
      host.stored = [{
        cursor: 1,
        type,
        ts: '2026-10-28T10:04:00+08:00',
        source: 'desktop-pet',
        origin: 'external',
        text: '',
      } as EventEnvelope];
      await world.start(host);
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(nudges(host)).toHaveLength(0);
      await world.stop();
    },
  );

  it.each([
    ['desktop-pet.self', 'desktop-pet'],
    ['desktop-pet.touch', 'desktop-pet'],
    ['terrarium.announcement', 'terrarium'],
  ])('%s 不算用户说话，不会挡下一轮', async (type, source) => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(1);

    // 桌宠自己的发言、戳一戳、别的 World 的公告都带 origin: external，
    // 但它们不是用户说的，不能重置「用户说话后等待」。
    host.stored = [{
      cursor: 2,
      type,
      ts: '2026-10-28T10:05:10+08:00',
      source,
      origin: 'external',
      contextDelivery: type === 'desktop-pet.self' ? 'archive-only' : 'deliver',
      text: '',
    } as EventEnvelope];

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(2);
    await world.stop();
  });

  it('用户说话后等够了就恢复', async () => {
    const { world, host } = setup();
    host.stored = [{
      cursor: 1,
      type: 'desktop-pet.message',
      ts: '2026-10-28T10:04:00+08:00',
      source: 'desktop-pet',
      origin: 'external',
      text: '',
    } as EventEnvelope];
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);

    // 10:15 距 10:04 已超过默认的 8 分钟。
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(nudges(host)).toHaveLength(1);
    await world.stop();
  });

  it('读空闲时长失败时不搭话也不抛错', async () => {
    const { world, host } = setup({}, { idle: { ok: false, error: 'denied' } });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
    await world.stop();
  });

  it('stop 之后不再判断', async () => {
    const { world, host } = setup();
    await world.start(host);
    await world.stop();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(nudges(host)).toHaveLength(0);
  });
});

describe('安静期', () => {
  it('auto_quiet 挡住这一轮，结束后恢复', async () => {
    const { world, host } = setup();
    await world.start(host);
    const quiet = await runTool(world, 'auto_quiet', { minutes: 12 });
    expect(quiet.text).toContain('安静到 10:12');

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(1);
    await world.stop();
  });

  it('minutes 为 0 时取消安静期', async () => {
    const { world, host } = setup();
    await world.start(host);
    await runTool(world, 'auto_quiet', { minutes: 30 });
    const cancel = await runTool(world, 'auto_quiet', { minutes: 0 });
    expect(cancel.text).toContain('取消');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(1);
    await world.stop();
  });
});

describe('看屏幕', () => {
  it('截图关闭时 auto_look 直接失败', async () => {
    const { world, host } = setup();
    await world.start(host);
    const outcome = await runTool(world, 'auto_look');
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('允许截图');
    await world.stop();
  });

  it('允许截图且模型收图时回执带 JPEG', async () => {
    const { world, host } = setup({ allowScreenshot: true });
    await world.start(host);
    host.acceptsImage = true;
    const outcome = await runTool(world, 'auto_look');
    expect(outcome.failed).toBeUndefined();
    expect(outcome.blobs).toHaveLength(1);
    const blob = outcome.blobs?.[0] as { mime?: string; bytes?: Uint8Array };
    expect(blob.mime).toBe('image/jpeg');
    expect(blob.bytes?.byteLength).toBeGreaterThan(0);
    await world.stop();
  });

  it('模型不收图时只回文字', async () => {
    const { world, host } = setup({ allowScreenshot: true });
    await world.start(host);
    const outcome = await runTool(world, 'auto_look');
    expect(outcome.blobs).toBeUndefined();
    expect(outcome.text).toContain('不接受图片');
  });
});

describe('看状态', () => {
  it('auto_status 默认不带窗口标题，打开后带上', async () => {
    const { world, host, cfg } = setup();
    await world.start(host);
    const plain = await runTool(world, 'auto_status');
    expect(plain.text).toContain('空闲：10 分钟');
    expect(plain.text).not.toContain('前台窗口');

    cfg.shareWindowTitle = true;
    const titled = await runTool(world, 'auto_status');
    expect(titled.text).toContain('前台窗口：Editor — world.ts');
    await world.stop();
  });

  it('auto_plan 报出节奏与今日次数', async () => {
    const { world, host } = setup();
    await world.start(host);
    const plan = await runTool(world, 'auto_plan');
    expect(plan.text).toContain('下次判定');
    expect(plan.text).toContain('今日已开口：0 / 12');
    expect(plan.text).toContain('在时段内');
    await world.stop();
  });
});

describe('环境提示词', () => {
  it('变量跟着配置现读', () => {
    const { world, cfg } = setup({ note: '晚上别太吵' });
    expect(world.envPromptVars()).toEqual({
      'auto.rhythm': expect.stringContaining('平均每 5 分钟'),
      'auto.play': '',
      'auto.pace': '',
      'auto.note': '晚上别太吵',
    });
    cfg.frequency = '8';
    cfg.allowComputerPlay = true;
    expect(world.envPromptVars()['auto.rhythm']).toContain('65%');
    expect(world.envPromptVars()['auto.play']).toContain('pet_ask');
  });
});

interface RecordsPayload {
  records: Array<{ at: string; text: string; outcome: string; tone: string; detail: string }>;
}

async function records(world: AutoInteractWorld): Promise<RecordsPayload> {
  const invoke = world.webUi('zh').invoke;
  if (!invoke) throw new Error('webUi() has no invoke');
  return await invoke('records', 'list', []) as RecordsPayload;
}

describe('互动记录', () => {
  it('数据面挂在 webUi() 的返回对象上', async () => {
    const { world } = setup();
    const decl = world.webUi('zh');
    expect(typeof decl.invoke).toBe('function');
    expect(decl.panels?.map((panel) => panel.id)).toEqual(['guide', 'records']);
    await expect(decl.invoke!('records', 'nope', [])).rejects.toThrow('unknown method');
  });

  it('跳过的一轮写清楚原因', async () => {
    const { world, host } = setup({ maxPerDay: 0 });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const { records: rows } = await records(world);
    expect(rows[0]).toMatchObject({ at: '10:05', text: '跳过：今天开口次数用满', outcome: '' });
    await world.stop();
  });

  it('邀约上限用完也停，沉默的邀约照样计数', async () => {
    const { world, host } = setup({ maxNudgesPerDay: 1, frequency: '10' });
    await world.start(host);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(1);
    world.onEventsSettled([nudges(host)[0]], 'delivered');
    world.onTurnEnded();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const { records: rows } = await records(world);
    expect(rows[0]).toMatchObject({ text: '跳过：今天叫模型次数用满' });
    expect(nudges(host)).toHaveLength(1);
    await world.stop();
  });

  it('邀约之后调了 pet_say 记成开口了', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const [nudge] = nudges(host);
    world.onEventsSettled([nudge], 'delivered');
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'pet_say' },
    } as never);
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0]).toMatchObject({ text: '主动搭话', outcome: '开口了', tone: 'ok' });
    await world.stop();
  });

  it('只在 output_item.done 里带名字也算开口', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');
    // 有的适配层在 added 里还没填名字，只在 done 里给。
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'pet_say', status: 'completed' },
    } as never);
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0].outcome).toBe('开口了');
    await world.stop();
  });

  it('记下这一轮用过的工具和耗时', async () => {
    const { world, host } = setup({ allowScreenshot: true });
    await world.start(host);
    host.acceptsImage = true;
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');

    await runTool(world, 'auto_look');
    await runTool(world, 'auto_status');
    const tap = world.outputTap?.();
    tap?.onEvent({ type: 'response.output_item.done', item: { type: 'function_call', name: 'auto_look' } } as never);
    tap?.onEvent({ type: 'response.output_item.done', item: { type: 'function_call', name: 'auto_status' } } as never);
    vi.setSystemTime(new Date('2026-10-28T10:05:08+08:00'));
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0].detail).toBe('看了屏幕 · 看了状态 · 8 秒');
    await world.stop();
  });

  it('截图关着时记录不写看了屏幕', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');

    await runTool(world, 'auto_look');
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'auto_look' },
    } as never);
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0].detail).toContain('没看屏幕（截图已关闭）');
    expect(rows[0].detail).not.toContain('看了屏幕');
    await world.stop();
  });

  it('截图失败时记录也不写看了屏幕', async () => {
    const { world, host } = setup(
      { allowScreenshot: true },
      { capture: { ok: false, error: '访问被拒绝' } },
    );
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');

    await runTool(world, 'auto_look');
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'auto_look' },
    } as never);
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0].detail).toContain('没看屏幕（截图失败）');
    await world.stop();
  });

  it('调速记录写清调整后的倍率与间隔', async () => {
    const { world, host } = setup({ allowModelAdjust: true });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');

    await runTool(world, 'auto_pace', { factor: 0.5, minutes: 30 });
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'auto_pace' },
    } as never);
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0].detail).toContain('调了频率：0.5 倍');
    expect(rows[0].detail).toContain('约每 10 分钟一次');
    expect(rows[0].detail).toContain('到 10:35 恢复');
    await world.stop();
  });

  it('没调 pet_say 记成没开口', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');
    world.onTurnEnded();

    const { records: rows } = await records(world);
    expect(rows[0]).toMatchObject({ outcome: '没开口', tone: 'warn' });
    await world.stop();
  });

  it('事件被清掉记成被清掉了', async () => {
    const { world, host } = setup();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'discarded');

    const { records: rows } = await records(world);
    expect(rows[0]).toMatchObject({ outcome: '被清掉了' });
    await world.stop();
  });

  it('记录写到部署数据目录，重启后还在', async () => {
    const first = setup({ maxPerDay: 0 });
    await first.world.start(first.host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await first.world.stop();

    const file = join(scratchDir, 'auto-interact-records.json');
    expect(existsSync(file)).toBe(true);

    const second = setup({ maxPerDay: 0 });
    const { records: rows } = await records(second.world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: '跳过：今天开口次数用满' });
  });

  it('记录页能清掉记录和文件', async () => {
    const first = setup({ maxPerDay: 0 });
    await first.world.start(first.host);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await first.world.stop();

    const invoke = first.world.webUi('zh').invoke!;
    expect(first.world.webUi('zh').storage).toBeUndefined();
    await invoke('records', 'clear', []);

    const file = join(scratchDir, 'auto-interact-records.json');
    expect(existsSync(file)).toBe(false);
    const { records: rows } = await records(first.world);
    expect(rows).toEqual([]);
  });
});

describe('开口计数与强制开口', () => {
  it('没开口不占每天开口的名额', async () => {
    const { world, host } = setup({ maxPerDay: 1, frequency: '10' });
    await world.start(host);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    world.onEventsSettled([nudges(host)[0]], 'delivered');
    world.onTurnEnded(); // 沉默

    // 今天还没开口，第二次邀约照发。
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(2);

    world.onEventsSettled([nudges(host)[1]], 'delivered');
    world.outputTap?.()?.onEvent({
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'pet_say' },
    } as never);
    world.onTurnEnded(); // 开口

    // 开口名额用完，第三次不再发。
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)).toHaveLength(2);
    await world.stop();
  });

  it('连续三次没开口时，下一次邀约把要求写死', async () => {
    const { world, host } = setup({ frequency: '10' });
    await world.start(host);

    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      world.onEventsSettled([nudges(host)[index]], 'delivered');
      world.onTurnEnded();
    }

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const forced = nudges(host)[3];
    expect(forced.text).toContain('连续 3 次');
    expect(forced.text).toContain('一定说点什么');
    await world.stop();
  });

  it('没到三次时不加码', async () => {
    const { world, host } = setup({ frequency: '10' });
    await world.start(host);

    for (let index = 0; index < 2; index += 1) {
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      world.onEventsSettled([nudges(host)[index]], 'delivered');
      world.onTurnEnded();
    }

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(nudges(host)[2].text).not.toContain('一定说点什么');
    await world.stop();
  });
});
