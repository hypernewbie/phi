// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeApp, fakeMenu, fakeNativeImage, fakeNet, fakeDialog, FakeTray } =
  vi.hoisted(() => {
    class FakeTray {
      static instances: FakeTray[] = [];
      listeners = new Map<string, () => void>();
      constructor() {
        FakeTray.instances.push(this);
      }
      setToolTip(): void {}
      on(event: string, listener: () => void): void {
        this.listeners.set(event, listener);
      }
      destroy(): void {}
    }
    return {
      fakeApp: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp/phi-user-data'),
        getVersion: vi.fn(() => '1.2.3'),
        on: vi.fn(),
        quit: vi.fn(),
      },
      fakeMenu: {
        buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
      },
      fakeNativeImage: {
        createFromPath: vi.fn(() => ({ isEmpty: () => false })),
      },
      fakeNet: { fetch: vi.fn() },
      fakeDialog: { showErrorBox: vi.fn() },
      FakeTray,
    };
  });

vi.mock('electron', () => ({
  app: fakeApp,
  BrowserWindow: class {},
  ipcMain: {},
  Menu: fakeMenu,
  nativeImage: fakeNativeImage,
  net: fakeNet,
  dialog: fakeDialog,
  Notification: class {},
  safeStorage: {},
  session: {},
  shell: {},
  Tray: FakeTray,
  WebContentsView: class {},
}));

vi.mock('../src/petInstaller.js', () => ({ installPet: vi.fn() }));

import { Controller } from '../src/controller.js';
import { installPet } from '../src/petInstaller.js';
import { DesktopHost, isPetInstallable } from '../src/desktop.js';
import type { PetDeps, PetHandle } from '../src/petLoader.js';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
};
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const handle = (): PetHandle => ({
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn(() => false),
  setZoomPercent: vi.fn(),
  onRunningChanged: vi.fn(() => () => {}),
});

const enable = (host: DesktopHost, value: boolean): void => {
  host.controller = { state: () => ({ petEnabled: value }) } as never;
};

