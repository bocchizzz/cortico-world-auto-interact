/**
 * Windows 探针：用 `powershell.exe` 读空闲时长、系统状态和屏幕截图。
 * 全部结果只留在内存里，不写临时文件，不发网络请求。
 * 截图会随模型请求离开本机；调用方负责先确认配置允许。
 */
import { spawn } from 'node:child_process';

/** 探针结果；失败带一句给人看的原因。 */
export type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DiskUsage {
  mount: string;
  totalMb: number;
  freeMb: number;
}

export interface SystemStatus {
  idleMs: number;
  /** 未请求或读不到时为 null。 */
  windowTitle: string | null;
  /** 性能计数器读不到时为 null。 */
  cpuPercent: number | null;
  memTotalMb: number;
  memFreeMb: number;
  uptimeMinutes: number;
  disks: DiskUsage[];
}

export interface Screenshot {
  bytes: Uint8Array;
  mime: 'image/jpeg';
  width: number;
  height: number;
  /** 缩放前的虚拟桌面尺寸。 */
  sourceWidth: number;
  sourceHeight: number;
}

export interface StatusOptions {
  includeWindowTitle: boolean;
}

export interface CaptureOptions {
  maxWidth: number;
  quality: number;
}

/** World 依赖的探针接口；测试换成假实现。signal 用来在 World 停止时取消正在跑的进程。 */
export interface AutoInteractProbe {
  idleMs(signal?: AbortSignal): Promise<Probe<number>>;
  status(opts: StatusOptions, signal?: AbortSignal): Promise<Probe<SystemStatus>>;
  capture(opts: CaptureOptions, signal?: AbortSignal): Promise<Probe<Screenshot>>;
}

