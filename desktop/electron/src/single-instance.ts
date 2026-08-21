/**
 * Single-instance gate and phi:// argv routing for the Electron main
 * process — parity with the Wails `desktop/internal/single` package.
 *
 * Gate: `app.requestSingleInstanceLock()` is the gate's first app call. The
 * primary instance installs the `second-instance` listener (classify argv →
 * post one `ForwardPayload` per forwardable arg → foreground the main window
 * via `restore()`+`focus()`). The losing side classifies its argv (parity
 * with the Wails `Forward` path) and calls `app.quit()` — Electron delivers
 * the second launch's argv to the primary automatically, so no inter-instance
 * pipe exists. The listener itself is installed lazily via
 * `installListener()` (the phase-4 ordering: gate -> window -> tray ->
 * second-instance listener), so a second launch that foregrounds the window
 * always finds the window and the tray ready.
 *
 * The IPC contract (typed):
 *   channel: 'phi:single-instance-forward'
 *   payload: { kind: 'deep-link' | 'server', value: string }
 *     - kind 'deep-link' -> value is a phi:// URL
 *     - kind 'server'    -> value is an http(s):// server URL
 *
 * Server routing: when setupSingleInstance is given an `onServerUrl`
 * callback (the exact incoming-server routing), classified server
 * payloads from a second launch are handed to it — the running main
 * process activates the server profile directly — instead of being
 * forwarded on the channel; deep links keep the forward-to-window path.
 * Without the callback, every forwardable arg is forwarded (the phase-2
 * contract, unchanged).
 *
 * Argv classification (mirrors single.ClassifyArgs):
 *   - "phi://..."     -> { kind: 'deep-link', value }
 *   - "http(s)://..." -> { kind: 'server', value }
 *   - flags, "--", empty strings and junk -> dropped, never forwarded
 *   - the value of --server is a positional-looking URL and is classified
 *     like any other URL; flags themselves are never forwarded.
 */
import { app } from 'electron';

/** IPC channel a second launch's args are forwarded on. */
export const FORWARD_CHANNEL = 'phi:single-instance-forward';

/** One forwarded launch arg (the typed IPC payload). */
export interface ForwardPayload {
  kind: 'deep-link' | 'server';
  value: string;
}

/** The window surface the gate needs (BrowserWindow satisfies it). */
export interface SingleInstanceWindow {
  webContents: {
    send(channel: string, payload: unknown): void;
    isDestroyed(): boolean;
  };
  isDestroyed(): boolean;
  restore(): void;
  focus(): void;
  isMinimized(): boolean;
}

/** A live window or a lazy accessor (the main window is created after the gate). */
export type WindowProvider =
  | SingleInstanceWindow
  | (() => SingleInstanceWindow | null)
  | null;

export interface AcquireResult {
  /** True when this process lost the single-instance lock. */
  lost: boolean;
  /** True when argv contained at least one forwardable phi:// or http(s):// arg. */
  forwarded: boolean;
}

export interface SingleInstanceHandle {
  /** True when this process is the primary (lock-owning) instance. */
  primary: boolean;
  /**
   * Losing-side path: classify argv (parity with the Wails `Forward` path)
   * and quit. Electron already delivered this launch's argv to the running
   * instance via the second-instance event, so no explicit send happens
   * here — the classification documents/verifies what will be routed.
   */
  acquire(argv: string[]): AcquireResult;
  /**
   * Installs the `second-instance` listener on the primary. Deferred so
   * the host loop can build the main window and the tray first (migration
   * phase-4 ordering: gate -> window -> tray -> second-instance listener),
   * guaranteeing a second launch that foregrounds the window always finds
   * both ready. No-op for the losing side.
   */
  installListener(): void;
}

/**
 * The optional server-URL sink: when provided, classified server payloads
 * from a second launch are handed to it (value = the http(s):// URL)
 * instead of being forwarded on the forward channel. Deep links are
 * always forwarded. Absent: every forwardable arg is forwarded (the
 * phase-2 contract, unchanged).
 */
export type ServerUrlHandler = (url: string) => void;
/** Host-owned delivery is asynchronous-safe across a destroyed shell. */
export type LaunchPayloadHandler = (payloads: ForwardPayload[]) => void;

