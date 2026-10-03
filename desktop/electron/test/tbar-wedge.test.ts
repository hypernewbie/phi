// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const generatedIndex = path.join(webDir, 'index.html');

interface FakeBridge {
  fetchServerConfig: (id?: string) => Promise<unknown>;
  fetchActiveWorkspace: () => Promise<string | null>;
  submitAccessPassword: (
    requestId: string,
    password: string | null,
  ) => Promise<unknown>;
  postWindowMinimize: () => void;
  postWindowToggleMaximize: () => void;
  postWindowClose: () => void;
  postHeaderAction: (action: {
    kind: string;
    id?: string;
    value?: string;
  }) => void;
  postOpenRailMenu?: (id: string, screenX: number, screenY: number) => void;
  onAuthRequired: (cb: (info: any) => void) => void;
  onAuthResolved?: (cb: (info: any) => void) => void;
  onBodyObscuring: (cb: (obscured: boolean) => void) => void;
  onActiveServer: (cb: (info: any) => void) => void;
  onHeaderState: (cb: (state: any) => void) => void;
  onWindowState: (cb: (state: any) => void) => void;
  onWindowTitle: (cb: (title: string) => void) => void;
}

let fakeBridge: FakeBridge;
let recordedActiveServer: ((info: any) => void) | null = null;
let recordedHeaderState: ((info: any) => void) | null = null;

