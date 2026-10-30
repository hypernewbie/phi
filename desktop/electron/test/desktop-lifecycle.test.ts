// @vitest-environment node
/**
 * Fake-Electron lifecycle coverage for DesktopHost. These tests exercise a
 * real host instance while keeping every Electron object recording-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  class Events {
    readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    once(event: string, listener: Listener): this {
      const once: Listener = (...args) => {
        this.removeListener(event, once);
        listener(...args);
      };
      return this.on(event, once);
    }
    removeListener(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== listener),
      );
      return this;
    }
    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])])
        listener(...args);
    }
  }

  class FakeWebContents extends Events {
    destroyed = false;
    readonly sent: Array<[string, unknown]> = [];
    zoom = 0;
    loadFileCalls: string[] = [];
    send(channel: string, payload: unknown): void {
      this.sent.push([channel, payload]);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      this.destroyed = true;
    }
    loadFile(file: string): Promise<void> {
      this.loadFileCalls.push(file);
      return Promise.resolve();
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    executeJavaScript(
      _code?: string,
      _userGesture?: boolean,
    ): Promise<unknown> {
      return Promise.resolve(null);
    }
    focus(): void {}
    reload(): void {}
    reloadIgnoringCache(): void {}
    getZoomLevel(): number {
      return this.zoom;
    }
    setZoomLevel(level: number): void {
      this.zoom = level;
    }
    setZoomMode(): void {}
    setZoomFactor(): void {}
    setWindowOpenHandler(): void {}
  }

  class FakeBrowserWindow extends Events {
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = new FakeWebContents();
    readonly contentView = {
      children: new Set<unknown>(),
      addCalls: 0,
      removeCalls: 0,
      addChildView: (view: unknown) => {
        this.contentView.children.add(view);
        this.contentView.addCalls++;
      },
      removeChildView: (view: unknown) => {
        this.contentView.children.delete(view);
        this.contentView.removeCalls++;
      },
    };
    destroyed = false;
    deferClose = false;
    closing = false;
    hidden = false;
    minimized = false;
    maximized = false;
    showCalls = 0;
    focusCalls = 0;
    constructor(_options: unknown) {
      super();
      FakeBrowserWindow.instances.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFullScreen(): boolean {
      return false;
    }
    close(): void {
      if (this.closing) return;
      let prevented = false;
      this.emit('close', { preventDefault: () => (prevented = true) });
      if (prevented) return;
      if (this.deferClose) {
        this.closing = true;
        return;
      }
      this.finishClose();
    }
    finishClose(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.emit('closed');
    }
    hide(): void {
      this.hidden = true;
    }
    show(): void {
      this.hidden = false;
      this.showCalls++;
    }
    focus(): void {
      this.focusCalls++;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.minimized = false;
    }
    minimize(): void {
      this.minimized = true;
    }
    isMaximized(): boolean {
      return this.maximized;
    }
    maximize(): void {
      this.maximized = true;
    }
    unmaximize(): void {
      this.maximized = false;
    }
    isFocused(): boolean {
      return true;
    }
    flashFrame(): void {}
    setProgressBar(): void {}
    setTitle(): void {}
    setIcon(): void {}
    loadFile(file: string): Promise<void> {
      return this.webContents.loadFile(file);
    }
    getContentBounds(): {
      x: number;
      y: number;
      width: number;
      height: number;
    } {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = [];
    readonly webContents = new FakeWebContents();
    closeCalls = 0;
    constructor() {
      FakeWebContentsView.instances.push(this);
      const close = this.webContents.close.bind(this.webContents);
      this.webContents.close = () => {
        this.closeCalls++;
        close();
      };
    }
    setBounds(): void {}
    setVisible(): void {}
    destroy(): void {}
  }

  const appEvents = new Events();
  const powerMonitor = new Events();
  const ipcEvents = new Map<string, Listener>();
  const ipcHandlers = new Map<string, Listener>();
  let userData = '';
  const app = {
    on: appEvents.on.bind(appEvents),
    emit: appEvents.emit.bind(appEvents),
    getPath: (name: string) => (name === 'userData' ? userData : os.tmpdir()),
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    quit: vi.fn(),
    setAboutPanelOptions: vi.fn(),
    dock: { setIcon: vi.fn() },
  };
  const ipcMain = {
    on: (channel: string, listener: Listener) =>
      ipcEvents.set(channel, listener),
    handle: (channel: string, listener: Listener) =>
      ipcHandlers.set(channel, listener),
  };
  return {
    FakeBrowserWindow,
    FakeWebContentsView,
    app,
    ipcMain,
    powerMonitor,
    ipcEvents,
    ipcHandlers,
    setUserData: (value: string) => (userData = value),
    reset: () => {
      FakeBrowserWindow.instances.length = 0;
      FakeWebContentsView.instances.length = 0;
      appEvents.listeners.clear();
      powerMonitor.listeners.clear();
      ipcEvents.clear();
      ipcHandlers.clear();
    },
  };
});

vi.mock('electron', () => ({
  app: fake.app,
  ipcMain: fake.ipcMain,
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  screen: {
    getDisplayNearestPoint: (_point: { x: number; y: number }) => ({
      bounds: { x: 0, y: 0, width: 1680, height: 1050 },
      workArea: { x: 0, y: 31, width: 1680, height: 1019 },
    }),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  Notification: class {
    show(): void {}
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  session: { defaultSession: {} },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  Tray: class {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  globalShortcut: { register: () => true, unregister: () => {} },
  powerMonitor: fake.powerMonitor,
}));

import { AccessAuth, type StoredCredential } from '../src/access-auth.js';
import { Controller } from '../src/controller.js';
import { DesktopHost } from '../src/desktop.js';
import { FORWARD_CHANNEL } from '../src/single-instance.js';
import { WAKE_PAGE_SCRIPT } from '../src/injected.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const primary = {
  primary: true,
  acquire: () => ({ lost: false, forwarded: false }),
  installListener: vi.fn(),
};

/**
 * The rail view owns the server selection, so a launch forward lands
 * there and not on the main window page.
 */
