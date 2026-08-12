// @vitest-environment jsdom
/**
 * Auth modal flow tests (vitest + jsdom). The desktop's main view page
 * hosts an in-flow `<div id="desktop-auth-modal" hidden>` for the
 * password prompt that the server requires on protected profiles. This
 * file pins the renderer's behavior end-to-end against a recording-fake
 * preload bridge — no Electron, no Playwright, no user-driven launch:
 *
 *   - The page is parsed with jsdom (the generated `web/index.html`).
 *   - `window.electron` is replaced with a recording-fake bridge whose
 *     `onAuthRequired` / `onBodyObscuring` / `onActiveServer` are
 *     capture-and-forward hooks the tests invoke directly.
 *   - `mainview.js` is imported (its IIFE registers the listeners).
 *   - Each test simulates a server-push for `phi:auth-required` and
 *     asserts the modal's DOM state, the IPC submit/cancel contract,
 *     and the body-obscuring dim toggle.
 *
 * No real server is hit; the test stays deterministic and runs offline.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const generatedIndex = path.join(webDir, 'index.html');
const hasGenerated = existsSync(generatedIndex);

/** Recording-fake preload bridge. The tests wire `onAuthRequired`,
 *  `onBodyObscuring`, and `onActiveServer` to capture-and-forward
 *  hooks, then drive the recorded callbacks directly. */
interface FakeBridge {
  /** Plain function so tests can replace it per case. */
  fetchServerConfig: () => Promise<unknown>;
  submitAccessPassword: (requestId: string, password: string | null) => Promise<unknown>;
  postWindowMinimize: () => void;
  postWindowToggleMaximize: () => void;
  postWindowClose: () => void;
  postHeaderAction: (action: { kind: string; id?: string; value?: string }) => void;
  onAuthRequired: (cb: (info: { requestId: string; profileId: string; origin: string; label?: string }) => void) => void;
  onBodyObscuring: (cb: (obscured: boolean) => void) => void;
  onActiveServer: (cb: (info: { id: string; origin: string; accent: string }) => void) => void;
  onHeaderState: (cb: (state: { cpuPercent: number | null; terminalActivity: boolean }) => void) => void;
  onWindowState: (cb: (state: { isMaximized: boolean; focused: boolean }) => void) => void;
  onWindowTitle: (cb: (title: string) => void) => void;
}

let recordedAuthRequired: ((info: { requestId: string; profileId: string; origin: string; label?: string }) => void) | null = null;
let recordedBodyObscuring: ((obscured: boolean) => void) | null = null;
let recordedActiveServer: ((info: { id: string; origin: string; accent: string }) => void) | null = null;
let recordedHeaderState: ((state: { cpuPercent: number | null; terminalActivity: boolean }) => void) | null = null;
let submitCalls: Array<{ requestId: string; password: string | null }> = [];

let fakeBridge: FakeBridge;

beforeEach(() => {
  recordedAuthRequired = null;
  recordedBodyObscuring = null;
  recordedActiveServer = null;
  recordedHeaderState = null;
  submitCalls = [];
  fakeBridge = {
    fetchServerConfig: vi.fn(async () => null),
    submitAccessPassword: vi.fn(async (requestId: string, password: string | null) => {
      submitCalls.push({ requestId, password });
      return { ok: true };
    }),
    postWindowMinimize: () => undefined,
    postWindowToggleMaximize: () => undefined,
    postWindowClose: () => undefined,
    postHeaderAction: () => undefined,
    onAuthRequired: (cb) => {
      recordedAuthRequired = cb;
    },
    onBodyObscuring: (cb) => {
      recordedBodyObscuring = cb;
    },
    onActiveServer: (cb) => {
      recordedActiveServer = cb;
    },
    onHeaderState: (cb) => {
      recordedHeaderState = cb;
    },
    onWindowState: () => undefined,
    onWindowTitle: () => undefined,
  };
});

