/** 假探针：返回测试指定的读数，记下每个方法被问了什么、问了几次。 */
import type {
  AutoInteractProbe,
  CaptureOptions,
  Probe,
  Screenshot,
  StatusOptions,
  SystemStatus,
} from '../../src/probes/windows.ts';

export interface FakeProbe extends AutoInteractProbe {
  calls: { idle: number; status: number; capture: number };
  lastStatus: StatusOptions | null;
  lastCapture: CaptureOptions | null;
}

export interface FakeProbeInit {
  idle?: Probe<number>;
  status?: Probe<SystemStatus>;
  capture?: Probe<Screenshot>;
}

export const SAMPLE_STATUS: SystemStatus = {
  idleMs: 10 * 60_000,
  windowTitle: 'Editor — world.ts',
  cpuPercent: 12,
  memTotalMb: 32_768,
  memFreeMb: 20_480,
  uptimeMinutes: 200,
  disks: [{ mount: 'C:', totalMb: 953_674, freeMb: 524_288 }],
};

export const SAMPLE_SHOT: Screenshot = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  mime: 'image/jpeg',
  width: 1280,
  height: 720,
  sourceWidth: 2560,
  sourceHeight: 1440,
};

export function fakeProbe(init: FakeProbeInit = {}): FakeProbe {
  const calls = { idle: 0, status: 0, capture: 0 };
  const probe: FakeProbe = {
    calls,
    lastStatus: null,
    lastCapture: null,
    async idleMs() {
      calls.idle += 1;
      return init.idle ?? { ok: true, value: SAMPLE_STATUS.idleMs };
    },
    async status(opts: StatusOptions) {
      calls.status += 1;
      probe.lastStatus = opts;
      return init.status ?? { ok: true, value: { ...SAMPLE_STATUS } };
    },
    async capture(opts: CaptureOptions) {
      calls.capture += 1;
      probe.lastCapture = opts;
      return init.capture ?? { ok: true, value: { ...SAMPLE_SHOT } };
    },
  };
  return probe;
}
