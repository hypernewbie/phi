// @vitest-environment node
/**
 * Fake-Electron lifecycle coverage for DesktopHost. These tests exercise a
 * real host instance while keeping every Electron object recording-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    url = '';
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
    loadURL(url?: string): Promise<void> {
      if (typeof url === 'string') this.url = url;
      return Promise.resolve();
    }
    getURL(): string {
      return this.url;
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
  // Controllable safeStorage for credential-persistence tests. The
  // "ciphertext" is a prefix plus base64 so a test can prove the plaintext
  // bearer never reaches the file.
  const safeStorage = {
    available: false,
    backend: 'keychain',
    failEncrypt: false,
    isEncryptionAvailable: () => safeStorage.available,
    getSelectedStorageBackend: () => safeStorage.backend,
    encryptString: (value: string) => {
      if (safeStorage.failEncrypt) throw new Error('encrypt failed');
      return Buffer.from(`enc:${Buffer.from(value).toString('base64')}`);
    },
    decryptString: (value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith('enc:')) throw new Error('decrypt failed');
      return Buffer.from(text.slice(4), 'base64').toString();
    },
  };
  return {
    FakeBrowserWindow,
    FakeWebContentsView,
    app,
    ipcMain,
    ipcEvents,
    ipcHandlers,
    safeStorage,
    setUserData: (value: string) => (userData = value),
    reset: () => {
      FakeBrowserWindow.instances.length = 0;
      FakeWebContentsView.instances.length = 0;
      appEvents.listeners.clear();
      ipcEvents.clear();
      ipcHandlers.clear();
      safeStorage.available = false;
      safeStorage.backend = 'keychain';
      safeStorage.failEncrypt = false;
    },
  };
});

vi.mock('electron', () => ({
  app: fake.app,
  ipcMain: fake.ipcMain,
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  Notification: class {
    show(): void {}
  },
  safeStorage: fake.safeStorage,
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
  powerMonitor: { on: vi.fn(), emit: vi.fn() },
}));

import { DesktopHost } from '../src/desktop.js';
import { AccessAuth } from '../src/access-auth.js';
import { FORWARD_CHANNEL } from '../src/single-instance.js';

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
    globalThis.fetch = originalFetch;
    rmSync(temp, { recursive: true, force: true });
    if (previousLowMemory === undefined) {
      delete process.env.PHI_DESKTOP_LOW_MEMORY;
    } else {
      process.env.PHI_DESKTOP_LOW_MEMORY = previousLowMemory;
    }
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
            authenticated: false,
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

  it('installs a host v2 bearer into the trusted body view without a v1 proof', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (!u.startsWith('https://minerva.example.test')) {
        return { status: 404, ok: false, json: async () => ({}) } as Response;
      }
      if (u.includes('/api/auth/status')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            enabled: true,
            authenticated: false,
            protocols: ['v1', 'v2'],
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: salt.toString('base64url'),
            challenge: 'test-challenge',
          }),
        } as Response;
      }
      if (u.includes('/api/auth/v2/login')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ token: 'host-token' }),
        } as Response;
      }
      if (u.includes('/api/config')) {
        const headers = (init?.headers as Record<string, string>) ?? {};
        const authorization = headers.Authorization || headers.authorization;
        if (authorization === 'Bearer host-token') {
          const body = JSON.stringify({
            hostname: 'minerva',
            workspaces: ['/Users/minerva/project'],
            active_cwd: '/Users/minerva/project',
          });
          return {
            status: 200,
            ok: true,
            text: async () => body,
            json: async () => JSON.parse(body),
          } as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () => 'access authentication required',
        } as Response;
      }
      return { status: 200, ok: true, json: async () => ({}) } as Response;
    });

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

    const bodyViews = fake.FakeWebContentsView.instances;
    const bodyView = bodyViews[bodyViews.length - 1];
    const scripts: string[] = [];
    bodyView.webContents.executeJavaScript = async (script: string) => {
      scripts.push(script);
      if (script.includes('installToken')) return 200;
      return null;
    };
    bodyView.webContents.emit('did-finish-load');
    await flush();

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

    const unlockHandler = fake.ipcHandlers.get('phi:auth-unlock');
    if (!unlockHandler) throw new Error('auth-unlock handler missing');
    const result = (await unlockHandler(
      { sender: win.webContents },
      { requestId, password: 'a long enough password' },
    )) as unknown as { ok: boolean; code?: string };
    expect(result).toEqual({ ok: true, config: expect.anything() });

    // The v2 body receives the bearer; the legacy one-time proof is never
    // used, and the page is not reloaded (a reload would discard it).
    expect(
      scripts.some(
        (script) =>
          script.includes('installToken') && script.includes('"host-token"'),
      ),
    ).toBe(true);
    expect(scripts.some((script) => script.includes('/api/auth/login'))).toBe(
      false,
    );
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
            authenticated: false,
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
            authenticated: false,
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
            authenticated: false,
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

describe('DesktopHost credential persistence (v1 + v2)', () => {
  const originA = 'https://a.example.test';
  const originB = 'https://b.example.test';
  const v1Entry = {
    version: 'v1' as const,
    algorithm: 'pbkdf2-sha256' as const,
    iterations: 600_000,
    salt: Buffer.alloc(16, 0x11),
    verifier: Buffer.alloc(32, 0x22),
  };
  type TestHost = {
    storedCredentials: Map<string, unknown>;
    saveStoredCredentials(): void;
    loadStoredCredentials(): void;
    bootstrapV2Token(
      origin: string,
      jwt: string,
      auth: AccessAuth,
      generation: number,
    ): Promise<void>;
    sessionGeneration: number;
    credentialsPath: string;
  };
  const hostOf = (): TestHost => new DesktopHost() as unknown as TestHost;
  const encrypted = (origins: Record<string, unknown>): Buffer =>
    fake.safeStorage.encryptString(JSON.stringify({ origins }));

  let temp = '';

  beforeEach(() => {
    fake.reset();
    temp = mkdtempSync(path.join(os.tmpdir(), 'phi-desktop-creds-'));
    fake.setUserData(temp);
    fake.safeStorage.available = true;
  });

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('round-trips mixed v1/v2 entries without writing the v2 plaintext', () => {
    const host = hostOf();
    host.storedCredentials.set(originA, v1Entry);
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'jwt-secret' });
    host.saveStoredCredentials();

    const onDisk = readFileSync(host.credentialsPath);
    expect(onDisk.toString()).not.toContain('jwt-secret');
    expect(onDisk.toString()).not.toContain(
      v1Entry.verifier.toString('base64url'),
    );

    const reloaded = hostOf();
    reloaded.loadStoredCredentials();
    expect(reloaded.storedCredentials.size).toBe(2);
    expect(reloaded.storedCredentials.get(originA)).toMatchObject({
      version: 'v1',
      iterations: 600_000,
    });
    expect(reloaded.storedCredentials.get(originB)).toEqual({
      version: 'v2',
      jwt: 'jwt-secret',
    });
  });

  it('loads a legacy v1-only file', () => {
    const host = hostOf();
    writeFileSync(
      host.credentialsPath,
      encrypted({
        [originA]: {
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          saltBase64: v1Entry.salt.toString('base64url'),
          verifierBase64: v1Entry.verifier.toString('base64url'),
        },
      }),
    );
    host.loadStoredCredentials();
    expect(host.storedCredentials.get(originA)).toMatchObject({
      version: 'v1',
      iterations: 600_000,
    });
  });

  it('drops malformed entries independently', () => {
    const host = hostOf();
    writeFileSync(
      host.credentialsPath,
      encrypted({
        [originA]: {
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          saltBase64: v1Entry.salt.toString('base64url'),
          verifierBase64: v1Entry.verifier.toString('base64url'),
        },
        'https://bad-v1.example.test': {
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          saltBase64: '',
          verifierBase64: 'AAAA',
        },
        [originB]: { version: 'v2', jwt: 'ok-token' },
        'https://bad-v2.example.test': { version: 'v2', jwt: 42 },
        'not a url': { version: 'v2', jwt: 'ignored' },
      }),
    );
    host.loadStoredCredentials();
    expect(Array.from(host.storedCredentials.keys()).sort()).toEqual(
      [originA, originB].sort(),
    );
  });

  it('clears the store when the file cannot be decrypted', () => {
    const host = hostOf();
    writeFileSync(host.credentialsPath, Buffer.from('not encrypted'));
    host.storedCredentials.set(originA, v1Entry);
    host.loadStoredCredentials();
    expect(host.storedCredentials.size).toBe(0);
  });

  it('neither reads nor writes when encryption is unavailable', () => {
    fake.safeStorage.available = false;
    const host = hostOf();
    writeFileSync(
      host.credentialsPath,
      encrypted({ [originA]: { version: 'v2', jwt: 'tok' } }),
    );
    host.loadStoredCredentials();
    expect(host.storedCredentials.size).toBe(0);

    const before = readFileSync(host.credentialsPath);
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'new-tok' });
    host.saveStoredCredentials();
    expect(readFileSync(host.credentialsPath)).toEqual(before);
  });

  it('refuses v2 writes and v2 loads on the Linux basic_text backend', () => {
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: { value: 'linux' },
      }) as NodeJS.Process,
    );
    fake.safeStorage.backend = 'basic_text';
    const host = hostOf();
    writeFileSync(
      host.credentialsPath,
      encrypted({
        [originA]: {
          version: 'v1',
          algorithm: 'pbkdf2-sha256',
          iterations: 600_000,
          saltBase64: v1Entry.salt.toString('base64url'),
          verifierBase64: v1Entry.verifier.toString('base64url'),
        },
        [originB]: { version: 'v2', jwt: 'tok' },
      }),
    );
    host.loadStoredCredentials();
    expect(host.storedCredentials.has(originA)).toBe(true);
    expect(host.storedCredentials.has(originB)).toBe(false);

    const before = readFileSync(host.credentialsPath);
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'new-tok' });
    host.saveStoredCredentials();
    expect(readFileSync(host.credentialsPath)).toEqual(before);

    // A v1-only store still writes through the legacy backend.
    host.storedCredentials.delete(originB);
    host.saveStoredCredentials();
    expect(readFileSync(host.credentialsPath)).not.toEqual(before);
  });

  it('leaves the old file intact when encryption throws', () => {
    const host = hostOf();
    host.storedCredentials.set(originA, v1Entry);
    host.saveStoredCredentials();
    const before = readFileSync(host.credentialsPath);
    fake.safeStorage.failEncrypt = true;
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'tok' });
    host.saveStoredCredentials();
    expect(readFileSync(host.credentialsPath)).toEqual(before);
  });

  it('swallows a write failure without losing memory state', () => {
    const host = hostOf();
    mkdirSync(host.credentialsPath);
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'tok' });
    expect(() => host.saveStoredCredentials()).not.toThrow();
    expect(host.storedCredentials.get(originB)).toEqual({
      version: 'v2',
      jwt: 'tok',
    });
    expect(existsSync(host.credentialsPath)).toBe(true);
  });

  it('keeps a valid token and clears only the rejected one', async () => {
    const host = hostOf();
    const auth = new AccessAuth((async (url: URL) => {
      if (url.pathname === '/api/auth/v2/status') {
        return new Response(
          JSON.stringify({ enabled: true, authenticated: true }),
          {
            status: 200,
          },
        );
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch);
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'good' });
    await host.bootstrapV2Token(originA, 'good', auth, host.sessionGeneration);
    expect(auth.getToken(originA)).toBe('good');
    expect(host.storedCredentials.has(originA)).toBe(true);

    const rejecting = new AccessAuth(
      (async () =>
        new Response('', { status: 401 })) as unknown as typeof fetch,
    );
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'bad' });
    await host.bootstrapV2Token(
      originB,
      'bad',
      rejecting,
      host.sessionGeneration,
    );
    expect(rejecting.getToken(originB)).toBeNull();
    expect(rejecting.getSelectedProtocol(originB)).toBe('v2');
    expect(host.storedCredentials.has(originB)).toBe(false);
  });

  it('withholds a restored bearer from the body until the server validates it', async () => {
    const host = hostOf() as TestHost & { bodyTokens: Map<string, string> };
    const transient = new AccessAuth(
      (async () =>
        new Response('', { status: 503 })) as unknown as typeof fetch,
    );
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'restored' });
    await host.bootstrapV2Token(
      originA,
      'restored',
      transient,
      host.sessionGeneration,
    );
    // Native retries keep the token; a renderer must not receive an
    // unconfirmed bearer.
    expect(transient.getToken(originA)).toBe('restored');
    expect(host.bodyTokens.has(originA)).toBe(false);

    const valid = new AccessAuth(
      (async () =>
        new Response(JSON.stringify({ enabled: true, authenticated: true }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    await host.bootstrapV2Token(
      originB,
      'checked',
      valid,
      host.sessionGeneration,
    );
    expect(host.bodyTokens.get(originB)).toBe('checked');
  });

  it('installs the host bearer into a popout only after the origin authorized it', () => {
    const host = hostOf() as TestHost & {
      bodyTokens: Map<string, string>;
      installPopoutToken(
        contents: unknown,
        origin: string,
        auth: AccessAuth,
        generation: number,
        isCurrent: () => boolean,
      ): void;
    };
    const auth = new AccessAuth();
    auth.installToken(originA, 'popout-token');
    const child = new fake.FakeBrowserWindow({}).webContents;
    child.url = `${originA}/md.html`;
    const scripts: string[] = [];
    child.executeJavaScript = async (script: string) => {
      scripts.push(script);
      return null;
    };
    host.installPopoutToken(
      child,
      originA,
      auth,
      host.sessionGeneration,
      () => true,
    );

    // A popout has no cookie to inherit, but an unconfirmed bearer must not
    // reach a renderer either.
    child.emit('did-finish-load');
    expect(scripts).toHaveLength(0);
    host.bodyTokens.set(originA, 'popout-token');
    child.emit('did-finish-load');
    expect(scripts.some((s) => s.includes('"popout-token"'))).toBe(true);
  });

  it('keeps a token on a transient failure and never overwrites a newer one', async () => {
    const host = hostOf();
    const transient = new AccessAuth(
      (async () =>
        new Response('', { status: 503 })) as unknown as typeof fetch,
    );
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'kept' });
    await host.bootstrapV2Token(
      originA,
      'kept',
      transient,
      host.sessionGeneration,
    );
    expect(transient.getToken(originA)).toBe('kept');
    expect(host.storedCredentials.has(originA)).toBe(true);

    const newer = new AccessAuth();
    newer.installToken(originB, 'newer');
    host.storedCredentials.set(originB, { version: 'v2', jwt: 'older' });
    await host.bootstrapV2Token(
      originB,
      'older',
      newer,
      host.sessionGeneration,
    );
    expect(newer.getToken(originB)).toBe('newer');
    expect(host.storedCredentials.get(originB)).toEqual({
      version: 'v2',
      jwt: 'older',
    });
  });

  it('keeps a native unlock ready when a stale token is accepted late', async () => {
    const host = hostOf() as TestHost & { bodyTokens: Map<string, string> };
    let release!: (res: Response) => void;
    const auth = new AccessAuth((async () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch);
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'restored' });
    const pending = host.bootstrapV2Token(
      originA,
      'restored',
      auth,
      host.sessionGeneration,
    );
    // The native unlock finishes while the restored token is still checking.
    auth.installToken(originA, 'fresh');
    host.bodyTokens.set(originA, 'fresh');
    release(
      new Response(JSON.stringify({ enabled: true, authenticated: true }), {
        status: 200,
      }),
    );
    await pending;
    expect(auth.getToken(originA)).toBe('fresh');
    expect(host.bodyTokens.get(originA)).toBe('fresh');
  });

  it('keeps a native unlock ready when a stale token is rejected late', async () => {
    const host = hostOf() as TestHost & { bodyTokens: Map<string, string> };
    let release!: (res: Response) => void;
    const auth = new AccessAuth((async () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch);
    host.storedCredentials.set(originA, { version: 'v2', jwt: 'restored' });
    const pending = host.bootstrapV2Token(
      originA,
      'restored',
      auth,
      host.sessionGeneration,
    );
    auth.installToken(originA, 'fresh');
    host.bodyTokens.set(originA, 'fresh');
    release(new Response('', { status: 401 }));
    await pending;
    expect(auth.getToken(originA)).toBe('fresh');
    expect(host.bodyTokens.get(originA)).toBe('fresh');
  });
});