function railSent(host: unknown): unknown[][] {
  const rail = (
    host as {
      railView: { webContents: { sent: unknown[][] } } | null;
    }
  ).railView;
  return rail?.webContents.sent ?? [];
}

describe('DesktopHost fake-Electron lifecycle', () => {
  let temp = '';
  let originalFetch: typeof fetch;
  let previousLowMemory: string | undefined;

  beforeEach(() => {
    fake.reset();
    primary.installListener.mockClear();
    temp = mkdtempSync(path.join(os.tmpdir(), 'phi-desktop-lifecycle-'));
    fake.setUserData(temp);
    originalFetch = globalThis.fetch;
    // The low-memory mode is decided by the machine's RAM, so the same
    // test ran a different code path on a small laptop than on a CI
    // runner. The mode is pinned here; the tests that need the embedded
    // mode set it themselves.
    previousLowMemory = process.env.PHI_DESKTOP_LOW_MEMORY;
    process.env.PHI_DESKTOP_LOW_MEMORY = '0';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    rmSync(temp, { recursive: true, force: true });
    if (previousLowMemory === undefined) {
      delete process.env.PHI_DESKTOP_LOW_MEMORY;
    } else {
      process.env.PHI_DESKTOP_LOW_MEMORY = previousLowMemory;
    }
  });

  it.each(['config.toml', 'config.json'])(
    'ignores %s server config during credential lookup and bootstrap',
    async (filename) => {
      const phiDir = path.join(temp, '.phi');
      mkdirSync(phiDir, { recursive: true });
      vi.spyOn(os, 'homedir').mockReturnValue(temp);
      const verifier = Buffer.alloc(32, 1).toString('base64url');
      const salt = Buffer.alloc(16, 2).toString('base64url');
      const hash = `v1.pbkdf2-sha256.100000.${salt}.${verifier}`;
      writeFileSync(
        path.join(phiDir, filename),
        filename === 'config.toml'
          ? `access_password_hash = "${hash}"\n`
          : JSON.stringify({ access_password_hash: hash, password_hash: hash }),
      );
      const host = new DesktopHost();
      const recovery = host as unknown as {
        getOrRecoverCredential(origin: string): unknown;
        storedCredentials: Map<string, unknown>;
      };
      const origin = 'http://localhost:7070';
      host.controller = new Controller({
        persistPath: path.join(temp, 'profiles.json'),
      });
      host.controller.add(origin);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('offline'));
      globalThis.fetch = fetcher;

      expect(recovery.getOrRecoverCredential(origin) === null).toBe(true);
      expect(recovery.storedCredentials.size).toBe(0);
      await host.bootstrapStoredCredentials(new AccessAuth(fetcher), 0);
      expect(recovery.storedCredentials.size).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  describe('cached credentials', () => {
    const origin = 'http://localhost:7070';
    let host: DesktopHost;
    let credential: StoredCredential;
    let cache: {
      storedCredentials: Map<string, StoredCredential>;
      getOrRecoverCredential(origin: string): StoredCredential | null;
      persistVerifierAfterUnlock(
        origin: string,
        auth: AccessAuth,
        generation: number,
      ): void;
    };

    beforeEach(() => {
      host = new DesktopHost();
      cache = host as unknown as typeof cache;
      credential = {
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations: 100_000,
        salt: Buffer.from('synthetic-salt'),
        verifier: Buffer.alloc(32, 1),
      };
    });

    it('looks up an in-memory credential by canonical origin', () => {
      cache.storedCredentials.set(origin, credential);
      expect(cache.getOrRecoverCredential('http://LOCALHOST:7070/')).toBe(
        credential,
      );
    });

    it('persists a password unlock and reloads it from the desktop credential file', async () => {
      // Exercise serialization and disk I/O; safeStorage encryption is faked above.
      vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true);
      const auth = new AccessAuth(async (input) => {
        const url = input.toString();
        if (url.endsWith('/api/auth/status')) {
          return new Response(
            JSON.stringify({
              enabled: true,
              version: 'v1',
              algorithm: credential.algorithm,
              iterations: credential.iterations,
              salt: credential.salt.toString('base64url'),
              challenge: 'synthetic-challenge',
            }),
          );
        }
        if (url.endsWith('/api/auth/login')) {
          return new Response(null, {
            headers: {
              'set-cookie': 'phi_access_session=synthetic; Path=/; HttpOnly',
            },
          });
        }
        return new Response('{}');
      });
      expect((await auth.tryUnlock(origin, 'synthetic-password')).kind).toBe(
        'ok',
      );
      cache.persistVerifierAfterUnlock(origin, auth, 0);
      const saved = cache.getOrRecoverCredential(origin);
      expect(saved).not.toBeNull();
      expect(saved?.verifier.length).toBe(32);

      const restarted = new DesktopHost() as unknown as typeof cache;
      expect(restarted.getOrRecoverCredential(`${origin}/`)).toEqual(saved);
    });

    it.each([
      'ok',
      'offline',
      'http-error',
      'unavailable',
      'rate-limited',
      'invalid-password',
      'rotated-salt',
    ] as const)(
      'handles %s during cached startup reauthentication',
      async (outcome) => {
        cache.storedCredentials.set(origin, credential);
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
          if (outcome === 'offline') throw new TypeError('offline');
          if (outcome === 'http-error')
            return new Response(null, { status: 503 });
          return new Response(
            JSON.stringify({
              enabled: true,
              algorithm: credential.algorithm,
              iterations: credential.iterations,
              salt: (outcome === 'rotated-salt'
                ? Buffer.from('rotated-salt')
                : credential.salt
              ).toString('base64url'),
            }),
          );
        });
        globalThis.fetch = fetcher;
        const auth = new AccessAuth(fetcher);
        const unlock = vi
          .spyOn(auth, 'tryUnlockWithVerifier')
          .mockImplementation(async () => {
            if (outcome === 'ok') return { kind: 'ok', config: null };
            if (outcome === 'invalid-password')
              return { kind: 'invalid-password', message: 'rejected' };
            if (outcome === 'rate-limited')
              return { kind: 'rate-limited', message: 'retry later' };
            return { kind: 'unavailable', message: 'offline' };
          });

        await host.bootstrapStoredCredentials(auth, 0);
        const cleared =
          outcome === 'invalid-password' || outcome === 'rotated-salt';
        expect(cache.storedCredentials.has(origin)).toBe(!cleared);
        expect(credential.verifier.equals(Buffer.alloc(32, 1))).toBe(true);
        const skipped =
          outcome === 'offline' ||
          outcome === 'http-error' ||
          outcome === 'rotated-salt';
        expect(unlock).toHaveBeenCalledTimes(skipped ? 0 : 1);
        if (!skipped) {
          expect(unlock.mock.calls[0][0]).toBe(origin);
          expect(unlock.mock.calls[0][1].equals(Buffer.alloc(32))).toBe(true);
        }
      },
    );
  });

  it('power resume wakes only the active retained view and tolerates absent/destroyed views', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    expect(fake.powerMonitor.listeners.get('resume')).toHaveLength(1);
    const ctrl = host.controller!;
    const a = ctrl.add('http://alpha.example.test:7070/');
    const b = ctrl.add('http://beta.example.test:7070/');
    host.profileViews!.addProfile(a.id, a.origin);
    host.profileViews!.addProfile(b.id, b.origin);
    ctrl.setActive(a.id);
    const first = host.profileViews!.getView(a.id)!;
    ctrl.setActive(b.id);
    const active = host.profileViews!.getView(b.id)!;
    await flush();
    const inactiveExecute = vi.spyOn(first.webContents, 'executeJavaScript');
    const activeExecute = vi.spyOn(active.webContents, 'executeJavaScript');
    fake.powerMonitor.emit('resume');
    expect(activeExecute).toHaveBeenCalledExactlyOnceWith(WAKE_PAGE_SCRIPT);
    expect(inactiveExecute).not.toHaveBeenCalled();
    activeExecute.mockClear();
    vi.spyOn(active.webContents, 'isDestroyed').mockReturnValue(true);
    expect(() => fake.powerMonitor.emit('resume')).not.toThrow();
    host.profileViews!.setActive(null);
    expect(() => fake.powerMonitor.emit('resume')).not.toThrow();
    expect(activeExecute).not.toHaveBeenCalled();
  });

  it('pins config/workspace requests and header actions to the requested server', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();
    const ctrl = host.controller!;
    const a = ctrl.add('http://alpha.example.test:7070/');
    const b = ctrl.add('http://beta.example.test:7070/');
    host.profileViews!.addProfile(a.id, a.origin);
    host.profileViews!.addProfile(b.id, b.origin);
    ctrl.setActive(b.id);
    const view = host.profileViews!.getView(b.id)!;
    const execute = vi
      .spyOn(view.webContents, 'executeJavaScript')
      .mockResolvedValue('/beta/code');
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ hostname: 'BETA', workspaces: ['/beta/code'] }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetcher;
    const event = { sender: win.webContents };
    expect(
      await fake.ipcHandlers.get('phi:server-config')!(event, a.id),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await fake.ipcHandlers.get('phi:active-workspace')!(event, a.id),
    ).toBeNull();
    execute.mockClear();
    fake.ipcHandlers.get('phi:header-action')!(event, {
      kind: 'workspace',
      value: '/alpha/code',
      profileId: a.id,
    });
    expect(execute).not.toHaveBeenCalled();
    fake.ipcHandlers.get('phi:header-action')!(event, {
      kind: 'workspace',
      value: '/beta/code',
      profileId: b.id,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    execute.mockClear();
    const focus = vi.spyOn(view.webContents, 'focus');
    const headerAction = fake.ipcHandlers.get('phi:header-action')!;
    headerAction(event, {
      kind: 'click',
      id: 'header-notifications-btn',
      profileId: b.id,
    });
    expect(focus).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('header-notifications-btn');

    headerAction(event, {
      kind: 'click',
      id: 'header-notifications-btn',
      profileId: a.id,
    });
    headerAction(event, { kind: 'click', id: 'unknown-header-action' });
    headerAction(
      { sender: view.webContents },
      {
        kind: 'click',
        id: 'header-notifications-btn',
        profileId: b.id,
      },
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    headerAction(event, {
      kind: 'click',
      id: 'header-config-pill',
      profileId: b.id,
    });
    expect(focus).toHaveBeenCalledTimes(2);

    host.pushHeaderState(0, false, '/beta/code');
    expect(
      win.webContents.sent
        .filter(([channel]) => channel === 'phi:header-state')
        .at(-1)?.[1],
    ).toMatchObject({ profileId: b.id, workspace: '/beta/code' });
    ctrl.setActive(a.id);
    host.pushHeaderState(0, false, '/beta/code');
    expect(
      win.webContents.sent
        .filter(([channel]) => channel === 'phi:header-state')
        .at(-1)?.[1],
    ).toMatchObject({ profileId: a.id });
  });

  it('discards config from an earlier A visit after switching A → B → A', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();
    const ctrl = host.controller!;
    const a = ctrl.add('http://alpha.example.test:7070/');
    const b = ctrl.add('http://beta.example.test:7070/');
    host.profileViews!.addProfile(a.id, a.origin);
    host.profileViews!.addProfile(b.id, b.origin);
    ctrl.setActive(a.id);
    let finish: (response: Response) => void = () => {};
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fake.ipcHandlers.get('phi:server-config')!(
      { sender: win.webContents },
      a.id,
    );
    ctrl.setActive(b.id);
    ctrl.setActive(a.id);
    finish(
      new Response(
        JSON.stringify({ hostname: 'OLD A', workspaces: ['/old/a'] }),
        { status: 200 },
      ),
    );
    expect(await pending).toBeNull();
  });

  it('applies the saved power profile to desktop chrome on load and on tray changes', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    const rail = fake.FakeWebContentsView.instances[0];
    const mainExecute = vi.spyOn(win.webContents, 'executeJavaScript');
    const railExecute = vi.spyOn(rail.webContents, 'executeJavaScript');
    host.controller?.setLowPowerMode(true);
    expect(mainExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = true;'),
    );
    expect(railExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = true;'),
    );
    mainExecute.mockClear();
    railExecute.mockClear();
    win.webContents.emit('did-finish-load');
    rail.webContents.emit('did-finish-load');
    expect(mainExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = true;'),
    );
    expect(railExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = true;'),
    );
    host.controller?.setLowPowerMode(false);
    expect(mainExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = false;'),
    );
    expect(railExecute).toHaveBeenCalledWith(
      expect.stringContaining('const enabled = false;'),
    );
  });

  it('installs the second-instance listener exactly once during host.start (listener singleton)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    expect(primary.installListener).toHaveBeenCalledTimes(1);
  });

  it('retains a tray-hidden shell and foregrounds it without recreating the window (notif-fg)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    // Default close-to-tray hides without disposing the current native shell.
    first.close();
    expect(first.isDestroyed()).toBe(false);
    expect(host.window()).toBe(first as never);
    host.foreground();
    await flush();
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1);
    expect(first.showCalls).toBeGreaterThan(0);
  });

  it('serializes a true close with recreation: tears down session children and rail, then permits a fresh replacement (true close & recreate)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    // Create a session child before an asynchronously-completing native
    // close. The close event must fence launch delivery immediately, tear
    // down child/rail state, then permit a fresh replacement.
    const openPicker = fake.ipcEvents.get('phi:open-picker');
    if (!openPicker) throw new Error('picker handler missing');
    openPicker({ sender: first.webContents });
    const picker = fake.FakeBrowserWindow.instances[1];
    first.deferClose = true;
    host.controller?.setCloseToTray(false);
    first.close();
    expect(first.isDestroyed()).toBe(false);
    expect(host.window()).toBeNull();
    host.handleLaunch([
      { kind: 'server', value: 'https://replacement.example.test/' },
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);
    await flush();
    // The first native window is still completing its close, but its
    // session children and rail have been disposed before recreation.
    expect(picker.isDestroyed()).toBe(true);
    expect(first.contentView.removeCalls).toBeGreaterThan(0);
    expect(fake.FakeWebContentsView.instances[0]?.closeCalls).toBeGreaterThan(
      0,
    );
    const second = fake.FakeBrowserWindow.instances[2];
    expect(second).toBeDefined();
    expect(railSent(host)).not.toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);

    // Bring the replacement's main page to ready so the late launch below
    // can drain into it (drainLaunchPayloads requires mainPageReady).
    second.webContents.emit('did-finish-load');
    await flush();

    // After first.finishClose() a queued second-instance/activate must NOT
    // touch the destroyed window; the replacement's host state (profileViews,
    // railView) must remain bound so subsequent launches still deliver to it.
    const profileViewsBefore = (host as unknown as { profileViews: unknown })
      .profileViews;
    const railViewBefore = (host as unknown as { railView: unknown }).railView;
    const sentBeforeLate = railSent(host).length;
    const firstSentBefore = first.webContents.sent.length;
    first.finishClose();
    host.handleLaunch([{ kind: 'deep-link', value: 'phi://profile/late' }]);
    await flush();
    // The destroyed window must not receive any new IPC after the late
    // 'closed' event from first.finishClose().
    expect(first.webContents.sent.length).toBe(firstSentBefore);
    expect((host as unknown as { profileViews: unknown }).profileViews).toBe(
      profileViewsBefore,
    );
    expect((host as unknown as { railView: unknown }).railView).toBe(
      railViewBefore,
    );
    // And the replacement still receives the subsequent launch payload
    // (without the stale-closed guard the dispose would nullify profileViews
    // and drainLaunchPayloads would no-op).
    expect(railSent(host).length).toBeGreaterThan(sentBeforeLate);
    expect(railSent(host)).toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/late' },
    ]);
  });

  it('closes the add-server picker without touching the destroyed window (picker closed cleanup)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    const openPicker = fake.ipcEvents.get('phi:open-picker');
    if (!openPicker) throw new Error('picker handler missing');
    openPicker({ sender: first.webContents });
    const picker = fake.FakeBrowserWindow.instances[1];
    const contents = picker.webContents;
    // Real Electron throws "Object has been destroyed" when webContents
    // is read off a closed BrowserWindow; mimic that so this test pins
    // the cleanup against the real post-destroy contract. Emit 'closed'
    // directly: the fake's finishClose teardown itself reads webContents,
    // which the native side owns in production.
    picker.webContents.destroyed = true;
    Object.defineProperty(picker, 'webContents', {
      configurable: true,
      get(): never {
        throw new TypeError('Object has been destroyed');
      },
    });
    // This is the add-PC dialog close that used to pop the "JavaScript
    // error in the main process" box while still adding the server.
    expect(() => picker.emit('closed')).not.toThrow();
    const internals = host as unknown as {
      trustedSessionSenders: Set<unknown>;
      sessionChildren: Set<unknown>;
    };
    expect(internals.trustedSessionSenders.has(contents)).toBe(false);
    expect(internals.sessionChildren.has(picker)).toBe(false);
  });

  it('closes the rail server menu without touching the destroyed window (menu closed cleanup)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    const profile = host.controller?.add('https://menu.example.test/');
    if (!profile) throw new Error('controller missing');
    const profileId = profile.id;
    (
      host as unknown as {
        openRailMenu: (id: string, x: number, y: number) => void;
      }
    ).openRailMenu(profileId, 0, 0);
    const menu = fake.FakeBrowserWindow.instances[1];
    const contents = menu.webContents;
    menu.webContents.destroyed = true;
    Object.defineProperty(menu, 'webContents', {
      configurable: true,
      get(): never {
        throw new TypeError('Object has been destroyed');
      },
    });
    expect(() => menu.emit('closed')).not.toThrow();
    const internals = host as unknown as {
      trustedSessionSenders: Set<unknown>;
      sessionChildren: Set<unknown>;
    };
    expect(internals.trustedSessionSenders.has(contents)).toBe(false);
    expect(internals.sessionChildren.has(menu)).toBe(false);
  });

  it('drains queued launch payloads only after the replacement main view is ready (queue drain)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    first.deferClose = true;
    host.controller?.setCloseToTray(false);
    first.close();
    host.handleLaunch([
      { kind: 'server', value: 'https://replacement.example.test/' },
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);
    await flush();

    const second = fake.FakeBrowserWindow.instances[1];
    expect(second).toBeDefined();
    expect(railSent(host)).not.toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);

    second.webContents.emit('did-finish-load');
    await flush();
    expect(railSent(host)).toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);
    expect(second.showCalls).toBeGreaterThan(0);
    expect(second.focusCalls).toBeGreaterThan(0);
    expect(host.controller?.state().activeId).toBe('replacement-example-test');
    // Server activation runs before the following deep-link delivery in the
    // queued payload order; the controller's active id is the direct server
    // side effect and the renderer receives the deep link only afterward.
    const deepLinkPush = railSent(host).findIndex(
      ([channel, payload]) =>
        channel === FORWARD_CHANNEL &&
        (payload as { value?: string }).value === 'phi://profile/new',
    );
    expect(deepLinkPush).toBeGreaterThan(-1);

    first.finishClose();
  });

  it('does not trigger auth in the new session when an old-session config request resolves 401 after recreation (auth generation capture)', async () => {
    // One resolver PER URL: the desktop also probes a server's API
    // capability (/api/version) when a profile is activated, and a single
    // shared resolver let that probe steal the config request's resolver.
    // The test resolves the request it cares about by URL.
    const resolvers = new Map<string, (value: Response) => void>();
    globalThis.fetch = vi.fn(
      (input: unknown) =>
        new Promise<Response>((resolve) => {
          resolvers.set(
            String((input as { url?: string })?.url ?? input),
            resolve,
          );
        }),
    );
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    // Begin an old-session config request, then truly close. Resolving its
    // 401 after recreation must not create an auth prompt in the new shell.
    const profile = host.controller?.add('https://old.example.test/');
    if (!profile) throw new Error('controller missing');
    host.controller?.setActive(profile.id);
    const config = fake.ipcHandlers.get('phi:server-config');
    if (!config) throw new Error('server-config handler missing');
    const oldConfig = config({ sender: first.webContents });

    first.deferClose = true;
    host.controller?.setCloseToTray(false);
    first.close();
    host.handleLaunch([
      { kind: 'server', value: 'https://replacement.example.test/' },
    ]);
    await flush();

    const second = fake.FakeBrowserWindow.instances[1];
    expect(second).toBeDefined();
    second.webContents.emit('did-finish-load');
    await flush();

    const oldConfigUrl = 'https://old.example.test/api/config';
    expect(resolvers.has(oldConfigUrl)).toBe(true);
    resolvers.get(oldConfigUrl)?.({ status: 401, ok: false } as Response);
    await oldConfig;
    expect(
      second.webContents.sent.some(
        ([channel]) => channel === 'phi:auth-required',
      ),
    ).toBe(false);

    first.finishClose();
  });

  it('dismisses the prompt after a typed unlock in single-tab mode (shared embedded view)', async () => {
    // The embedded page serves every server, so ONE view is the body for
    // all of them. The unlock path must find that view: when it did not,
    // a correct password left the prompt on screen and asked again.
    const previous = process.env.PHI_DESKTOP_LOW_MEMORY;
    process.env.PHI_DESKTOP_LOW_MEMORY = '1';
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const saltB64 = salt.toString('base64url');

    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      // Only the server answers: a request addressed to anything else (the
      // embedded app's own origin, for instance) fails, so a wrong origin
      // cannot pass by accident.
      if (!u.startsWith('https://minerva.example.test')) {
        return {
          status: 404,
          ok: false,
          text: async () => 'not found',
          json: async () => ({}),
        } as Response;
      }
      if (u.includes('/api/auth/status')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            enabled: true,
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: saltB64,
            challenge: 'test-challenge',
          }),
        } as Response;
      }
      if (u.includes('/api/auth/login')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            'set-cookie':
              'phi_access_session=mock-session-cookie; Path=/; HttpOnly',
          }),
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }
      if (u.includes('/api/config')) {
        const headers = (init?.headers as Record<string, string>) ?? {};
        const cookie = headers.Cookie || headers.cookie || '';
        if (cookie.includes('phi_access_session')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify({
                hostname: 'minerva',
                workspaces: ['/Users/minerva/project'],
                active_cwd: '/Users/minerva/project',
              }),
            json: async () => ({
              hostname: 'minerva',
              workspaces: ['/Users/minerva/project'],
              active_cwd: '/Users/minerva/project',
            }),
          } as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () => 'access authentication required',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    try {
      const host = new DesktopHost();
      await host.start(primary);
      const win = fake.FakeBrowserWindow.instances[0];
      win.webContents.emit('did-finish-load');
      await flush();

      const profile = host.controller?.add('https://minerva.example.test/');
      if (!profile) throw new Error('controller missing');
      host.profileViews!.addProfile(profile.id, profile.origin);
      host.controller?.setActive(profile.id);
      await flush();
      expect(host.profileViews!.isSingleTab()).toBe(true);
      // The embedded body view reports its load like the real one does.
      const bodyViews = fake.FakeWebContentsView.instances;
      const bodyView = bodyViews[bodyViews.length - 1];
      bodyView.webContents.executeJavaScript = async (script: string) => {
        if (script.includes('/api/auth/login')) return 200;
        // The embedded page handles the switch itself (no reload).
        if (script.includes('__phiEmbed')) return true;
        return null;
      };
      bodyView.webContents.emit('did-finish-load');
      await flush();

      // The config poll answers 401: the desktop asks for the password.
      const configHandler = fake.ipcHandlers.get('phi:server-config');
      if (!configHandler) throw new Error('server-config handler missing');
      await configHandler({ sender: win.webContents });
      await flush();

      const required = win.webContents.sent.filter(
        ([channel]) => channel === 'phi:auth-required',
      );
      expect(required.length).toBeGreaterThan(0);
      const requestId = (
        required[required.length - 1][1] as { requestId: string }
      ).requestId;
      expect(requestId).toBeTruthy();

      const unlockHandler = fake.ipcHandlers.get('phi:auth-unlock');
      if (!unlockHandler) throw new Error('auth-unlock handler missing');
      const result = (await unlockHandler(
        { sender: win.webContents },
        { requestId, password: 'a long enough password' },
      )) as unknown as { ok: boolean; code?: string };
      expect(result).toEqual({ ok: true, config: expect.anything() });

      // The prompt is dismissed: the body is no longer obscured.
      const obscuring = win.webContents.sent.filter(
        ([channel]) => channel === 'phi:body-obscuring',
      );
      expect(obscuring).toContainEqual(['phi:body-obscuring', false]);
      const resolved = win.webContents.sent.filter(
        ([channel]) => channel === 'phi:auth-resolved',
      );
      expect(resolved.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) {
        delete process.env.PHI_DESKTOP_LOW_MEMORY;
      } else {
        process.env.PHI_DESKTOP_LOW_MEMORY = previous;
      }
      vi.unstubAllGlobals();
    }
  });

  it('rejects stale old-session main-frame senders for controller mutations and window-minimize (sender trust)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    first.deferClose = true;
    host.controller?.setCloseToTray(false);
    first.close();
    host.handleLaunch([
      { kind: 'server', value: 'https://replacement.example.test/' },
    ]);
    await flush();

    const second = fake.FakeBrowserWindow.instances[1];
    second.webContents.emit('did-finish-load');
    await flush();

    // A stale old main-frame sender cannot mutate the current controller;
    // the new session's local main-frame sender can.
    const add = fake.ipcEvents.get('phi:add-server');
    if (!add) throw new Error('add-server handler missing');
    const before = host.controller?.state().profiles.length;
    add({ sender: first.webContents }, 'https://forbidden.example.test/');
    expect(host.controller?.state().profiles.length).toBe(before);
    add({ sender: second.webContents }, 'https://allowed.example.test/');
    expect(host.controller?.state().profiles.length).toBe((before ?? 0) + 1);
    const minimize = fake.ipcHandlers.get('phi:window-minimize');
    if (!minimize) throw new Error('window minimize handler missing');
    minimize({ sender: first.webContents });
    expect(second.minimized).toBe(false);
    minimize({ sender: second.webContents });
    expect(second.minimized).toBe(true);

    first.finishClose();
  });

  it('resets the header-state snapshot during disposal so the replacement does not inherit a stale value (header-state reset)', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const first = fake.FakeBrowserWindow.instances[0];
    first.webContents.emit('did-finish-load');
    await flush();

    // A fresh main view must not inherit a stale CPU/activity header snapshot.
    (host as unknown as { lastHeaderState: unknown }).lastHeaderState = {
      cpu: 99,
      activity: true,
    };
    first.deferClose = true;
    host.controller?.setCloseToTray(false);
    first.close();
    host.handleLaunch([
      { kind: 'server', value: 'https://replacement.example.test/' },
    ]);
    await flush();

    expect(
      (host as unknown as { lastHeaderState: unknown }).lastHeaderState,
    ).toBeNull();

    first.finishClose();
  });

  it('resolves server config directly from authenticated body view on 401 fallback without prompting', async () => {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/api/config')) {
        return {
          status: 401,
          ok: false,
          text: async () => 'access authentication required',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ enabled: true, version: 'v1' }),
      } as Response;
    });

    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    host.handleLaunch([
      { kind: 'server', value: 'https://minerva.example.test/' },
    ]);
    await flush();

    // Body view is authenticated and returns its rendered config
    const bodyViews = fake.FakeWebContentsView.instances;
    expect(bodyViews.length).toBeGreaterThan(0);
    const bodyView = bodyViews[bodyViews.length - 1];
    bodyView.webContents.executeJavaScript = async (script: string) => {
      if (script.includes('workspace-select')) {
        return {
          hostname: 'minerva',
          workspaces: ['/Users/minerva/code/project'],
          active_cwd: '/Users/minerva/code/project',
          theme_color: 'amber',
        };
      }
      return null;
    };

    const fetchConfigHandler = fake.ipcHandlers.get('phi:server-config');
    expect(fetchConfigHandler).toBeDefined();
    const config = await fetchConfigHandler?.({ sender: win.webContents });

    expect(config).toEqual({
      hostname: 'minerva',
      workspaces: ['/Users/minerva/code/project'],
      active_cwd: '/Users/minerva/code/project',
      theme_color: 'amber',
    });

    // phi:auth-required must NOT have been sent because the body view resolved the config
    expect(
      win.webContents.sent.some(([channel]) => channel === 'phi:auth-required'),
    ).toBe(false);

    win.finishClose();
  });

  it('silently authenticates and syncs TBAR by recovering credentials from body view localStorage on 401', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const verifier = Buffer.alloc(32, 0x42);
    const saltB64 = salt.toString('base64url');
    const verifierB64 = verifier.toString('base64url');

    let hasSessionCookie = false;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/auth/status')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            enabled: true,
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: saltB64,
            challenge: 'test-challenge',
          }),
        } as Response;
      }
      if (u.includes('/api/auth/login')) {
        hasSessionCookie = true;
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            'set-cookie':
              'phi_access_session=mock-session-cookie; Path=/; HttpOnly',
          }),
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }
      if (u.includes('/api/config')) {
        const headers = (init?.headers as Record<string, string>) ?? {};
        const cookie = headers.Cookie || headers.cookie || '';
        if (hasSessionCookie || cookie.includes('phi_access_session')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify({
                hostname: 'minerva',
                workspaces: ['/Users/minerva/project'],
                active_cwd: '/Users/minerva/project',
                theme_color: 'cyan',
              }),
            json: async () => ({
              hostname: 'minerva',
              workspaces: ['/Users/minerva/project'],
              active_cwd: '/Users/minerva/project',
              theme_color: 'cyan',
            }),
          } as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () => 'access authentication required',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ enabled: true, version: 'v1' }),
      } as Response;
    });

    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    host.handleLaunch([
      { kind: 'server', value: 'https://minerva.example.test/' },
    ]);
    await flush();

    const bodyViews = fake.FakeWebContentsView.instances;
    expect(bodyViews.length).toBeGreaterThan(0);
    const bodyView = bodyViews[bodyViews.length - 1];

    // Mock localStorage credential in the body view
    bodyView.webContents.executeJavaScript = async (script: string) => {
      if (script.includes('phi_access_credential_v1')) {
        return JSON.stringify({
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          salt: saltB64,
          verifier: verifierB64,
        });
      }
      return null;
    };

    const fetchConfigHandler = fake.ipcHandlers.get('phi:server-config');
    expect(fetchConfigHandler).toBeDefined();
    const config = await fetchConfigHandler?.({ sender: win.webContents });

    expect(config).toEqual({
      hostname: 'minerva',
      workspaces: ['/Users/minerva/project'],
      active_cwd: '/Users/minerva/project',
      theme_color: 'cyan',
    });

    // phi:auth-required must NOT have been sent because localStorage verifier auto-unlocked
    expect(
      win.webContents.sent.some(([channel]) => channel === 'phi:auth-required'),
    ).toBe(false);

    win.finishClose();
  });

  it('auto-recovers credential on body view did-finish-load to resolve pending unlock and push active server', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const verifier = Buffer.alloc(32, 0x42);
    const saltB64 = salt.toString('base64url');
    const verifierB64 = verifier.toString('base64url');

    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/api/auth/status')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            enabled: true,
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: saltB64,
            challenge: 'test-challenge',
          }),
        } as Response;
      }
      if (u.includes('/api/auth/login')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            'set-cookie':
              'phi_access_session=mock-session-cookie; Path=/; HttpOnly',
          }),
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ enabled: true }),
      } as Response;
    });

    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    host.handleLaunch([
      { kind: 'server', value: 'https://minerva.example.test/' },
    ]);
    await flush();

    const bodyViews = fake.FakeWebContentsView.instances;
    const bodyView = bodyViews[bodyViews.length - 1];

    bodyView.webContents.executeJavaScript = async (script: string) => {
      if (script.includes('phi_access_credential_v1')) {
        return JSON.stringify({
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          salt: saltB64,
          verifier: verifierB64,
        });
      }
      return null;
    };

    // Emit did-finish-load on the body view
    bodyView.webContents.emit('did-finish-load');
    await flush();

    // Verify phi:active-server was sent with the profile info
    const activeServerSent = win.webContents.sent.filter(
      ([channel]) => channel === 'phi:active-server',
    );
    expect(activeServerSent.length).toBeGreaterThan(0);

    win.finishClose();
  });

  it('successfully resolves TBAR auth for server with trailing slash when config is polled before and after body view load', async () => {
    // The single-tab (embedded) mode and the legacy one-page-per-server
    // mode are different code paths. The mode used to depend on the
    // machine's RAM, so the same test covered a different path on a
    // laptop than on a CI runner. Both modes run here.
    for (const mode of ['0', '1']) {
      await runTbarAuthScenario(mode);
    }
  });

  const runTbarAuthScenario = async (mode: string): Promise<void> => {
    fake.reset();
    process.env.PHI_DESKTOP_LOW_MEMORY = mode;
    // A fresh user-data directory per mode: the first run persists its
    // settings, and the second run must not inherit them.
    rmSync(temp, { recursive: true, force: true });
    temp = mkdtempSync(path.join(os.tmpdir(), 'phi-desktop-lifecycle-'));
    fake.setUserData(temp);
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const verifier = Buffer.alloc(32, 0x42);
    const saltB64 = salt.toString('base64url');
    const verifierB64 = verifier.toString('base64url');

    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/auth/status')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            enabled: true,
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: saltB64,
            challenge: 'test-challenge',
          }),
        } as Response;
      }
      if (u.includes('/api/auth/login')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            'set-cookie':
              'phi_access_session=mock-session-cookie; Path=/; HttpOnly',
          }),
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }
      if (u.includes('/api/config')) {
        const headers = (init?.headers as Record<string, string>) ?? {};
        const cookie = headers.Cookie || headers.cookie || '';
        if (cookie.includes('phi_access_session')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify({
                hostname: 'minerva',
                workspaces: ['/Users/minerva/project'],
                active_cwd: '/Users/minerva/project',
                theme_color: 'cyan',
              }),
            json: async () => ({
              hostname: 'minerva',
              workspaces: ['/Users/minerva/project'],
              active_cwd: '/Users/minerva/project',
              theme_color: 'cyan',
            }),
          } as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () => 'access authentication required',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ enabled: true }),
      } as Response;
    });

    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    host.handleLaunch([
      { kind: 'server', value: 'https://minerva.example.test/' },
    ]);
    await flush();

    const fetchConfigHandler = fake.ipcHandlers.get('phi:server-config');
    expect(fetchConfigHandler).toBeDefined();

    // 1. Initial poll while bodyView is loading
    const config1 = await fetchConfigHandler?.({ sender: win.webContents });
    expect(config1).toBeNull(); // Expected: 401 prompt triggered pendingUnlock

    const bodyViews = fake.FakeWebContentsView.instances;
    const bodyView = bodyViews[bodyViews.length - 1];

    const credentialScripts: string[] = [];
    bodyView.webContents.executeJavaScript = async (script: string) => {
      if (script.includes('phi_access_credential_v1')) {
        credentialScripts.push(script);
        return JSON.stringify({
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          salt: saltB64,
          verifier: verifierB64,
        });
      }
      return null;
    };

    // 2. Body view finishes loading and triggers auto-recover
    bodyView.webContents.emit('did-finish-load');
    await flush();
    await flush();

    // The page and the desktop must agree on the credential key: the
    // embedded page serves every server from one localStorage, so the key
    // is namespaced per server there and plain in a browser tab.
    expect(
      credentialScripts.some((script) =>
        mode === '1'
          ? script.includes('phi_access_credential_v1:')
          : script.includes('phi_access_credential_v1') &&
            !script.includes('phi_access_credential_v1:'),
      ),
    ).toBe(true);

    // With the canonical origin and prompt resolution fix:
    // makeView's did-finish-load matches canonical origins, unlocks with verifier,
    // clears pendingUnlock, sends sendBodyObscuring(false), and sends phi:auth-resolved.
    const obscuringEvents = win.webContents.sent.filter(
      ([channel]) => channel === 'phi:body-obscuring',
    );
    expect(obscuringEvents).toEqual([
      ['phi:body-obscuring', true],
      ['phi:body-obscuring', false],
    ]);

    const resolvedEvents = win.webContents.sent.filter(
      ([channel]) => channel === 'phi:auth-resolved',
    );
    expect(resolvedEvents.length).toBeGreaterThan(0);

    // Furthermore, did-finish-load called accessAuth.tryUnlockWithVerifier with the canonical origin,
    // storing the session cookie under 'https://minerva.example.test' and persisting the verifier.
    // The subsequent TBAR poll (phi:server-config) looks up 'https://minerva.example.test',
    // finds the session cookie (or stored credential) and returns the real server config!
    bodyView.webContents.executeJavaScript = async () => null; // Simulate view unable to run recovery again
    const config2 = await fetchConfigHandler?.({ sender: win.webContents });
    expect(config2).not.toBeNull();
    expect((config2 as unknown as { hostname: string }).hostname).toBe(
      'minerva',
    );

    win.finishClose();
  };
});
