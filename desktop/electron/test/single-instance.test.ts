/**
 * Unit tests for the single-instance gate and phi:// argv routing
 * (src/single-instance.ts) — parity with the Wails single package's
 * ClassifyArgs/Forward behavior.
 *
 * The gate talks to the OS through Electron's app object; tests substitute
 * a fake so one process can play first and second instance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeApp } = vi.hoisted(() => ({
  fakeApp: {
    requestSingleInstanceLock: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: fakeApp }));

import {
  FORWARD_CHANNEL,
  classifyArgv,
  buildForwardPayload,
  parseForwardPayload,
  setupSingleInstance,
  type SingleInstanceWindow,
} from '../src/single-instance.js';

function fakeWindow(
  overrides: Partial<SingleInstanceWindow> = {},
): SingleInstanceWindow {
  return {
    webContents: { send: vi.fn(), isDestroyed: () => false },
    restore: vi.fn(),
    focus: vi.fn(),
    isMinimized: () => false,
    ...overrides,
  };
}

/** Extracts the listener setupSingleInstance registered for 'second-instance'. */
function secondInstanceListener(): (event: unknown, argv: string[]) => void {
  const call = fakeApp.on.mock.calls.find(
    ([channel]) => channel === 'second-instance',
  );
  if (!call) throw new Error('second-instance listener was not registered');
  return call[1] as (event: unknown, argv: string[]) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyArgv', () => {
  it('classifies phi:// args as deep-link payloads', () => {
    expect(classifyArgv(['phi://profile/home'])).toEqual([
      { kind: 'deep-link', value: 'phi://profile/home' },
    ]);
  });

  it('classifies http(s):// args as server payloads', () => {
    expect(
      classifyArgv(['http://127.0.0.1:7070/', 'https://example.com/']),
    ).toEqual([
      { kind: 'server', value: 'http://127.0.0.1:7070/' },
      { kind: 'server', value: 'https://example.com/' },
    ]);
  });

  it('drops flags and junk, keeps positional URLs (incl. a --server value)', () => {
    expect(
      classifyArgv([
        '--server',
        'http://127.0.0.1:7070/',
        'phi://profile/a',
        'garbage',
        '-x',
        '--',
        'https://x.dev/',
      ]),
    ).toEqual([
      { kind: 'server', value: 'http://127.0.0.1:7070/' },
      { kind: 'deep-link', value: 'phi://profile/a' },
      { kind: 'server', value: 'https://x.dev/' },
    ]);
  });

  it('returns [] for flags and junk only', () => {
    expect(
      classifyArgv(['--help', '-v', 'notaurl', '', 'C:\\Windows\\x']),
    ).toEqual([]);
  });

  it('returns [] for empty argv', () => {
    expect(classifyArgv([])).toEqual([]);
  });

  it('is case-sensitive for the phi:// prefix but not for http schemes', () => {
    expect(classifyArgv(['PHI://profile/x'])).toEqual([]);
    expect(classifyArgv(['HTTP://example.com/'])).toEqual([
      { kind: 'server', value: 'HTTP://example.com/' },
    ]);
  });

  it('drops the protocol-registration CLI flags (a flag launch is never forwarded)', () => {
    // A second launch carrying --register-protocol/--unregister-protocol
    // forwards only the deep-link/server args — flags stay local (phase-3
    // registration flags win over everything and exit before the gate).
    expect(
      classifyArgv([
        '--register-protocol',
        '--unregister-protocol',
        'phi://profile/x',
        'https://x.dev/',
      ]),
    ).toEqual([
      { kind: 'deep-link', value: 'phi://profile/x' },
      { kind: 'server', value: 'https://x.dev/' },
    ]);
  });
});