/**
 * Classifies positional launch args into forward payloads. phi:// args
 * become deep-link payloads; http(s):// args become server payloads;
 * flags, empty strings and junk are dropped (never forwarded).
 */
export function classifyArgv(argv: string[]): ForwardPayload[] {
  const payloads: ForwardPayload[] = [];
  for (const arg of argv) {
    const payload = buildForwardPayload(arg);
    if (payload) payloads.push(payload);
  }
  return payloads;
}

/**
 * Builds one forward payload from a single arg, or null when the arg is a
 * flag, empty, or junk. The phi:// prefix check is exact (case-sensitive,
 * like the Wails side); http/https scheme matching is case-insensitive per
 * URL parsing rules (also like the Wails side, which lowercases schemes).
 */
export function buildForwardPayload(raw: string): ForwardPayload | null {
  if (raw === '' || raw.startsWith('-')) return null;
  if (raw.startsWith('phi://')) return { kind: 'deep-link', value: raw };
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { kind: 'server', value: raw };
    }
  } catch {
    // Not a URL: junk (Windows paths, unknown schemes, ...), dropped.
  }
  return null;
}

/**
 * Validates an unknown value as a ForwardPayload (IPC-boundary and test
 * helper): kind must be deep-link/server, value a non-empty string, and the
 * value must re-classify to the same kind (a kind/value mismatch is
 * rejected, mirroring the Wails decodeCommand robustness rule).
 */
export function parseForwardPayload(payload: unknown): ForwardPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== 'deep-link' && p.kind !== 'server') return null;
  if (typeof p.value !== 'string' || p.value.trim() === '') return null;
  const rebuilt = buildForwardPayload(p.value);
  if (!rebuilt || rebuilt.kind !== p.kind) return null;
  return { kind: p.kind, value: p.value };
}

function resolveWindow(provider: WindowProvider): SingleInstanceWindow | null {
  return typeof provider === 'function' ? provider() : provider;
}

function forwardToWindow(
  payloads: ForwardPayload[],
  channel: string,
  win: SingleInstanceWindow | null,
): void {
  if (!win || win.isDestroyed()) return;
  for (const payload of payloads) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function foregroundWindow(win: SingleInstanceWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

/**
 * Acquires the OS single-instance lock and wires the gate:
 *   - primary: installs the second-instance listener (classifies the new
 *     launch's argv, forwards one payload per forwardable arg to the main
 *     window on the forward channel, then foregrounds it); with an
 *     `onServerUrl` callback, classified server payloads are handed to it
 *     instead of being forwarded (deep links always forward);
 *   - losing: the returned acquire() classifies argv and calls app.quit().
 */
export function setupSingleInstance(
  window: WindowProvider,
  forwardChannel: string = FORWARD_CHANNEL,
  onServerUrl?: ServerUrlHandler,
  onLaunchPayloads?: LaunchPayloadHandler,
): SingleInstanceHandle {
  const primary = app.requestSingleInstanceLock();
  let listenerInstalled = false;
  return {
    primary,
    acquire(argv: string[]): AcquireResult {
      if (primary) return { lost: false, forwarded: false };
      const payloads = classifyArgv(argv);
      app.quit();
      return { lost: true, forwarded: payloads.length > 0 };
    },
    installListener(): void {
      if (!primary || listenerInstalled) return;
      listenerInstalled = true;
      app.on('second-instance', (_event: unknown, argv: string[]) => {
        const win = resolveWindow(window);
        const payloads = classifyArgv(argv);
        if (onLaunchPayloads) {
          // The host queues, recreates if necessary, and foregrounds only
          // the current shell after it is ready.
          onLaunchPayloads(payloads);
          return;
        } else if (onServerUrl) {
          // Compatibility path for existing provider-based callers/tests.
          for (const payload of payloads) {
            if (payload.kind === 'server') onServerUrl(payload.value);
          }
          forwardToWindow(
            payloads.filter((p) => p.kind === 'deep-link'),
            forwardChannel,
            win,
          );
        } else {
          forwardToWindow(payloads, forwardChannel, win);
        }
        foregroundWindow(win);
      });
    },
  };
}
