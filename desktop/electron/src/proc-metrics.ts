/**
 * Opt-in process memory sampling for the desktop shell.
 *
 * A leak report needs to name the process that grows. Electron splits this
 * app across the browser process, the GPU process, utility processes and one
 * renderer per WebContents — and the shell keeps a retained WebContentsView
 * per profile origin plus the optional pet overlay window. A renderer PID
 * alone is not actionable, so every row is joined with the live webContents
 * list and prints its URL.
 *
 * Units: `app.getAppMetrics()` reports `memory.workingSetSize` in kilobytes,
 * `process.memoryUsage()` reports bytes. Both print as megabytes.
 *
 * Off unless `PHI_DESKTOP_METRICS` selects an interval. Pure DI: the Electron
 * surfaces arrive as parameters, so unit tests never construct real objects.
 * The pet package runs inside this same app process, so its renderer appears
 * in these rows without separate instrumentation.
 */
import type { ProcessMetric, WebContents } from 'electron';

/** Selects the sample interval: `1`/`on` for 10s, or milliseconds. */
export const METRICS_ENV_VAR = 'PHI_DESKTOP_METRICS';
export const DEFAULT_INTERVAL_MS = 10_000;
/** Below this, sampling costs more than the sampling itself. */
const MIN_INTERVAL_MS = 1_000;
/** URLs are long (file:// paths, deep links); keep rows one line wide. */
const MAX_URL_LENGTH = 96;

export interface MetricsHeap {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface MetricsRenderer {
  pid: number;
  url: string;
}

export interface ProcMetricsDeps {
  log(message: string): void;
  getAppMetrics(): ProcessMetric[];
  listRenderers(): MetricsRenderer[];
  heapUsage(): MetricsHeap;
  intervalMs: number;
}

export interface ProcMetricsSampler {
  /** Returns the rows for one sample and records it for the next delta. */
  sample(): string[];
}

/** Milliseconds between samples, or 0 when the sampler stays off. */
export function resolveIntervalMs(raw: string | undefined): number {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 0;
  if (value === '1' || value === 'on' || value === 'true') {
    return DEFAULT_INTERVAL_MS;
  }
  if (!/^\d+$/.test(value)) return 0;
  const ms = Number(value);
  if (ms <= 0) return 0;
  return Math.max(ms, MIN_INTERVAL_MS);
}

const kbToMb = (kb: number): number => Math.round(kb / 1024);
const bytesToMb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

const clip = (url: string): string =>
  url.length <= MAX_URL_LENGTH ? url : `${url.slice(0, MAX_URL_LENGTH - 1)}…`;

/**
 * Builds a sampler over the injected metrics sources. Each call to `sample`
 * returns the printer rows and updates the per-PID baseline used for the
 * `d=` (growth since the previous sample) column, which is the leak signal.
 */
export function createProcSampler(
  deps: ProcMetricsDeps,
  now: () => number = Date.now,
): ProcMetricsSampler {
  const previous = new Map<number, number>();
  const started = now();

  return {
    sample(): string[] {
      const elapsed = ((now() - started) / 1000).toFixed(1);
      const urls = new Map<number, string>();
      for (const renderer of deps.listRenderers()) {
        urls.set(renderer.pid, renderer.url);
      }

      const rows = deps
        .getAppMetrics()
        .map((metric) => ({
          metric,
          workingSet: metric.memory?.workingSetSize ?? 0,
        }))
        .sort((a, b) => b.workingSet - a.workingSet);

      let total = 0;
      const lines: string[] = [];
      // The baseline is rebuilt from this sample: a PID that disappeared is a
      // process that exited, so its successor starts clean instead of
      // inheriting a delta. It also keeps the map bounded on long runs.
      const current = new Map<number, number>();
      for (const { metric, workingSet } of rows) {
        total += workingSet;
        const before = previous.get(metric.pid);
        current.set(metric.pid, workingSet);
        const parts = [
          `phi-metrics   ${metric.type.padEnd(10)}`,
          `pid=${metric.pid}`,
          `ws=${kbToMb(workingSet)}MB`,
          `peak=${kbToMb(metric.memory?.peakWorkingSetSize ?? 0)}MB`,
        ];
        if (before !== undefined && before !== workingSet) {
          const delta = kbToMb(workingSet - before);
          parts.push(`d=${delta > 0 ? '+' : ''}${delta}MB`);
        }
        if (metric.serviceName) parts.push(`svc=${metric.serviceName}`);
        if (metric.name && metric.name !== metric.type) {
          parts.push(`name=${metric.name}`);
        }
        const cpu = metric.cpu?.percentCPUUsage;
        if (typeof cpu === 'number') parts.push(`cpu=${cpu.toFixed(1)}`);
        const url = urls.get(metric.pid);
        if (url) parts.push(`url=${clip(url)}`);
        lines.push(parts.join(' '));
      }

      const heap = deps.heapUsage();
      const header = [
        'phi-metrics',
        `t=+${elapsed}s`,
        `total=${kbToMb(total)}MB`,
        `main=${bytesToMb(heap.heapUsed)}MB/${bytesToMb(heap.heapTotal)}MB heap`,
        `rss=${bytesToMb(heap.rss)}MB`,
        `external=${bytesToMb(heap.external)}MB`,
        `arrayBuffers=${bytesToMb(heap.arrayBuffers)}MB`,
      ].join(' ');
      previous.clear();
      for (const [pid, workingSet] of current) previous.set(pid, workingSet);
      return [header, ...lines];
    },
  };
}

/**
 * Starts periodic sampling and returns a stop function. Idempotent per call:
 * the timer is unref'd so a leak run cannot keep the process alive on its own.
 */
export function startProcMetrics(
  deps: ProcMetricsDeps,
  now: () => number = Date.now,
): () => void {
  if (deps.intervalMs <= 0) return () => {};
  const sampler = createProcSampler(deps, now);
  const emit = (): void => {
    try {
      for (const line of sampler.sample()) deps.log(line);
    } catch (error) {
      deps.log(`phi-metrics: sample failed: ${String(error)}`);
    }
  };
  emit();
  const timer = setInterval(emit, deps.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The Electron surfaces the boot wiring reads, kept structural for tests. */
export interface ProcMetricsHost {
  getAppMetrics(): ProcessMetric[];
  getAllWebContents(): WebContents[];
}

/** Wires the sampler to the live app. Returns the stop function. */
export function installProcMetrics(
  host: ProcMetricsHost,
  rawInterval: string | undefined,
  log: (message: string) => void,
): () => void {
  const intervalMs = resolveIntervalMs(rawInterval);
  if (intervalMs <= 0) return () => {};
  log(`phi-metrics: sampling every ${intervalMs}ms`);
  return startProcMetrics({
    intervalMs,
    log,
    getAppMetrics: () => host.getAppMetrics(),
    heapUsage: () => process.memoryUsage(),
    listRenderers: () =>
      host
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed())
        .map((contents) => ({
          pid: contents.getOSProcessId(),
          url: contents.getURL(),
        })),
  });
}
