// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const generatedIndex = path.join(webDir, 'index.html');
const hasGenerated = existsSync(generatedIndex);

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

beforeEach(() => {
  recordedActiveServer = null;
  fakeBridge = {
    fetchServerConfig: vi.fn(async () => null),
    fetchActiveWorkspace: vi.fn(async () => null),
    submitAccessPassword: vi.fn(async () => ({ ok: true })),
    postWindowMinimize: vi.fn(),
    postWindowToggleMaximize: vi.fn(),
    postWindowClose: vi.fn(),
    postHeaderAction: vi.fn(),
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
    onHeaderState: () => undefined,
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
    fakeBridge.fetchActiveWorkspace = vi.fn(() => new Promise(() => {}));

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
    let resolveJupiterWorkspace: ((ws: string) => void) | null = null;
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
      return new Promise<string>((resolve) => {
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
    resolveJupiterWorkspace?.('/jupiter');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(hostnameEl.innerText).toBe('JUPITER');
  });
});