beforeEach(() => {
  recordedActiveServer = null;
  recordedHeaderState = null;
  fakeBridge = {
    fetchServerConfig: vi.fn(async () => null),
    fetchActiveWorkspace: vi.fn(async () => null),
    submitAccessPassword: vi.fn(async () => ({ ok: true })),
    postWindowMinimize: vi.fn(),
    postWindowToggleMaximize: vi.fn(),
    postWindowClose: vi.fn(),
    postHeaderAction: vi.fn(),
    postOpenRailMenu: vi.fn(),
    onAuthRequired: () => undefined,
    onAuthResolved: () => undefined,
    onBodyObscuring: () => undefined,
    onActiveServer: (cb) => {
      const previous = recordedActiveServer;
      recordedActiveServer = (info) => {
        previous?.(info);
        cb(info);
      };
    },
    onHeaderState: (cb) => {
      recordedHeaderState = cb;
    },
    onWindowState: () => undefined,
    onWindowTitle: () => undefined,
  };
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadMainView(): Promise<Document> {
  const html = readFileSync(generatedIndex, 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///C:/code/github/phi/desktop/electron/web/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as unknown as { window: any }).window = window;
  (window as unknown as { electron: FakeBridge }).electron = fakeBridge;
  Object.defineProperty(globalThis, 'document', {
    value: window.document,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number,
    configurable: true,
    writable: true,
  });
  await import(pathToFileURL(path.join(webDir, 'mainview.js')).href);
  return window.document;
}

describe('TBAR wedge and race condition prevention', () => {
  it.each(['unreachable', 'locked', 'loading'])(
    'clears the previous computer’s project list when the incoming server is %s',
    async (condition) => {
      fakeBridge.fetchServerConfig = vi.fn(async () => ({
        hostname: 'CHARON',
        workspaces: ['/charon/code', '/charon/other'],
        active_cwd: '/charon/code',
      }));
      fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon/code');
      const doc = await loadMainView();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const select = doc.getElementById(
        'workspace-select',
      ) as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual([
        '/charon/code',
        '/charon/other',
      ]);
      fakeBridge.fetchServerConfig = vi.fn(() =>
        condition === 'loading'
          ? new Promise(() => {})
          : condition === 'unreachable'
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(null),
      );
      recordedActiveServer?.({
        id: 'jupiter',
        origin: 'http://jupiter:7070/',
        hostname: 'JUPITER',
      });
      expect([...select.options]).toHaveLength(0);
      expect(select.disabled).toBe(true);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect([...select.options]).toHaveLength(0);
    },
  );

  it('publishes the incoming list before its body workspace read finishes', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon/code'],
      active_cwd: '/charon/code',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon/code');
    const doc = await loadMainView();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'JUPITER',
      workspaces: ['/jupiter/a', '/jupiter/b'],
      active_cwd: '/jupiter/a',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(
      () => new Promise<string | null>(() => {}),
    );
    recordedActiveServer?.({ id: 'jupiter', origin: 'http://jupiter:7070/' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const select = doc.getElementById('workspace-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '/jupiter/a',
      '/jupiter/b',
    ]);
    expect(select.disabled).toBe(false);
  });

  it('ignores a queued workspace push belonging to the outgoing computer', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'JUPITER',
      workspaces: ['/jupiter/code'],
      active_cwd: '/jupiter/code',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/jupiter/code');
    const doc = await loadMainView();
    recordedActiveServer?.({ id: 'jupiter', origin: 'http://jupiter:7070/' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    recordedHeaderState?.({
      profileId: 'charon',
      cpuPercent: 90,
      terminalActivity: true,
      workspace: '/charon/secret-project',
    });
    const select = doc.getElementById('workspace-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['/jupiter/code']);
    expect(select.value).toBe('/jupiter/code');
    recordedHeaderState?.({
      profileId: 'jupiter',
      cpuPercent: 0,
      terminalActivity: false,
      workspace: '/jupiter/new-project',
    });
    expect(select.value).toBe('/jupiter/new-project');
  });

  it('does not resurrect an old visit’s config after A → B → A when the current fetch fails', async () => {
    const doc = await loadMainView();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    let oldResolve: (config: unknown) => void = () => {};
    fakeBridge.fetchServerConfig = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResolve = resolve;
          }),
      )
      .mockResolvedValue(null);
    recordedActiveServer?.({ id: 'a', origin: 'http://a/' });
    recordedActiveServer?.({ id: 'b', origin: 'http://b/' });
    recordedActiveServer?.({ id: 'a', origin: 'http://a/' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    oldResolve({
      hostname: 'OLD A',
      workspaces: ['/old/a'],
      active_cwd: '/old/a',
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect([
      ...(doc.getElementById('workspace-select') as HTMLSelectElement).options,
    ]).toHaveLength(0);
  });

  it('keeps a user’s incoming-server selection when a body read completes late', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'JUPITER',
      workspaces: ['/jupiter/a', '/jupiter/b'],
      active_cwd: '/jupiter/a',
    }));
    let resolveWorkspace: (value: string | null) => void = () => {};
    fakeBridge.fetchActiveWorkspace = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveWorkspace = resolve;
        }),
    );
    const doc = await loadMainView();
    recordedActiveServer?.({ id: 'jupiter', origin: 'http://jupiter:7070/' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const select = doc.getElementById('workspace-select') as HTMLSelectElement;
    select.value = '/jupiter/b';
    select.dispatchEvent(new doc.defaultView!.Event('change'));
    expect(fakeBridge.postHeaderAction).toHaveBeenCalledWith({
      kind: 'workspace',
      value: '/jupiter/b',
      profileId: 'jupiter',
    });
    resolveWorkspace('/jupiter/a');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(select.value).toBe('/jupiter/b');
  });

  it('TBAR updates to JUPITER even when fetchActiveWorkspace hangs on switching', async () => {
    // 1. Initial server is CHARON
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon/code'],
      active_cwd: '/charon/code',
      theme_color: 'amber',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon/code');

    const doc = await loadMainView();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const hostnameEl = doc.getElementById('hostname-display') as HTMLElement;
    expect(hostnameEl.innerText).toBe('CHARON');

    // 2. User switches to JUPITER, but fetchActiveWorkspace hangs (simulating navigating webContents)
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'JUPITER',
      workspaces: ['/jupiter/code'],
      active_cwd: '/jupiter/code',
      theme_color: 'cyan',
    }));
    // Hanging promise that never resolves!
    fakeBridge.fetchActiveWorkspace = vi.fn(
      () => new Promise<string | null>(() => {}),
    );

    recordedActiveServer?.({
      id: 'jupiter',
      origin: 'http://jupiter:7070/',
      accent: '',
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // Hostname and theme are updated immediately upon config arrival without waiting for fetchActiveWorkspace:
    expect(hostnameEl.innerText).toBe('JUPITER');
  });

  it('TBAR updates synchronously when onActiveServer includes hostname', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => new Promise(() => {})); // Never returns
    const doc = await loadMainView();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const hostnameEl = doc.getElementById('hostname-display') as HTMLElement;
    // Push active server with synchronous hostname
    recordedActiveServer?.({
      id: 'jupiter',
      origin: 'http://jupiter:7070/',
      hostname: 'JUPITER',
    });
    expect(hostnameEl.innerText).toBe('JUPITER');
  });

  it('rapid switching does not drop valid JUPITER config', async () => {
    // Start on CHARON
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon'],
      active_cwd: '/charon',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon');

    const doc = await loadMainView();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const hostnameEl = doc.getElementById('hostname-display') as HTMLElement;
    expect(hostnameEl.innerText).toBe('CHARON');

    // Rapid switches: Charon -> Jupiter -> Charon -> Jupiter
    let resolveJupiterWorkspace: ((ws: string | null) => void) | undefined;
    let callCount = 0;

    fakeBridge.fetchServerConfig = vi.fn(async () => {
      callCount++;
      return {
        hostname: 'JUPITER',
        workspaces: ['/jupiter'],
        active_cwd: '/jupiter',
      };
    });

    fakeBridge.fetchActiveWorkspace = vi.fn(() => {
      return new Promise<string | null>((resolve) => {
        resolveJupiterWorkspace = resolve;
      });
    });

    // 1. Switch to Jupiter (serial 1)
    recordedActiveServer?.({ id: 'jupiter', origin: 'http://jupiter:7070/' });
    await Promise.resolve();

    // 2. While Jupiter's fetchActiveWorkspace is pending, another trigger runs
    // which increments refreshSerial (serial 2)
    recordedActiveServer?.({ id: 'jupiter', origin: 'http://jupiter:7070/' });
    await Promise.resolve();

    // Now resolve the first workspace call:
    if (resolveJupiterWorkspace) {
      (resolveJupiterWorkspace as (ws: string | null) => void)('/jupiter');
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(hostnameEl.innerText).toBe('JUPITER');
  });

  it('TBAR updates theme immediately on onActiveServer with hex accent without flashing purple', async () => {
    // Initial server is CHARON with amber theme
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon'],
      active_cwd: '/charon',
      theme_color: 'amber',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon');

    const doc = await loadMainView();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(doc.documentElement.getAttribute('data-theme-color')).toBe('amber');
    expect(doc.documentElement.style.getPropertyValue('--accent')).toBe(
      '#fbbf24',
    );

    // Track every theme change to verify purple is never applied
    const seenAccents: string[] = [];
    const observer = new (
      doc.defaultView as unknown as {
        MutationObserver: typeof MutationObserver;
      }
    ).MutationObserver(() => {
      seenAccents.push(doc.documentElement.style.getPropertyValue('--accent'));
    });
    observer.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme-color'],
    });

    // Server push for Jupiter with cyan hex accent
    recordedActiveServer?.({
      id: 'jupiter',
      origin: 'http://jupiter:7070/',
      hostname: 'JUPITER',
      accent: '#06b6d4',
    });

    // Theme should be immediately cyan without wait
    expect(doc.documentElement.getAttribute('data-theme-color')).toBe('cyan');
    expect(doc.documentElement.style.getPropertyValue('--accent')).toBe(
      '#06b6d4',
    );
    expect(seenAccents).not.toContain('#7c6af7'); // Never purple!
  });

  it('TBAR does not reset to purple when onActiveServer has empty or unobserved accent', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon'],
      active_cwd: '/charon',
      theme_color: 'amber',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon');

    const doc = await loadMainView();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(doc.documentElement.getAttribute('data-theme-color')).toBe('amber');

    // Push server with unobserved / empty accent
    recordedActiveServer?.({
      id: 'jupiter',
      origin: 'http://jupiter:7070/',
      hostname: 'JUPITER',
      accent: '',
    });

    // Amber remains, never forced to purple fallback
    expect(doc.documentElement.getAttribute('data-theme-color')).toBe('amber');
    expect(doc.documentElement.style.getPropertyValue('--accent')).toBe(
      '#fbbf24',
    );
  });

  it('right clicking on TBAR opens the rail menu for the active server', async () => {
    fakeBridge.fetchServerConfig = vi.fn(async () => ({
      hostname: 'CHARON',
      workspaces: ['/charon'],
      active_cwd: '/charon',
      theme_color: 'amber',
    }));
    fakeBridge.fetchActiveWorkspace = vi.fn(async () => '/charon');

    const doc = await loadMainView();
    recordedActiveServer?.({
      id: 'charon',
      origin: 'http://charon:7070/',
      hostname: 'CHARON',
      accent: '#fbbf24',
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const header = doc.querySelector('.app-header') as HTMLElement;
    expect(header).not.toBeNull();

    const contextEvent = new (doc.defaultView as any).MouseEvent(
      'contextmenu',
      {
        bubbles: true,
        cancelable: true,
        screenX: 250,
        screenY: 30,
      },
    );
    header.dispatchEvent(contextEvent);

    expect(contextEvent.defaultPrevented).toBe(true);
    expect(fakeBridge.postOpenRailMenu).toHaveBeenCalledWith('charon', 250, 30);
  });
});
