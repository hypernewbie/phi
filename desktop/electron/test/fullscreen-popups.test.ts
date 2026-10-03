// @vitest-environment node
/**
 * Reproduction and behavioral tests for popups and context menus in
 * fullscreen mode (Bug: "fullscreen --> open config or right click context menu on tbar").
 *
 * Requirements:
 * 1. Internal popouts (/config.html, /md.html):
 *    - In fullscreen mode, spawning an external OS window triggers jarring macOS
 *      Space-switching animations away from the fullscreen space.
 *    - In fullscreen mode, setWindowOpenHandler must deny the popout ({ action: 'deny' })
 *      so that tryNative() returns false and the view seamlessly renders its
 *      built-in in-page modal dialog in-place.
 *    - In normal windowed mode, internal popouts are allowed ({ action: 'allow' }).
 *
 * 2. Rail and TBAR context menus (openRailMenu):
 *    - In fullscreen mode, child windows without auxiliary collection behavior are
 *      hidden by macOS AppKit or trigger Mission Control space transitions and
 *      rapid focus-blur-destroy bounce loops.
 *    - The menu BrowserWindow must be created with fullscreenable: false,
 *      setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }),
 *      and setAlwaysOnTop(true, 'pop-up-menu').
 *    - positionRailMenu must use display.bounds when in fullscreen (so it doesn't
 *      clamp against the auto-hidden menu bar area) and display.workArea when windowed.
 *    - menu.on('blur') must guard against spurious blur events during the initial
 *      show transition (<150ms).
 *    - win.on('focus') must not steal focus to the active view webContents while
 *      railMenuWindow is open.
 *    - Right-clicking the active profile or TBAR while the menu is already open
 *      must toggle it closed cleanly.
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
    openHandler:
      | ((details: { url: string; features: string }) => {
          action: 'allow' | 'deny';
          createWindow?: (options: any) => any;
        })
      | null = null;

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
    executeJavaScript(): Promise<unknown> {
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
    setWindowOpenHandler(
      handler: (details: { url: string; features: string }) => {
        action: 'allow' | 'deny';
        createWindow?: (options: any) => any;
      },
    ): void {
      this.openHandler = handler;
    }
  }

  class FakeBrowserWindow extends Events {
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = new FakeWebContents();
    readonly contentView = {
      children: new Set<unknown>(),
      addChildView: (view: unknown) => this.contentView.children.add(view),
      removeChildView: (view: unknown) =>
        this.contentView.children.delete(view),
    };
    destroyed = false;
    fullscreen = false;
    hidden = false;
    options: any;
    visibleOnAllWorkspaces = false;
    visibleOnAllWorkspacesOptions: any = null;
    alwaysOnTop = false;
    alwaysOnTopLevel: string | null = null;
    position = { x: 0, y: 0 };
    bounds = { x: 0, y: 0, width: 1200, height: 800 };
    size = [320, 380];

    constructor(options: any) {
      super();
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFullScreen(): boolean {
      return this.fullscreen;
    }
    setFullScreen(value: boolean): void {
      this.fullscreen = value;
    }
    setVisibleOnAllWorkspaces(visible: boolean, options?: any): void {
      this.visibleOnAllWorkspaces = visible;
      this.visibleOnAllWorkspacesOptions = options;
    }
    setAlwaysOnTop(flag: boolean, level?: string): void {
      this.alwaysOnTop = flag;
      this.alwaysOnTopLevel = level ?? null;
    }
    getBounds() {
      return this.bounds;
    }
    getContentBounds() {
      return this.bounds;
    }
    getSize(): [number, number] {
      return [this.size[0], this.size[1]];
    }
    setPosition(x: number, y: number): void {
      this.position = { x, y };
    }
    close(): void {
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
    }
    focus(): void {}
    setTitle(): void {}
    setProgressBar(): void {}
    isFocused(): boolean {
      return true;
    }
    isMinimized(): boolean {
      return false;
    }
    restore(): void {}
    isMaximized(): boolean {
      return false;
    }
    flashFrame(): void {}
    loadFile(file: string): Promise<void> {
      return this.webContents.loadFile(file);
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = [];
    readonly webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = false;
    constructor() {
      FakeWebContentsView.instances.push(this);
    }
    setBounds(b: any): void {
      this.bounds = b;
    }
    setVisible(v: boolean): void {
      this.visible = v;
    }
    destroy(): void {
      this.webContents.destroyed = true;
    }
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

  const fakeScreen = {
    getDisplayNearestPoint: (_point: { x: number; y: number }) => ({
      bounds: { x: 0, y: 0, width: 1680, height: 1050 },
      workArea: { x: 0, y: 31, width: 1680, height: 1019 },
    }),
  };

  return {
    FakeBrowserWindow,
    FakeWebContentsView,
    app,
    ipcEvents,
    ipcHandlers,
    fakeScreen,
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
  ipcMain: {
    on: (channel: string, listener: (...args: any[]) => void) =>
      fake.ipcEvents.set(channel, listener),
    handle: (channel: string, listener: (...args: any[]) => void) =>
      fake.ipcHandlers.set(channel, listener),
  },
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  screen: fake.fakeScreen,
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
  powerMonitor: { on: vi.fn(), emit: vi.fn() },
}));

import { DesktopHost } from '../src/desktop.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const primary = {
  primary: true,
  acquire: () => ({ lost: false, forwarded: false }),
  installListener: vi.fn(),
};

describe('fullscreen popups & context menu UX stability', () => {
  let temp = '';

  beforeEach(() => {
    fake.reset();
    temp = mkdtempSync(path.join(os.tmpdir(), 'phi-fullscreen-test-'));
    fake.setUserData(temp);
  });

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  it('denies internal window popouts when in fullscreen mode so the in-page modal is used', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();

    const ctrl = host.controller!;
    const profile = ctrl.add('http://127.0.0.1:7070/');
    host.profileViews!.addProfile(profile.id, profile.origin);
    ctrl.setActive(profile.id);

    const view = host.profileViews!.getView(profile.id)!;
    const openHandler = (view.webContents as any).openHandler;
    expect(openHandler).toBeDefined();

    // 1. Normal windowed mode: popout is allowed
    win.setFullScreen(false);
    const windowedResult = openHandler({
      url: 'http://127.0.0.1:7070/config.html?desktop-popout=1',
      features: 'width=860,height=1000',
    });
    expect(windowedResult.action).toBe('allow');

    // 2. Fullscreen mode: popout is denied to prevent OS Space switching
    win.setFullScreen(true);
    const fullscreenResult = openHandler({
      url: 'http://127.0.0.1:7070/config.html?desktop-popout=1',
      features: 'width=860,height=1000',
    });
    expect(fullscreenResult.action).toBe('deny');

    // 3. md.html popout is also denied in fullscreen mode
    const mdResult = openHandler({
      url: 'http://127.0.0.1:7070/md.html?page=help',
      features: 'width=860,height=1000',
    });
    expect(mdResult.action).toBe('deny');
  });

  it('configures rail context menu as fullscreen auxiliary with always-on-top pop-up-menu', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();

    const ctrl = host.controller!;
    const profile = ctrl.add('http://127.0.0.1:7070/');
    ctrl.setActive(profile.id);

    win.setFullScreen(true);

    const openHandler = fake.ipcEvents.get('phi:open-rail-menu')!;
    const event = { sender: win.webContents };
    openHandler(event, profile.id, 200, 20);

    const menuWin = fake.FakeBrowserWindow.instances.find(
      (w) => w.options?.title === 'Phi server menu',
    );
    expect(menuWin).toBeDefined();
    expect(menuWin!.options.fullscreenable).toBe(false);
    expect(menuWin!.visibleOnAllWorkspaces).toBe(true);
    expect(menuWin!.visibleOnAllWorkspacesOptions).toEqual({
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    expect(menuWin!.alwaysOnTop).toBe(true);
    expect(menuWin!.alwaysOnTopLevel).toBe('pop-up-menu');
  });

  it('positions rail context menu using display.bounds when in fullscreen mode', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();

    const ctrl = host.controller!;
    const profile = ctrl.add('http://127.0.0.1:7070/');
    ctrl.setActive(profile.id);

    // Fullscreen: bounds has y: 0, workArea has y: 31 (menubar).
    // In fullscreen, positionRailMenu should clamp against bounds (y: 0 + 8 = 8).
    win.setFullScreen(true);

    const openHandler = fake.ipcEvents.get('phi:open-rail-menu')!;
    const event = { sender: win.webContents };
    // Click at screenX: 200, screenY: 10 (top of TBAR)
    openHandler(event, profile.id, 200, 10);
    await flush();

    const menuWin = fake.FakeBrowserWindow.instances.find(
      (w) => w.options?.title === 'Phi server menu',
    );
    expect(menuWin).toBeDefined();
    // In fullscreen, top is screenY + 4 = 14 (clamped to bounds.y + 8 = 8, NOT workArea.y + 8 = 39)
    expect(menuWin!.position.y).toBe(14);
  });

  it('toggles rail menu closed when re-triggered for the same profile', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();

    const ctrl = host.controller!;
    const profile = ctrl.add('http://127.0.0.1:7070/');
    ctrl.setActive(profile.id);

    const openHandler = fake.ipcEvents.get('phi:open-rail-menu')!;
    const event = { sender: win.webContents };

    // 1. Open the menu
    openHandler(event, profile.id, 200, 20);
    const menu1 = fake.FakeBrowserWindow.instances.find(
      (w) => w.options?.title === 'Phi server menu' && !w.isDestroyed(),
    );
    expect(menu1).toBeDefined();

    // 2. Trigger again for the same profile: toggles closed cleanly
    openHandler(event, profile.id, 200, 20);
    expect(menu1!.isDestroyed()).toBe(true);
    const menu2 = fake.FakeBrowserWindow.instances.find(
      (w) => w.options?.title === 'Phi server menu' && !w.isDestroyed(),
    );
    expect(menu2).toBeUndefined();
  });

  it('does not steal focus to body view when mainWindow is focused while railMenuWindow is open', async () => {
    const host = new DesktopHost();
    await host.start(primary);
    const win = fake.FakeBrowserWindow.instances[0];
    win.webContents.emit('did-finish-load');
    await flush();

    const ctrl = host.controller!;
    const profile = ctrl.add('http://127.0.0.1:7070/');
    host.profileViews!.addProfile(profile.id, profile.origin);
    ctrl.setActive(profile.id);

    const view = host.profileViews!.getView(profile.id)!;
    const viewFocusSpy = vi.spyOn(view.webContents, 'focus');

    // Open rail menu
    const openHandler = fake.ipcEvents.get('phi:open-rail-menu')!;
    const event = { sender: win.webContents };
    openHandler(event, profile.id, 200, 20);

    viewFocusSpy.mockClear();

    // MainWindow receives focus event while railMenuWindow is open
    win.emit('focus');

    // Should NOT steal focus to view.webContents
    expect(viewFocusSpy).not.toHaveBeenCalled();
  });
});
