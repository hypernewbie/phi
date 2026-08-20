// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeApp, fakeMenu, fakeNativeImage, FakeTray } = vi.hoisted(() => {
  class FakeTray {
    static instances: FakeTray[] = [];
    listeners = new Map<string, () => void>();
    constructor() { FakeTray.instances.push(this); }
    setToolTip(): void {}
    on(event: string, listener: () => void): void { this.listeners.set(event, listener); }
    destroy(): void {}
  }
  return {
    fakeApp: {
      getPath: vi.fn(() => '/tmp/phi-user-data'),
      on: vi.fn(),
      quit: vi.fn(),
    },
    fakeMenu: { buildFromTemplate: vi.fn((template: unknown[]) => ({ template })) },
    fakeNativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => false })) },
    FakeTray,
  };
});

vi.mock('electron', () => ({
  app: fakeApp,
  BrowserWindow: class {},
  ipcMain: {},
  Menu: fakeMenu,
  nativeImage: fakeNativeImage,
  Notification: class {},
  safeStorage: {},
  session: {},
  shell: {},
  Tray: FakeTray,
  WebContentsView: class {},
}));

import { Controller } from '../src/controller.js';
import { DesktopHost } from '../src/desktop.js';
import type { PetDeps, PetHandle } from '../src/petLoader.js';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
};
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const handle = (): PetHandle => ({
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn(() => false),
  setScaleTick: vi.fn(),
  resetPosition: vi.fn(),
  onRunningChanged: vi.fn(() => () => {}),
});

const enable = (host: DesktopHost, value: boolean): void => {
  host.controller = { state: () => ({ petEnabled: value }) } as never;
};

beforeEach(() => {
  fakeMenu.buildFromTemplate.mockClear();
  fakeNativeImage.createFromPath.mockClear();
  FakeTray.instances.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe('DesktopHost optional pet lifecycle', () => {
  it('routes one tray zoom through Controller to the live handle without duplicate delivery', () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-tray-test-'));
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      const controller = new Controller({ persistPath: path.join(dir, 'profiles.json') });
      const retained = handle();
      retained.isRunning = vi.fn(() => true);
      const host = new DesktopHost();
      host.petRoot = '/pet';
      host.controller = controller;
      host.petHandle = retained;
      host.startTray();

      const template = fakeMenu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
        label: string;
        enabled?: boolean;
        submenu?: Array<{ label: string; enabled?: boolean; click?: () => void }>;
      }>;
      const zoomIn = template.find((entry) => entry.label === 'Pet')?.submenu?.find((entry) => entry.label === 'Zoom in');
      expect(zoomIn?.enabled).toBe(true);
      zoomIn?.click?.();

      expect(controller.getPetScaleTick()).toBe(3);
      expect(retained.setScaleTick).toHaveBeenCalledTimes(1);
      expect(retained.setScaleTick).toHaveBeenCalledWith(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      Object.defineProperty(process, 'platform', { configurable: true, value: priorPlatform });
    }
  });

  it('keeps only the final deferred factory handle across enable, disable, enable', async () => {
    const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
    const first = deferred<(deps: PetDeps) => PetHandle>();
    const second = deferred<(deps: PetDeps) => PetHandle>();
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

  it('reuses one listener-owning handle across repeated disable and enable', async () => {
    const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
    const retained = handle();
    const factory = vi.fn(() => retained);
    const load = vi.spyOn(host, 'loadPetFactory').mockResolvedValue(factory);

    await host.startPet();
    host.stopPet();
    await host.startPet();
    host.stopPet();
    await host.startPet();

    expect(load).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(retained.stop).toHaveBeenCalledTimes(2);
    expect(retained.start).toHaveBeenCalledTimes(3);
    expect(host.petHandle).toBe(retained);
  });

  it.each([
    ['unavailable', null, true, false],
    ['disabled', '/pet', false, false],
    ['quitting', '/pet', true, true],
  ])('does not restart a retained stopped handle when %s', async (_case, root, petEnabled, quitting) => {
    const priorPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      const host = new DesktopHost();
      host.petRoot = root;
      enable(host, petEnabled);
      host.quitting = quitting;
      const retained = handle();
      host.petHandle = retained;

      await host.startPet();

      expect(retained.start).not.toHaveBeenCalled();
      expect(host.petHandle).toBe(retained);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: priorPlatform });
    }
  });

  it('creates no handle when disable or quit invalidates a pending factory', async () => {
    const host = new DesktopHost(); host.petRoot = '/pet'; enable(host, true);
    const disabled = deferred<(deps: PetDeps) => PetHandle>();
    vi.spyOn(host, 'loadPetFactory').mockReturnValueOnce(disabled.promise);
    void host.startPet();
    host.stopPet();
    const disabledFactory = vi.fn(() => handle());
    disabled.resolve(disabledFactory);
    await flush();
    expect(disabledFactory).not.toHaveBeenCalled();
    expect(host.petHandle).toBeNull();

    const quitting = deferred<(deps: PetDeps) => PetHandle>();
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