afterEach(() => {
  // Restore the global document for the next test.
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Loads the desktop main view page into JSDOM, installs the fake bridge,
 *  imports mainview.js (which executes its IIFE under the new DOM), and
 *  returns the parsed document. */
async function loadMainView(): Promise<Document> {
  if (!hasGenerated) {
    throw new Error('web/index.html missing — run `pnpm run build` first');
  }
  const html = readFileSync(generatedIndex, 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///C:/code/github/phi/desktop/electron/web/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // The vendored modules and mainview.js read DOM globals from the
  // jsdom window. Repoint the host's globals at it.
  (globalThis as unknown as { window: typeof window }).window = window as unknown as Window & typeof globalThis;
  (window as unknown as { electron: FakeBridge }).electron = fakeBridge;
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
    configurable: true,
    writable: true,
  });
  // Re-import mainview.js with the fresh globals.
  await import(pathToFileURL(path.join(webDir, 'mainview.js')).href);
  return window.document;
}

describe('desktop auth modal (mainview.js)', () => {
  it('renders the modal markup in the vendored main view', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    const modal = doc.getElementById('desktop-auth-modal') as HTMLDivElement | null;
    expect(modal).not.toBeNull();
    expect(modal?.classList.contains('desktop-auth-modal')).toBe(true);
    // The modal starts hidden, with empty error, empty input.
    expect(modal?.hasAttribute('hidden')).toBe(true);
    const origin = doc.getElementById('desktop-auth-origin');
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement | null;
    const submit = doc.getElementById('desktop-auth-submit');
    const cancel = doc.getElementById('desktop-auth-cancel');
    expect(origin).not.toBeNull();
    expect(input?.tagName.toLowerCase()).toBe('input');
    expect(input?.type).toBe('password');
    expect(submit).not.toBeNull();
    expect(cancel).not.toBeNull();
  });

  it('opens the modal when the main process pushes phi:auth-required', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    expect(recordedAuthRequired).not.toBeNull();
    // The main process pushes body obscuring and the auth-required prompt
    // together; tests must drive both to simulate the real flow.
    recordedBodyObscuring!(true);
    recordedAuthRequired!({
      requestId: 'r-1',
      profileId: '127-0-0-1-7070',
      origin: 'http://127.0.0.1:7070/',
      label: '127.0.0.1:7070',
    });
    const modal = doc.getElementById('desktop-auth-modal') as HTMLDivElement | null;
    expect(modal?.hasAttribute('hidden')).toBe(false);
    const origin = doc.getElementById('desktop-auth-origin');
    expect(origin?.textContent).toBe('127.0.0.1:7070');
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement | null;
    expect(input?.value).toBe('');
    // Body obscuring should have been toggled on.
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(true);
  });

  it('falls back to origin when label is missing in the push', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-2',
      profileId: 'p2',
      origin: 'http://charon:7070/',
    });
    const origin = doc.getElementById('desktop-auth-origin');
    expect(origin?.textContent).toBe('http://charon:7070/');
  });

  it('re-push for the same requestId re-opens (refreshes) the modal', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-3',
      profileId: 'p3',
      origin: 'http://a/',
      label: 'A',
    });
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('A');
    // Same id, different label → modal updates.
    recordedAuthRequired!({
      requestId: 'r-3',
      profileId: 'p3',
      origin: 'http://a/',
      label: 'A (renamed)',
    });
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('A (renamed)');
  });

  it('a push for a different requestId while a prompt is open is ignored', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-open',
      profileId: 'p4',
      origin: 'http://a/',
      label: 'A',
    });
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('A');
    // Different requestId → ignored. The modal still shows A.
    recordedAuthRequired!({
      requestId: 'r-other',
      profileId: 'p5',
      origin: 'http://b/',
      label: 'B',
    });
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('A');
  });

  it('submit posts submitAccessPassword(requestId, password) and closes the modal on ok', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-submit',
      profileId: 'p-sub',
      origin: 'http://a/',
      label: 'A',
    });
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement;
    input.value = 'hunter22-secret';
    const submit = doc.getElementById('desktop-auth-submit') as HTMLButtonElement;
    submit.click();
    // submitAccessPassword is awaited, so we wait one microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCalls).toEqual([{ requestId: 'r-submit', password: 'hunter22-secret' }]);
    const modal = doc.getElementById('desktop-auth-modal');
    expect(modal?.hasAttribute('hidden')).toBe(true);
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(false);
  });

  it('submit with a too-short password shows an inline error and does not call IPC', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-short',
      profileId: 'p-short',
      origin: 'http://a/',
      label: 'A',
    });
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement;
    input.value = 'short'; // < 8 chars
    const submit = doc.getElementById('desktop-auth-submit') as HTMLButtonElement;
    submit.click();
    await Promise.resolve();
    expect(submitCalls).toEqual([]);
    const err = doc.getElementById('desktop-auth-error');
    expect(err?.textContent).toContain('8');
    // Modal is still visible.
    const modal = doc.getElementById('desktop-auth-modal');
    expect(modal?.hasAttribute('hidden')).toBe(false);
  });

  it('submit on a failed unlock keeps the modal open and surfaces the server error', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    // Override the bridge to return a failure for this test.
    fakeBridge.submitAccessPassword = vi.fn(async () => ({ ok: false, code: 'invalid-password' }));
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-fail',
      profileId: 'p-fail',
      origin: 'http://a/',
      label: 'A',
    });
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement;
    input.value = 'wrong-password-1';
    const submit = doc.getElementById('desktop-auth-submit') as HTMLButtonElement;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeBridge.submitAccessPassword).toHaveBeenCalledOnce();
    const err = doc.getElementById('desktop-auth-error');
    expect(err?.textContent).toMatch(/not accepted|invalid/i);
    const modal = doc.getElementById('desktop-auth-modal');
    expect(modal?.hasAttribute('hidden')).toBe(false);
    expect(input.value).toBe('');
  });

  it('cancel posts submitAccessPassword(requestId, null) and closes the modal', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-cancel',
      profileId: 'p-cancel',
      origin: 'http://a/',
      label: 'A',
    });
    const cancel = doc.getElementById('desktop-auth-cancel') as HTMLButtonElement;
    cancel.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCalls).toEqual([{ requestId: 'r-cancel', password: null }]);
    const modal = doc.getElementById('desktop-auth-modal');
    expect(modal?.hasAttribute('hidden')).toBe(true);
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(false);
  });

  it('Escape on the password input dismisses', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-esc',
      profileId: 'p-esc',
      origin: 'http://a/',
      label: 'A',
    });
    const input = doc.getElementById('desktop-auth-input') as HTMLInputElement;
    const ev = new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    });
    input.dispatchEvent(ev);
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCalls).toEqual([{ requestId: 'r-esc', password: null }]);
  });

  it('onActiveServer closes an open modal only when the active id differs from the modal’s profileId', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-active',
      profileId: 'p-active',
      origin: 'http://a/',
      label: 'A',
    });
    expect(doc.getElementById('desktop-auth-modal')?.hasAttribute('hidden')).toBe(false);
    // Active server switches to a DIFFERENT profile → modal closes.
    recordedActiveServer!({ id: 'p-other', origin: 'http://other/', accent: '' });
    expect(doc.getElementById('desktop-auth-modal')?.hasAttribute('hidden')).toBe(true);
    // Now a push for a NEW requestId must be accepted (the renderer
    // must have cleared its requestId, not just hidden the modal).
    recordedAuthRequired!({
      requestId: 'r-next',
      profileId: 'p-next',
      origin: 'http://b/',
      label: 'B',
    });
    expect(doc.getElementById('desktop-auth-modal')?.hasAttribute('hidden')).toBe(false);
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('B');
  });

  it('onActiveServer with the SAME profileId as the open modal leaves it open (initial-MRU regression)', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    recordedAuthRequired!({
      requestId: 'r-mru',
      profileId: 'p-mru',
      origin: 'http://a/',
      label: 'A',
    });
    expect(doc.getElementById('desktop-auth-modal')?.hasAttribute('hidden')).toBe(false);
    // The controller fires active-changed for the persisted MRU on
    // launch. If the active id matches the modal's profileId, the
    // modal must stay open — otherwise the 401-triggered prompt would
    // open then immediately close.
    recordedActiveServer!({ id: 'p-mru', origin: 'http://a/', accent: '' });
    expect(doc.getElementById('desktop-auth-modal')?.hasAttribute('hidden')).toBe(false);
    expect(doc.getElementById('desktop-auth-origin')?.textContent).toBe('A');
  });

  it('onBodyObscuring toggles the dim class on body', async (ctx) => {
    if (!hasGenerated) {
      ctx.skip('web/index.html missing — run `pnpm run build` first');
      return;
    }
    const doc = await loadMainView();
    expect(recordedBodyObscuring).not.toBeNull();
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(false);
    recordedBodyObscuring!(true);
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(true);
    recordedBodyObscuring!(false);
    expect(doc.body.classList.contains('desktop-body-obscured')).toBe(false);
  });
});
