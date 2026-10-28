import { describe, expect, it } from 'vitest';
import { createWindowsProbe, type PowerShellRunner } from '../src/probes/windows.ts';

interface Recorder {
  run: PowerShellRunner;
  scripts: string[];
}

function recorder(output: string): Recorder {
  const scripts: string[] = [];
  return {
    scripts,
    run: async (script) => {
      scripts.push(script);
      return output;
    },
  };
}

describe('空闲时长', () => {
  it('解析 JSON 读数', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify({ ok: true, idleMs: 1234 })).run });
    expect(await probe.idleMs()).toEqual({ ok: true, value: 1234 });
  });

  it('脚本报错转成失败', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify({ ok: false, error: 'Access denied' })).run });
    expect(await probe.idleMs()).toEqual({ ok: false, error: 'Access denied' });
  });

  it('负读数当失败', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify({ ok: true, idleMs: -1 })).run });
    expect((await probe.idleMs()).ok).toBe(false);
  });

  it('非 JSON 输出不崩', async () => {
    const probe = createWindowsProbe({ run: recorder('not json at all').run });
    const result = await probe.idleMs();
    expect(result.ok).toBe(false);
  });

  it('空输出给出原因', async () => {
    const probe = createWindowsProbe({ run: recorder('').run });
    expect(await probe.idleMs()).toEqual({ ok: false, error: 'PowerShell 没有输出' });
  });

  it('进程失败转成失败', async () => {
    const probe = createWindowsProbe({
      run: async () => {
        throw new Error('spawn powershell.exe ENOENT');
      },
    });
    expect((await probe.idleMs()).ok).toBe(false);
  });
});

describe('系统状态', () => {
  const payload = {
    ok: true,
    idleMs: 600_000,
    windowTitle: 'Visual Studio Code',
    cpuPercent: 12,
    memTotalMb: 32_768,
    memFreeMb: 20_480,
    uptimeMinutes: 200,
    disks: [{ mount: 'C:', totalMb: 953_674, freeMb: 524_288 }],
  };

  it('解析全部字段', async () => {
    const recorderHandle = recorder(JSON.stringify(payload));
    const probe = createWindowsProbe({ run: recorderHandle.run });
    const result = await probe.status({ includeWindowTitle: true });
    expect(result).toEqual({
      ok: true,
      value: {
        idleMs: 600_000,
        windowTitle: 'Visual Studio Code',
        cpuPercent: 12,
        memTotalMb: 32_768,
        memFreeMb: 20_480,
        uptimeMinutes: 200,
        disks: [{ mount: 'C:', totalMb: 953_674, freeMb: 524_288 }],
      },
    });
    expect(recorderHandle.scripts[0]).toContain('$includeWindow = $true');
  });

  it('不请求标题时不读窗口标题', async () => {
    const recorderHandle = recorder(JSON.stringify({ ...payload, windowTitle: null }));
    const probe = createWindowsProbe({ run: recorderHandle.run });
    const result = await probe.status({ includeWindowTitle: false });
    expect(recorderHandle.scripts[0]).toContain('$includeWindow = $false');
    expect(result.ok && result.value.windowTitle).toBeNull();
  });

  it('读不到性能计数器时 cpuPercent 为 null', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify({ ...payload, cpuPercent: null })).run });
    const result = await probe.status({ includeWindowTitle: false });
    expect(result.ok && result.value.cpuPercent).toBeNull();
  });
});

describe('截图', () => {
  const payload = {
    ok: true,
    width: 1280,
    height: 720,
    sourceWidth: 2560,
    sourceHeight: 1440,
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  };

  it('解码 base64 并带尺寸', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify(payload)).run });
    const result = await probe.capture({ maxWidth: 1280, quality: 70 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes.byteLength).toBe(4);
    expect(result.value.mime).toBe('image/jpeg');
    expect(result.value.sourceWidth).toBe(2560);
  });

  it('宽度与质量收进脚本前先收窄', async () => {
    const recorderHandle = recorder(JSON.stringify(payload));
    const probe = createWindowsProbe({ run: recorderHandle.run });
    await probe.capture({ maxWidth: 100, quality: 200 });
    expect(recorderHandle.scripts[0]).toContain('$maxWidth = 320');
    expect(recorderHandle.scripts[0]).toContain('Quality), 90');
  });

  it('没有图像数据当失败', async () => {
    const probe = createWindowsProbe({ run: recorder(JSON.stringify({ ...payload, data: '' })).run });
    expect((await probe.capture({ maxWidth: 1280, quality: 70 })).ok).toBe(false);
  });
});