beforeEach(() => {
  fakeMenu.buildFromTemplate.mockClear();
  fakeNativeImage.createFromPath.mockClear();
  fakeDialog.showErrorBox.mockClear();
  fakeNet.fetch.mockReset();
  vi.mocked(installPet).mockReset();
  FakeTray.instances.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe('DesktopHost optional pet lifecycle', () => {
  it.each([
    ['clean dev build', false, null, false, false, 'darwin', false],
    ['smoke build', true, null, true, false, 'darwin', false],
    ['Linux', true, null, false, false, 'linux', false],
    ['pet already present', true, '/pet', false, false, 'darwin', false],
    ['released supported build', true, null, false, false, 'darwin', true],
  ])(
    'offers installation only for a %s',
    (_case, packaged, root, smoke, installing, platform, expected) => {
      expect(
        isPetInstallable(
          packaged,
          root,
          smoke,
          installing,
          platform as NodeJS.Platform,
        ),
      ).toBe(expected);
    },
  );

  it('routes one tray zoom through Controller to the live handle without duplicate delivery', () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-tray-test-'));
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    try {
      const controller = new Controller({
        persistPath: path.join(dir, 'profiles.json'),
      });
      const retained = handle();
      retained.isRunning = vi.fn(() => true);
      const host = new DesktopHost();
      host.petRoot = '/pet';
      host.controller = controller;
      host.petHandle = retained;
      host.startTray();

      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{
        label: string;
        enabled?: boolean;
        submenu?: Array<{
          label: string;
          enabled?: boolean;
          click?: () => void;
        }>;
      }>;
      const zoomIn = template
        .find((entry) => entry.label === 'Pet')
        ?.submenu?.find((entry) => entry.label === 'Zoom in');
      expect(zoomIn?.enabled).toBe(true);
      zoomIn?.click?.();

      expect(controller.getPetZoomPercent()).toBe(125);
      expect(retained.setZoomPercent).toHaveBeenCalledTimes(1);
      expect(retained.setZoomPercent).toHaveBeenCalledWith(125);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('routes the Pet settings tray item to the retained settings opener', async () => {
    const priorPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    try {
      const host = new DesktopHost();
      host.petRoot = '/pet';
      host.controller = {
        state: () => ({
          petEnabled: false,
          profiles: [],
          health: new Map(),
          unread: new Map(),
          activeId: '',
          closeToTray: true,
          syncAlerts: true,
          petZoomPercent: 100,
        }),
      } as never;
      const retained = handle();
      retained.openSettings = vi.fn();
      host.petHandle = retained;
      host.startTray();
      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{
        label: string;
        submenu?: Array<{ label: string; click?: () => void }>;
      }>;
      const settings = template
        .find((entry) => entry.label === 'Pet')
        ?.submenu?.find((entry) => entry.label === 'Pet settings…');
      settings?.click?.();
      await flush();
      expect(retained.openSettings).toHaveBeenCalledTimes(1);
      expect(retained.start).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('coalesces settings-open and disabled normal-enable without starting the overlay', async () => {
    const priorPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    try {
      const host = new DesktopHost();
      host.petRoot = '/pet';
      enable(host, false);
      const pending = deferred<(deps: PetDeps) => PetHandle>();
      const load = vi
        .spyOn(host, 'loadPetFactory')
        .mockReturnValueOnce(pending.promise);
      const retained = handle();
      retained.openSettings = vi.fn();
      const factory = vi.fn(() => retained);
      const opening = (
        host as unknown as { openPetSettings(): Promise<void> }
      ).openPetSettings();
      const enabling = host.startPet();
      expect(load).toHaveBeenCalledTimes(1);
      pending.resolve(factory);
      await Promise.all([opening, enabling]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(retained.openSettings).toHaveBeenCalledTimes(1);
      expect(retained.start).not.toHaveBeenCalled();
      expect(host.petHandle).toBe(retained);
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('refreshes the live tray readout through DesktopHost.start controller wiring', async () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-tray-zoom-test-'));
    const startupStop = new Error('stop after production subscription wiring');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    fakeApp.getPath.mockReturnValue(dir);
    try {
      const host = new DesktopHost();
      host.petRoot = '/pet';
      vi.spyOn(host, 'installAppMenu').mockImplementation(() => {});
      vi.spyOn(host, 'createMainWindow').mockReturnValue({} as never);
      vi.spyOn(host, 'syncTrayFromController').mockImplementation(() => {
        throw startupStop;
      });

      await expect(
        host.start({ installListener: vi.fn() } as never),
      ).rejects.toBe(startupStop);
      const controller = host.controller;
      expect(controller).not.toBeNull();

      const readout = (): string => {
        const template = fakeMenu.buildFromTemplate.mock.calls.at(
          -1,
        )?.[0] as Array<{
          label: string;
          submenu?: Array<{ label: string }>;
        }>;
        return (
          template.find((entry) => entry.label === 'Pet')?.submenu?.[1]
            ?.label ?? ''
        );
      };
      expect(readout()).toBe('Zoom: 100%');
      expect(controller?.setPetZoomPercent(125)).toBe(true);
      expect(readout()).toBe('Zoom: 125%');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('keeps only the final deferred factory handle across enable, disable, enable', async () => {
    const host = new DesktopHost();
    host.petRoot = '/pet';
    enable(host, true);
    const first = deferred<(deps: PetDeps) => PetHandle>();
    const second = deferred<(deps: PetDeps) => PetHandle>();
    const load = vi
      .spyOn(host, 'loadPetFactory')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    void host.startPet();
    host.stopPet();
    void host.startPet();
    const stale = handle();
    const final = handle();
    first.resolve(() => stale);
    await flush();
    second.resolve(() => final);
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(stale.start).toHaveBeenCalledTimes(1);
    expect(final.start).not.toHaveBeenCalled();
    expect(host.petHandle).toBe(stale);
  });

  it('reuses one listener-owning handle across repeated disable and enable', async () => {
    const host = new DesktopHost();
    host.petRoot = '/pet';
    enable(host, true);
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
  ])(
    'does not restart a retained stopped handle when %s',
    async (_case, root, petEnabled, quitting) => {
      const priorPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'darwin',
      });
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
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: priorPlatform,
        });
      }
    },
  );

  it('creates no handle when disable or quit invalidates a pending factory', async () => {
    const host = new DesktopHost();
    host.petRoot = '/pet';
    enable(host, true);
    const disabled = deferred<(deps: PetDeps) => PetHandle>();
    vi.spyOn(host, 'loadPetFactory').mockReturnValueOnce(disabled.promise);
    void host.startPet();
    host.stopPet();
    enable(host, false);
    const disabledFactory = vi.fn(() => handle());
    disabled.resolve(disabledFactory);
    await flush();
    expect(disabledFactory).toHaveBeenCalledTimes(1);
    expect(host.petHandle).not.toBeNull();
    expect((host.petHandle as PetHandle).start).not.toHaveBeenCalled();

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
    expect(host.petHandle).not.toBeNull();
  });

  it('installs and starts through the production controller subscription when initially disabled', async () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-install-flow-'));
    const startupStop = new Error(
      'stop after production pet subscription wiring',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    fakeApp.isPackaged = true;
    fakeApp.getPath.mockReturnValue(dir);
    try {
      const host = new DesktopHost();
      const retained = handle();
      vi.spyOn(host, 'installAppMenu').mockImplementation(() => {});
      vi.spyOn(host, 'createMainWindow').mockReturnValue({} as never);
      vi.spyOn(host, 'syncTrayFromController').mockImplementation(() => {
        throw startupStop;
      });
      vi.spyOn(host, 'loadPetFactory').mockResolvedValue(() => retained);
      vi.mocked(installPet).mockImplementation(async () => {
        const root = path.join(dir, 'pet', '1.2.3');
        mkdirSync(path.join(root, 'dist'), { recursive: true });
        writeFileSync(path.join(root, 'dist', 'pet-main.js'), '');
        return { root };
      });
      await expect(
        host.start({ installListener: vi.fn() } as never),
      ).rejects.toBe(startupStop);
      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{ label: string; click?: () => void }>;
      template.find((entry) => entry.label === 'Install Pet…')?.click?.();
      await flush();
      await flush();
      expect(installPet).toHaveBeenCalledTimes(1);
      expect(host.petRoot).toBe(path.join(dir, 'pet', '1.2.3'));
      expect(host.controller?.getPetEnabled()).toBe(true);
      expect(retained.start).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
      fakeApp.isPackaged = false;
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('restarts the pet when installation succeeds with preference already enabled', async () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-install-flow-'));
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    fakeApp.isPackaged = true;
    fakeApp.getPath.mockReturnValue(dir);
    mkdirSync(path.join(dir, 'pet', '1.2.3', 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'pet', '1.2.3', 'dist', 'pet-main.js'), '');
    try {
      const host = new DesktopHost();
      host.controller = new Controller({
        persistPath: path.join(dir, 'profiles.json'),
      });
      host.controller.setPetEnabled(true);
      vi.mocked(installPet).mockResolvedValue({
        root: path.join(dir, 'pet', '1.2.3'),
      });
      const start = vi.spyOn(host, 'startPet').mockResolvedValue();
      host.startTray();
      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{ label: string; click?: () => void }>;
      template.find((entry) => entry.label === 'Install Pet…')?.click?.();
      await flush();
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
      fakeApp.isPackaged = false;
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('shows installation failure and resets the in-flight state', async () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-install-flow-'));
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    fakeApp.isPackaged = true;
    fakeApp.getPath.mockReturnValue(dir);
    try {
      const host = new DesktopHost();
      host.controller = new Controller({
        persistPath: path.join(dir, 'profiles.json'),
      });
      vi.mocked(installPet).mockRejectedValue(new Error('network unavailable'));
      host.startTray();
      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{ label: string; click?: () => void }>;
      template.find((entry) => entry.label === 'Install Pet…')?.click?.();
      await flush();
      expect(fakeDialog.showErrorBox).toHaveBeenCalledWith(
        'Pet installation failed',
        'network unavailable',
      );
      expect(host.petRoot).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
      fakeApp.isPackaged = false;
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it.each([
    [
      'non-OK HTTP',
      { ok: false, status: 503 },
      'pet download failed: HTTP 503',
    ],
    [
      'arrayBuffer rejection',
      {
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.reject(new Error('body unavailable')),
      },
      'body unavailable',
    ],
  ])(
    'surfaces Electron fetch bridge %s failures and restores the tray',
    async (_case, response, message) => {
      const priorPlatform = process.platform;
      const dir = mkdtempSync(
        path.join(os.tmpdir(), 'phi-pet-install-bridge-'),
      );
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'darwin',
      });
      fakeApp.isPackaged = true;
      fakeApp.getPath.mockReturnValue(dir);
      try {
        const host = new DesktopHost();
        host.controller = new Controller({
          persistPath: path.join(dir, 'profiles.json'),
        });
        fakeNet.fetch.mockResolvedValue(response);
        vi.mocked(installPet).mockImplementation(async (deps) => {
          await deps.fetchBytes('https://example.test/pet.tar.gz');
          return { root: path.join(dir, 'pet', '1.2.3') };
        });
        host.startTray();
        const template = fakeMenu.buildFromTemplate.mock.calls.at(
          -1,
        )?.[0] as Array<{ label: string; click?: () => void }>;
        template.find((entry) => entry.label === 'Install Pet…')?.click?.();
        await flush();
        await flush();
        expect(fakeDialog.showErrorBox).toHaveBeenCalledWith(
          'Pet installation failed',
          message,
        );
        const restored = fakeMenu.buildFromTemplate.mock.calls.at(
          -1,
        )?.[0] as Array<{ label: string; enabled?: boolean }>;
        expect(
          restored.find((entry) => entry.label === 'Install Pet…'),
        ).toMatchObject({ enabled: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
        fakeApp.isPackaged = false;
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: priorPlatform,
        });
      }
    },
  );

  it('ignores a concurrent install command', async () => {
    const priorPlatform = process.platform;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-install-flow-'));
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    fakeApp.isPackaged = true;
    fakeApp.getPath.mockReturnValue(dir);
    const pending = deferred<{ root: string }>();
    try {
      const host = new DesktopHost();
      host.controller = new Controller({
        persistPath: path.join(dir, 'profiles.json'),
      });
      vi.mocked(installPet).mockReturnValue(pending.promise);
      host.startTray();
      const template = fakeMenu.buildFromTemplate.mock.calls.at(
        -1,
      )?.[0] as Array<{ label: string; click?: () => void }>;
      const install = template.find(
        (entry) => entry.label === 'Install Pet…',
      )?.click;
      install?.();
      install?.();
      expect(installPet).toHaveBeenCalledTimes(1);
      pending.resolve({ root: path.join(dir, 'pet', '1.2.3') });
      await flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fakeApp.getPath.mockReturnValue('/tmp/phi-user-data');
      fakeApp.isPackaged = false;
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });

  it('preserves the Linux preference without importing the unavailable package and logs once', async () => {
    const priorPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    try {
      const host = new DesktopHost();
      host.petRoot = '/pet';
      enable(host, true);
      const load = vi.spyOn(host, 'loadPetFactory');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await host.startPet();
      await host.startPet();
      expect(host.controller?.state().petEnabled).toBe(true);
      expect(load).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('phi-desktop: pet unavailable on linux');
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: priorPlatform,
      });
    }
  });
});
