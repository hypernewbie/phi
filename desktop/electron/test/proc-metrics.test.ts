// @vitest-environment node
/**
 * Unit tests for src/proc-metrics.ts. The module imports Electron only for
 * types (erased at runtime), so every surface here is a plain fake: no real
 * app, no real WebContents, no timers unless the test installs them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessMetric, WebContents } from 'electron';
import {
  createProcSampler,
  DEFAULT_INTERVAL_MS,
  installProcMetrics,
  resolveIntervalMs,
  startProcMetrics,
  type MetricsHeap,
} from '../src/proc-metrics.js';

const KB = 1024;

const metric = (
  pid: number,
  type: string,
  workingSetKb: number,
  peakKb = workingSetKb,
  extra: Partial<ProcessMetric> = {},
): ProcessMetric =>
  ({
    pid,
    type,
    memory: { workingSetSize: workingSetKb, peakWorkingSetSize: peakKb },
    cpu: { percentCPUUsage: 1.25, idleWakeupsPerSecond: 0 },
    creationTime: 0,
    ...extra,
  }) as ProcessMetric;

const heap: MetricsHeap = {
  rss: 200 * 1024 * 1024,
  heapUsed: 40 * 1024 * 1024,
  heapTotal: 64 * 1024 * 1024,
  external: 8 * 1024 * 1024,
  arrayBuffers: 2 * 1024 * 1024,
};

describe('resolveIntervalMs', () => {
  it('stays off for absent and disabled values', () => {
    expect(resolveIntervalMs(undefined)).toBe(0);
    expect(resolveIntervalMs('')).toBe(0);
    expect(resolveIntervalMs('0')).toBe(0);
    expect(resolveIntervalMs('off')).toBe(0);
    expect(resolveIntervalMs('nope')).toBe(0);
  });

  it('treats 1/on/true as the default interval', () => {
    expect(resolveIntervalMs('1')).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs('on')).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs('TRUE')).toBe(DEFAULT_INTERVAL_MS);
  });

  it('accepts explicit milliseconds but clamps racy values', () => {
    expect(resolveIntervalMs('2500')).toBe(2500);
    expect(resolveIntervalMs('5')).toBe(1000);
  });
});

describe('createProcSampler', () => {
  it('prints one header plus one row per process, hog first', () => {
    let now = 0;
    const sampler = createProcSampler(
      {
        log: () => {},
        intervalMs: 1000,
        heapUsage: () => heap,
        listRenderers: () => [],
        getAppMetrics: () => [
          metric(1, 'Browser', 10 * KB),
          metric(7, 'Tab', 900 * KB),
          metric(2, 'GPU', 40 * KB),
        ],
      },
      () => (now += 10_000),
    );

    const lines = sampler.sample();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('phi-metrics t=+10.0s');
    expect(lines[0]).toContain('total=950MB');
    expect(lines[0]).toContain('main=40MB/64MB heap');
    expect(lines[1]).toContain('pid=7');
    expect(lines[2]).toContain('pid=2');
    expect(lines[3]).toContain('pid=1');
  });

  it('reports growth against the previous sample only', () => {
    let now = 0;
    let workingSet = 100 * KB;
    const sampler = createProcSampler(
      {
        log: () => {},
        intervalMs: 1000,
        heapUsage: () => heap,
        listRenderers: () => [],
        getAppMetrics: () => [metric(7, 'Tab', workingSet)],
      },
      () => (now += 10_000),
    );

    expect(sampler.sample()[1]).not.toContain(' d=');
    workingSet = 612 * KB;
    expect(sampler.sample()[1]).toContain(' d=+512MB');
    workingSet = 100 * KB;
    expect(sampler.sample()[1]).toContain(' d=-512MB');
  });

  it('resets the baseline for a PID that exited and returned', () => {
    let present = true;
    const sampler = createProcSampler({
      log: () => {},
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [],
      getAppMetrics: () => (present ? [metric(7, 'Tab', 100 * KB)] : []),
    });

    expect(sampler.sample()[1]).toContain('ws=100MB');
    present = false;
    expect(sampler.sample()).toHaveLength(1);
    present = true;
    // A recycled PID is a new process: no delta against the dead one.
    expect(sampler.sample()[1]).not.toContain(' d=');
  });

  it('joins each renderer PID to its URL and survives a missing one', () => {
    const sampler = createProcSampler({
      log: () => {},
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [{ pid: 7, url: 'phi-app://app' }],
      getAppMetrics: () => [metric(7, 'Tab', KB), metric(8, 'GPU', KB)],
    });

    const lines = sampler.sample();
    const tab = lines.find((line) => line.includes('pid=7')) ?? '';
    const gpu = lines.find((line) => line.includes('pid=8')) ?? '';
    expect(tab).toContain('url=phi-app://app');
    expect(gpu).not.toContain('url=');
  });

  it('clips long URLs so a row stays one line', () => {
    const url = `file:///Users/dev/${'a'.repeat(300)}/pet.html`;
    const sampler = createProcSampler({
      log: () => {},
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [{ pid: 9, url }],
      getAppMetrics: () => [metric(9, 'Tab', KB)],
    });

    const row = sampler.sample()[1];
    expect(row).not.toContain('\n');
    expect(row).toContain('…');
    expect(row.length).toBeLessThan(180);
  });

  it('prints the peak and named/CPU columns when present', () => {
    const sampler = createProcSampler({
      log: () => {},
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [],
      getAppMetrics: () => [
        metric(3, 'Utility', 2 * KB, 8 * KB, {
          serviceName: 'network.mojom.NetworkService',
          name: 'network',
        }),
      ],
    });

    const row = sampler.sample()[1];
    expect(row).toContain('peak=8MB');
    expect(row).toContain('svc=network.mojom.NetworkService');
    expect(row).toContain('name=network');
    expect(row).toContain('cpu=1.3');
  });
});

describe('startProcMetrics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays off for a non-positive interval', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const stop = startProcMetrics({
      log,
      intervalMs: 0,
      heapUsage: () => heap,
      listRenderers: () => [],
      getAppMetrics: () => [metric(1, 'Browser', KB)],
    });
    vi.advanceTimersByTime(60_000);
    expect(log).not.toHaveBeenCalled();
    stop();
  });

  it('emits immediately, then once per interval until stopped', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const stop = startProcMetrics({
      log,
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [],
      getAppMetrics: () => [metric(1, 'Browser', KB)],
    });

    expect(log).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000);
    expect(log).toHaveBeenCalledTimes(8);
    stop();
    vi.advanceTimersByTime(5000);
    expect(log).toHaveBeenCalledTimes(8);
  });

  it('keeps sampling after one failed sample', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let calls = 0;
    const stop = startProcMetrics({
      log,
      intervalMs: 1000,
      heapUsage: () => heap,
      listRenderers: () => [],
      getAppMetrics: () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return [metric(1, 'Browser', KB)];
      },
    });

    vi.advanceTimersByTime(2000);
    expect(log.mock.calls.some(([line]) => String(line).includes('boom'))).toBe(
      true,
    );
    expect(
      log.mock.calls.some(([line]) => String(line).includes('pid=1')),
    ).toBe(true);
    stop();
  });
});

describe('installProcMetrics', () => {
  const contents = (pid: number, url: string, destroyed = false): WebContents =>
    ({
      isDestroyed: () => destroyed,
      getOSProcessId: () => pid,
      getURL: () => url,
    }) as unknown as WebContents;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent when the environment leaves it off', () => {
    const log = vi.fn();
    const stop = installProcMetrics(
      { getAppMetrics: () => [], getAllWebContents: () => [] },
      undefined,
      log,
    );
    stop();
    expect(log).not.toHaveBeenCalled();
  });

  it('reads live metrics and skips destroyed contents', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const stop = installProcMetrics(
      {
        getAppMetrics: () => [metric(7, 'Tab', 2 * KB)],
        getAllWebContents: () => [
          contents(7, 'http://127.0.0.1:17070/'),
          contents(7, 'phi-app://app', true),
        ],
      },
      '1',
      log,
    );

    const printed = log.mock.calls.map(([line]) => String(line));
    expect(printed[0]).toContain('sampling every 10000ms');
    const row = printed.find((line) => line.includes('pid=7')) ?? '';
    expect(row).toContain('url=http://127.0.0.1:17070/');
    stop();
  });
});