/** 一次 PowerShell 调用；返回值是标准输出的原文。 */
export type PowerShellRunner = (script: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;

const IDLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result = [ordered]@{ ok = $false; error = 'not run' }
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AutoInteractIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleMs() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) { return -1; }
    return (long)(uint)((uint)Environment.TickCount - li.dwTime);
  }
}
'@
$idle = [AutoInteractIdle]::IdleMs()
if ($idle -lt 0) { throw 'GetLastInputInfo returned false' }
$result = [ordered]@{ ok = $true; idleMs = [int64]$idle }
} catch {
$result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Compress
`;

const STATUS_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$includeWindow = __INCLUDE_WINDOW__
$result = [ordered]@{ ok = $false; error = 'not run' }
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AutoInteractWin {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  public static long IdleMs() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) { return -1; }
    return (long)(uint)((uint)Environment.TickCount - li.dwTime);
  }
  public static string Title() {
    var buffer = new StringBuilder(512);
    GetWindowTextW(GetForegroundWindow(), buffer, buffer.Capacity);
    return buffer.ToString();
  }
}
'@
$idle = [AutoInteractWin]::IdleMs()
if ($idle -lt 0) { throw 'GetLastInputInfo returned false' }
$title = $null
if ($includeWindow) { $title = [AutoInteractWin]::Title() }
$cpu = $null
try {
  $perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
  if ($null -ne $perf) { $cpu = [int]$perf.PercentProcessorTime }
} catch { $cpu = $null }
$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
$disks = New-Object System.Collections.ArrayList
foreach ($d in (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop)) {
  if ($null -eq $d.Size) { continue }
  [void]$disks.Add([ordered]@{ mount = [string]$d.DeviceID; totalMb = [int64]($d.Size / 1MB); freeMb = [int64]($d.FreeSpace / 1MB) })
}
$result = [ordered]@{
  ok = $true
  idleMs = [int64]$idle
  windowTitle = $title
  cpuPercent = $cpu
  memTotalMb = [int64]($os.TotalVisibleMemorySize / 1024)
  memFreeMb = [int64]($os.FreePhysicalMemory / 1024)
  uptimeMinutes = [int64](((Get-Date) - $os.LastBootUpTime).TotalMinutes)
  disks = @($disks)
}
} catch {
$result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Compress -Depth 4
`;

const CAPTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result = [ordered]@{ ok = $false; error = 'not run' }
try {
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AutoInteractDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[AutoInteractDpi]::SetProcessDPIAware() | Out-Null
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$source = New-Object System.Drawing.Bitmap -ArgumentList $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($source)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $source.Size)
$graphics.Dispose()
$maxWidth = __MAX_WIDTH__
$width = $source.Width
$height = $source.Height
if ($width -gt $maxWidth) {
  $height = [int][Math]::Max(1, [Math]::Round($height * $maxWidth / $width))
  $width = $maxWidth
}
$scaled = New-Object System.Drawing.Bitmap -ArgumentList $width, $height
$canvas = [System.Drawing.Graphics]::FromImage($scaled)
$canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$canvas.DrawImage($source, 0, 0, $width, $height)
$canvas.Dispose()
$source.Dispose()
$stream = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$params = New-Object System.Drawing.Imaging.EncoderParameters ([int]1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), __QUALITY__
$scaled.Save($stream, $codec, $params)
$scaled.Dispose()
$data = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$result = [ordered]@{
  ok = $true
  width = [int]$width
  height = [int]$height
  sourceWidth = [int]$bounds.Width
  sourceHeight = [int]$bounds.Height
  data = $data
}
} catch {
$result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Compress
`;

const PS_EXE = 'powershell.exe';

function firstLine(text: string, limit = 300): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * 默认实现：起一个隐藏窗口的 PowerShell 5.1 进程，脚本作为 `-Command` 的参数传入。
 * 不用 `-EncodedCommand`，也不加 `-ExecutionPolicy Bypass`：这两个参数最容易触发
 * 杀毒软件的脚本启发式；`-Command` 直接执行命令文本，不落脚本文件。
 * 这只能降低误报，不能保证所有安全软件都放行。
 */
const runPowerShell: PowerShellRunner = (script, timeoutMs, signal) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('PowerShell 已取消'));
      return;
    }

    const child = spawn(
      PS_EXE,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let stdoutChars = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const maxOutputChars = 64 * 1024 * 1024;

    const cleanup = (): void => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const fail = (message: string): void => {
      finish(() => reject(new Error(message)));
    };

    function onAbort(): void {
      child.kill();
      fail('PowerShell 已取消');
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutChars += chunk.length;
      if (stdoutChars > maxOutputChars) {
        child.kill();
        fail('PowerShell 输出过大');
        return;
      }
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      fail(error instanceof Error ? error.message : String(error));
    });

    child.on('close', (code) => {
      if (settled) return;
      if (signal?.aborted) {
        fail('PowerShell 已取消');
        return;
      }
      if (code === 0) {
        finish(() => resolve(stdout));
        return;
      }
      // stderr 可能是 PowerShell 的 CLIXML 进度噪声，那不是错误原因。
      const text = stderr.trim();
      const printable = text && !text.startsWith('#< CLIXML') ? firstLine(text) : '';
      fail(printable || 'PowerShell 执行失败，没有错误输出');
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    timeout = setTimeout(() => {
      child.kill();
      fail('PowerShell 超时未返回');
    }, timeoutMs);
    (timeout as { unref?: () => void }).unref?.();
  });
};

interface RawProbe {
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

function parseOutput(raw: string): Probe<RawProbe> {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'PowerShell 没有输出' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `无法解析 PowerShell 输出：${text.slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'PowerShell 输出不是对象' };
  }
  const object = parsed as RawProbe;
  if (object.ok !== true) {
    const message = typeof object.error === 'string' && object.error ? object.error : '未知错误';
    return { ok: false, error: message };
  }
  return { ok: true, value: object };
}