describe('buildForwardPayload', () => {
  it('returns null for empty, flags and junk', () => {
    expect(buildForwardPayload('')).toBeNull();
    expect(buildForwardPayload('--flag')).toBeNull();
    expect(buildForwardPayload('junk')).toBeNull();
    expect(buildForwardPayload('mailto:x@y')).toBeNull();
    expect(buildForwardPayload('C:\\Windows\\x')).toBeNull();
  });

  it('builds deep-link payloads for phi:// args', () => {
    expect(buildForwardPayload('phi://profile/home')).toEqual({
      kind: 'deep-link',
      value: 'phi://profile/home',
    });
  });

  it('builds server payloads for http/https args', () => {
    expect(buildForwardPayload('http://127.0.0.1:7070/')).toEqual({
      kind: 'server',
      value: 'http://127.0.0.1:7070/',
    });
    expect(buildForwardPayload('https://example.com/')).toEqual({
      kind: 'server',
      value: 'https://example.com/',
    });
  });
});

describe('parseForwardPayload', () => {
  it('accepts valid deep-link and server payloads', () => {
    expect(
      parseForwardPayload({ kind: 'deep-link', value: 'phi://profile/home' }),
    ).toEqual({
      kind: 'deep-link',
      value: 'phi://profile/home',
    });
    expect(
      parseForwardPayload({ kind: 'server', value: 'https://example.com/' }),
    ).toEqual({
      kind: 'server',
      value: 'https://example.com/',
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseForwardPayload(null)).toBeNull();
    expect(parseForwardPayload('x')).toBeNull();
    expect(parseForwardPayload({})).toBeNull();
    expect(parseForwardPayload({ kind: 'wat', value: 'x' })).toBeNull();
    expect(parseForwardPayload({ kind: 'deep-link' })).toBeNull();
    expect(parseForwardPayload({ kind: 'deep-link', value: '' })).toBeNull();
    expect(parseForwardPayload({ kind: 'deep-link', value: '   ' })).toBeNull();
    // kind/value mismatch: the value must re-classify to the same kind.
    expect(
      parseForwardPayload({ kind: 'server', value: 'phi://profile/x' }),
    ).toBeNull();
  });

  it('round-trips buildForwardPayload output', () => {
    for (const arg of [
      'phi://profile/home',
      'https://x.dev/',
      'http://127.0.0.1:7070/',
    ]) {
      const built = buildForwardPayload(arg);
      expect(built).not.toBeNull();
      expect(parseForwardPayload(built)).toEqual(built);
    }
  });
});

describe('setupSingleInstance', () => {
  it('returns primary with a second-instance listener when the lock is won', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const handle = setupSingleInstance(null, FORWARD_CHANNEL);
    expect(handle.primary).toBe(true);
    // The listener is installed lazily (phase-4 ordering: gate -> window
    // -> tray -> second-instance listener), so nothing is registered until
    // installListener() is called.
    expect(fakeApp.on).not.toHaveBeenCalled();
    handle.installListener();
    expect(fakeApp.on).toHaveBeenCalledWith(
      'second-instance',
      expect.any(Function),
    );
    // acquire is a no-op for the primary.
    expect(handle.acquire(['phi://profile/home'])).toEqual({
      lost: false,
      forwarded: false,
    });
    expect(fakeApp.quit).not.toHaveBeenCalled();
  });

  it('installs the second-instance listener only when installListener() is called', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const handle = setupSingleInstance(null, FORWARD_CHANNEL);
    expect(fakeApp.on).not.toHaveBeenCalledWith(
      'second-instance',
      expect.any(Function),
    );
    handle.installListener();
    expect(fakeApp.on).toHaveBeenCalledWith(
      'second-instance',
      expect.any(Function),
    );
    // Installing twice must not double-register.
    handle.installListener();
    expect(
      fakeApp.on.mock.calls.filter(([ch]) => ch === 'second-instance'),
    ).toHaveLength(1);
  });

  it('forwards classified argv to the main window and foregrounds it on second-instance', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const send = vi.fn();
    const restore = vi.fn();
    const focus = vi.fn();
    const win = fakeWindow({
      webContents: { send, isDestroyed: () => false },
      restore,
      focus,
      isMinimized: () => true,
    });
    const handle = setupSingleInstance(win, FORWARD_CHANNEL);
    handle.installListener();
    secondInstanceListener()({}, [
      'phi://profile/home',
      'https://example.com/',
      'junk',
      '-x',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, FORWARD_CHANNEL, {
      kind: 'deep-link',
      value: 'phi://profile/home',
    });
    expect(send).toHaveBeenNthCalledWith(2, FORWARD_CHANNEL, {
      kind: 'server',
      value: 'https://example.com/',
    });
    expect(restore).toHaveBeenCalledTimes(1); // was minimized
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('routes server payloads to onServerUrl and keeps forwarding deep links', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const send = vi.fn();
    const onServerUrl = vi.fn();
    const win = fakeWindow({ webContents: { send, isDestroyed: () => false } });
    const handle = setupSingleInstance(win, FORWARD_CHANNEL, onServerUrl);
    handle.installListener();
    secondInstanceListener()({}, [
      'phi://profile/home',
      'https://example.com/',
      'junk',
      '-x',
    ]);
    // Server payloads go to the callback (never to the window); deep links
    // keep the forward channel.
    expect(onServerUrl).toHaveBeenCalledTimes(1);
    expect(onServerUrl).toHaveBeenCalledWith('https://example.com/');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(FORWARD_CHANNEL, {
      kind: 'deep-link',
      value: 'phi://profile/home',
    });
  });

  it('forwards server payloads too when onServerUrl is absent (phase-2 contract)', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const send = vi.fn();
    const win = fakeWindow({ webContents: { send, isDestroyed: () => false } });
    const handle = setupSingleInstance(win, FORWARD_CHANNEL);
    handle.installListener();
    secondInstanceListener()({}, ['https://example.com/']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(FORWARD_CHANNEL, {
      kind: 'server',
      value: 'https://example.com/',
    });
  });

  it('does not restore a non-minimized window', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const restore = vi.fn();
    const focus = vi.fn();
    const win = fakeWindow({ restore, focus, isMinimized: () => false });
    const handle = setupSingleInstance(win, FORWARD_CHANNEL);
    handle.installListener();
    secondInstanceListener()({}, ['phi://profile/x']);
    expect(restore).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing window on the second-instance event', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const handle = setupSingleInstance(null, FORWARD_CHANNEL);
    handle.installListener();
    expect(() =>
      secondInstanceListener()({}, ['phi://profile/x']),
    ).not.toThrow();
  });

  it('supports a lazy window accessor (window created after the gate)', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const send = vi.fn();
    let win: SingleInstanceWindow | null = null;
    const handle = setupSingleInstance(() => win, FORWARD_CHANNEL);
    handle.installListener();
    win = fakeWindow({ webContents: { send, isDestroyed: () => false } });
    secondInstanceListener()({}, ['phi://profile/home']);
    expect(send).toHaveBeenCalledWith(FORWARD_CHANNEL, {
      kind: 'deep-link',
      value: 'phi://profile/home',
    });
  });

  it('does not send to a destroyed webContents', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(true);
    const send = vi.fn();
    const win = fakeWindow({ webContents: { send, isDestroyed: () => true } });
    const handle = setupSingleInstance(win, FORWARD_CHANNEL);
    handle.installListener();
    secondInstanceListener()({}, ['phi://profile/home']);
    expect(send).not.toHaveBeenCalled();
  });

  it('losing side: acquire classifies argv and quits, installing no listener', () => {
    fakeApp.requestSingleInstanceLock.mockReturnValue(false);
    const handle = setupSingleInstance(null, FORWARD_CHANNEL);
    expect(handle.primary).toBe(false);
    expect(fakeApp.on).not.toHaveBeenCalled();
    // installListener is a no-op for the losing side.
    handle.installListener();
    expect(fakeApp.on).not.toHaveBeenCalled();
    expect(
      handle.acquire(['phi://profile/home', 'http://127.0.0.1:7070/', 'junk']),
    ).toEqual({ lost: true, forwarded: true });
    expect(handle.acquire(['junk', '-x'])).toEqual({
      lost: true,
      forwarded: false,
    });
    expect(handle.acquire([])).toEqual({ lost: true, forwarded: false });
    expect(fakeApp.quit).toHaveBeenCalledTimes(3);
  });

  it('exposes the documented forward channel constant', () => {
    expect(FORWARD_CHANNEL).toBe('phi:single-instance-forward');
  });
});
