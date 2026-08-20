// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fakeApp } = vi.hoisted(() => ({
  fakeApp: {
    getPath: vi.fn(() => '/tmp/phi-user-data'),
    on: vi.fn(),
    quit: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: fakeApp,
  BrowserWindow: class {},
  ipcMain: {},
  Menu: {},
  Notification: class {},
  safeStorage: {},
  session: {},
  shell: {},
  WebContentsView: class {},
}));

import { DesktopHost } from '../src/desktop.js';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
};
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const handle = () => ({ start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) });

const enable = (host: DesktopHost, value: boolean): void => {
  host.controller = { state: () => ({ petEnabled: value }) } as never;
};

afterEach(() => vi.restoreAllMocks());

describe('DesktopHost optional pet lifecycle', () => {
  it('keeps only the final deferred factory handle across enable, disable, enable', async () => {
    const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
    const first = deferred<(deps: { root: string; log: (msg: string) => void }) => ReturnType<typeof handle>>();
    const second = deferred<(deps: { root: string; log: (msg: string) => void }) => ReturnType<typeof handle>>();
    const load = vi.spyOn(host, 'loadPetFactory').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    void host.startPet();
    host.stopPet();
    void host.startPet();
    const stale = handle(); const final = handle();
    first.resolve(() => stale);
    await flush();
    second.resolve(() => final);
    await flush();

    expect(load).toHaveBeenCalledTimes(2);
    expect(stale.start).not.toHaveBeenCalled();
    expect(final.start).toHaveBeenCalledTimes(1);
    expect(host.petHandle).toBe(final);
  });

  it('creates no handle when disable or quit invalidates a pending factory', async () => {
    const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
    const disabled = deferred<(deps: { root: string; log: (msg: string) => void }) => ReturnType<typeof handle>>();
    vi.spyOn(host, 'loadPetFactory').mockReturnValueOnce(disabled.promise);
    void host.startPet();
    host.stopPet();
    const disabledFactory = vi.fn(() => handle());
    disabled.resolve(disabledFactory);
    await flush();
    expect(disabledFactory).not.toHaveBeenCalled();
    expect(host.petHandle).toBeNull();

    const quitting = deferred<(deps: { root: string; log: (msg: string) => void }) => ReturnType<typeof handle>>();
    enable(host, true);
    vi.spyOn(host, 'loadPetFactory').mockReturnValueOnce(quitting.promise);
    void host.startPet();
    host.quitting = true;
    host.petGeneration += 1;
    const quittingFactory = vi.fn(() => handle());
    quitting.resolve(quittingFactory);
    await flush();
    expect(quittingFactory).not.toHaveBeenCalled();
    expect(host.petHandle).toBeNull();
  });

  it('preserves the Linux preference without importing the unavailable package and logs once', async () => {
    const priorPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
      const load = vi.spyOn(host, 'loadPetFactory');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await host.startPet();
      await host.startPet();
      expect(host.controller?.state().petEnabled).toBe(true);
      expect(load).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('phi-desktop: pet unavailable on linux');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: priorPlatform });
    }
  });
});