function toNumber(value: unknown): number | null {
  // JSON 的 null 经 Number() 会变成 0，读不到的读数必须保持「不知道」。
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toInteger(value: unknown, fallback: number): number {
  const n = toNumber(value);
  return n === null ? fallback : Math.round(n);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WindowsProbeOptions {
  /** 测试注入；默认真的起 PowerShell。 */
  run?: PowerShellRunner;
}

export function createWindowsProbe(opts: WindowsProbeOptions = {}): AutoInteractProbe {
  const run = opts.run ?? runPowerShell;

  return {
    async idleMs(signal?: AbortSignal): Promise<Probe<number>> {
      let output: string;
      try {
        output = await run(IDLE_SCRIPT, 12000, signal);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
      const parsed = parseOutput(output);
      if (!parsed.ok) return parsed;
      const value = toNumber(parsed.value.idleMs);
      if (value === null || value < 0) {
        return { ok: false, error: `空闲时长读数不可用：${String(parsed.value.idleMs)}` };
      }
      return { ok: true, value };
    },

    async status(options: StatusOptions, signal?: AbortSignal): Promise<Probe<SystemStatus>> {
      const script = STATUS_SCRIPT.replace('__INCLUDE_WINDOW__', options.includeWindowTitle ? '$true' : '$false');
      let output: string;
      try {
        output = await run(script, 20000, signal);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
      const parsed = parseOutput(output);
      if (!parsed.ok) return parsed;
      const raw = parsed.value;
      const idleMs = toNumber(raw.idleMs);
      const memTotalMb = toNumber(raw.memTotalMb);
      if (idleMs === null || memTotalMb === null) {
        return { ok: false, error: '系统状态缺少空闲时长或内存读数' };
      }
      const disks: DiskUsage[] = [];
      if (Array.isArray(raw.disks)) {
        for (const item of raw.disks) {
          if (!item || typeof item !== 'object') continue;
          const disk = item as Record<string, unknown>;
          const totalMb = toNumber(disk.totalMb);
          const freeMb = toNumber(disk.freeMb);
          if (totalMb === null || freeMb === null) continue;
          disks.push({ mount: String(disk.mount ?? '?'), totalMb, freeMb });
        }
      }
      return {
        ok: true,
        value: {
          idleMs,
          windowTitle: typeof raw.windowTitle === 'string' && raw.windowTitle !== '' ? raw.windowTitle : null,
          cpuPercent: toNumber(raw.cpuPercent),
          memTotalMb,
          memFreeMb: toNumber(raw.memFreeMb) ?? 0,
          uptimeMinutes: toNumber(raw.uptimeMinutes) ?? 0,
          disks,
        },
      };
    },

    async capture(options: CaptureOptions, signal?: AbortSignal): Promise<Probe<Screenshot>> {
      const maxWidth = Math.min(3840, Math.max(320, toInteger(options.maxWidth, 1280)));
      const quality = Math.min(90, Math.max(30, toInteger(options.quality, 70)));
      const script = CAPTURE_SCRIPT
        .replace('__MAX_WIDTH__', String(maxWidth))
        .replace('__QUALITY__', String(quality));
      let output: string;
      try {
        output = await run(script, 25000, signal);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
      const parsed = parseOutput(output);
      if (!parsed.ok) return parsed;
      const raw = parsed.value;
      if (typeof raw.data !== 'string' || !raw.data) {
        return { ok: false, error: '截图没有图像数据' };
      }
      const width = toNumber(raw.width);
      const height = toNumber(raw.height);
      const sourceWidth = toNumber(raw.sourceWidth);
      const sourceHeight = toNumber(raw.sourceHeight);
      if (width === null || height === null || sourceWidth === null || sourceHeight === null) {
        return { ok: false, error: '截图缺少尺寸数据' };
      }
      const bytes = Buffer.from(raw.data, 'base64');
      if (bytes.byteLength === 0) return { ok: false, error: '截图解码后是空的' };
      return {
        ok: true,
        value: { bytes, mime: 'image/jpeg', width, height, sourceWidth, sourceHeight },
      };
    },
  };
}
