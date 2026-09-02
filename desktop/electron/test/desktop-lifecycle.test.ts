// @vitest-environment node
/**
 * Fake-Electron lifecycle coverage for DesktopHost. These tests exercise a
 * real host instance while keeping every Electron object recording-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
  return {
    FakeBrowserWindow,
    FakeWebContentsView,
    app,
    ipcMain,
    ipcEvents,
    ipcHandlers,
    setUserData: (value: string) => (userData = value),
    reset: () => {
      FakeBrowserWindow.instances.length = 0;
      FakeWebContentsView.instances.length = 0;
      appEvents.listeners.clear();
      ipcEvents.clear();
      ipcHandlers.clear();
    },
  };
});

vi.mock('electron', () => ({
  app: fake.app,
  ipcMain: fake.ipcMain,
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  Notification: class {
    show(): void {}
  },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { defaultSession: {} },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  Tray: class {
    setToolTip(): void {}
    on(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  globalShortcut: { register: () => true, unregister: () => {} },
}));

import { DesktopHost } from '../src/desktop.js';
import { FORWARD_CHANNEL } from '../src/single-instance.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const primary = {
  primary: true,
  acquire: () => ({ lost: false, forwarded: false }),
  installListener: vi.fn(),
};

describe('DesktopHost fake-Electron lifecycle', () => {
  let temp = '';
  let originalFetch: typeof fetch;

  beforeEach(() => {
    fake.reset();
    primary.installListener.mockClear();
    temp = mkdtempSync(path.join(os.tmpdir(), 'phi-desktop-lifecycle-'));
    fake.setUserData(temp);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(temp, { recursive: true, force: true });
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
    expect(second.webContents.sent).not.toContainEqual([
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
    const sentBeforeLate = second.webContents.sent.length;
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
    expect(second.webContents.sent.length).toBeGreaterThan(sentBeforeLate);
    expect(second.webContents.sent).toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/late' },
    ]);
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
    expect(second.webContents.sent).not.toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);

    second.webContents.emit('did-finish-load');
    await flush();
    expect(second.webContents.sent).toContainEqual([
      FORWARD_CHANNEL,
      { kind: 'deep-link', value: 'phi://profile/new' },
    ]);
    expect(second.showCalls).toBeGreaterThan(0);
    expect(second.focusCalls).toBeGreaterThan(0);
    expect(host.controller?.state().activeId).toBe('replacement-example-test');
    // Server activation runs before the following deep-link delivery in the
    // queued payload order; the controller's active id is the direct server
    // side effect and the renderer receives the deep link only afterward.
    const deepLinkPush = second.webContents.sent.findIndex(
      ([channel, payload]) =>
        channel === FORWARD_CHANNEL &&
        (payload as { value?: string }).value === 'phi://profile/new',
    );
    expect(deepLinkPush).toBeGreaterThan(-1);

    first.finishClose();
  });

  it('does not trigger auth in the new session when an old-session config request resolves 401 after recreation (auth generation capture)', async () => {
    let resolveConfig: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveConfig = resolve;
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

    resolveConfig?.({ status: 401, ok: false } as Response);
    await oldConfig;
    expect(
      second.webContents.sent.some(
        ([channel]) => channel === 'phi:auth-required',
      ),
    ).toBe(false);

    first.finishClose();
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
});
