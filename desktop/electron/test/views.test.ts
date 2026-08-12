// @vitest-environment node
/**
 * Pure unit tests for src/views.ts (ProfileViewManager) with a
 * recording-fake WebContentsView and BrowserWindow. The module's only
 * 'electron' imports are type-only (erased at runtime — dist/views.js has
 * zero Electron imports), and this test file imports only the same
 * type-only interfaces: every Electron surface the manager touches is
 * constructor-injected, so no real Electron object is ever constructed.
 *
 * Coverage (minimum 12 deterministic cases):
 *   - lazy creation (addProfile registers only; the view appears on the
 *     first setActive);
 *   - hide-on-switch, reuse-on-return (same instance, no re-loadURL);
 *   - show-after-did-finish-load (no white flash) and retain-on-switch;
 *   - removeProfile / destroyAll teardown;
 *   - resize applies fresh bounds to the active view only;
 *   - viewsCreated accounting, same-host acceptance, unknown-id no-op.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserWindow, WebContentsView } from 'electron';
import { ProfileViewManager } from '../src/views.js';

interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A recording fake WebContentsView (records every call the manager makes). */
interface RecordingView {
  view: WebContentsView;
  setBoundsCalls: ViewBounds[];
  setVisibleCalls: boolean[];
  loadURLCalls: string[];
  closeCalls: number;
  destroyCalls: number;
  focusCalls: number;
  loadHandlers: Array<() => void>;
  webContentsDestroyed: boolean;
}

function makeFakeView(): RecordingView {
  const setBoundsCalls: ViewBounds[] = [];
  const setVisibleCalls: boolean[] = [];
  const loadURLCalls: string[] = [];
  const loadHandlers: Array<() => void> = [];
  let webContentsDestroyed = false;
  const rec: RecordingView = {
    view: {
      setBounds: (b: ViewBounds) => setBoundsCalls.push({ ...b }),
      setVisible: (v: boolean) => setVisibleCalls.push(v),
      destroy: () => {
        rec.destroyCalls += 1;
      },
      webContents: {
        on: (event: string, cb: () => void) => {
          if (event === 'did-finish-load') loadHandlers.push(cb);
        },
        loadURL: (url: string) => {
          loadURLCalls.push(url);
          return Promise.resolve();
        },
        close: () => {
          rec.closeCalls += 1;
        },
        focus: () => {
          rec.focusCalls += 1;
        },
        isDestroyed: () => rec.webContentsDestroyed,
      },
    } as unknown as WebContentsView,
    setBoundsCalls,
    setVisibleCalls,
    loadURLCalls,
    closeCalls: 0,
    destroyCalls: 0,
    focusCalls: 0,
    loadHandlers,
    webContentsDestroyed: webContentsDestroyed,
  };
  rec.webContentsDestroyed = webContentsDestroyed;
  return rec;
}

/** A recording fake BrowserWindow (records contentView.add/removeChildView). */
interface RecordingWindow {
  win: BrowserWindow;
  added: unknown[];
  removed: unknown[];
}

function makeFakeWindow(): RecordingWindow {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  return {
    win: {
      contentView: {
        addChildView: (v: unknown) => {
          added.push(v);
        },
        removeChildView: (v: unknown) => {
          removed.push(v);
        },
      },
    } as unknown as BrowserWindow,
    added,
    removed,
  };
}

interface ManagerHarness {
  manager: ProfileViewManager;
  win: RecordingWindow;
  views: RecordingView[];
}

const DEFAULT_BOUNDS: ViewBounds = { x: 72, y: 0, width: 1128, height: 800 };

function makeManager(opts?: { bounds?: () => ViewBounds }): ManagerHarness {
  const win = makeFakeWindow();
  const views: RecordingView[] = [];
  const manager = new ProfileViewManager({
    win: win.win,
    makeView: () => {
      const rec = makeFakeView();
      views.push(rec);
      return rec.view;
    },
    defaultBounds: opts?.bounds ?? (() => ({ ...DEFAULT_BOUNDS })),
    railWidth: 72,
    log: () => {},
  });
  return { manager, win, views };
}

describe('ProfileViewManager (retained per-profile views)', () => {
  it('addProfile does NOT create a view (lazy creation on first activation)', () => {
    const { manager, win, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    expect(views).toHaveLength(0);
    expect(manager.viewsCreated()).toBe(0);
    expect(win.added).toHaveLength(0);
  });

  it('setActive(null) on an empty manager is a no-op', () => {
    const { manager, views } = makeManager();
    manager.setActive(null);
    expect(views).toHaveLength(0);
    expect(manager.getActive()).toBeNull();
    // '' behaves like null (hides the current view and clears active).
    manager.setActive('');
    expect(manager.getActive()).toBeNull();
  });

  it('setActive on a registered profile creates exactly one view, adds it to the window with the right bounds, and loadURLs the origin tagged desktop=1', () => {
    const { manager, win, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.setActive('p1');
    expect(views).toHaveLength(1);
    expect(win.added).toHaveLength(1);
    expect(win.added[0]).toBe(views[0].view);
    expect(views[0].setBoundsCalls).toEqual([DEFAULT_BOUNDS]);
    expect(views[0].loadURLCalls).toEqual(['http://127.0.0.1:7070/?desktop=1']);
    expect(manager.getActive()).toBe('p1');
    expect(manager.viewsCreated()).toBe(1);
    // Created hidden — shown only after did-finish-load (no white flash).
    expect(views[0].setVisibleCalls).toEqual([false]);
  });

  it('setActive to a different profile hides the previous view and creates the new one (loadURL only on first creation)', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p1');
    manager.setActive('p2');
    expect(views).toHaveLength(2);
    // p1: hidden at creation, then hidden again when switching away.
    expect(views[0].setVisibleCalls).toEqual([false, false]);
    // p2: created hidden (shown after its did-finish-load).
    expect(views[1].setVisibleCalls).toEqual([false]);
    expect(views[1].loadURLCalls).toEqual(['http://127.0.0.1:8080/?desktop=1']);
    expect(manager.getActive()).toBe('p2');
  });

  it('setActive back to the first profile reuses the same view (no new view, no new loadURL) and shows it again', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p1');
    manager.setActive('p2');
    manager.setActive('p1');
    expect(views).toHaveLength(2);
    // Still exactly one loadURL for p1 — the retained view is reused.
    expect(views[0].loadURLCalls).toEqual(['http://127.0.0.1:7070/?desktop=1']);
    // p1: hidden at creation, hidden on the switch away, re-shown.
    expect(views[0].setVisibleCalls).toEqual([false, false, true]);
    // Re-showing re-applies fresh bounds (re-read defaultBounds).
    expect(views[0].setBoundsCalls).toHaveLength(2);
    // The re-shown view is focused so keyboard/shortcuts route to it
    // (first activation stays unfocused until its did-finish-load).
    expect(views[0].focusCalls).toBe(1);
    expect(manager.getActive()).toBe('p1');
  });

  it('removeProfile destroys the retained view and removes it from the internal map', () => {
    const { manager, views, win } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.setActive('p1');
    manager.removeProfile('p1');
    expect(views[0].closeCalls).toBe(1);
    expect(views[0].destroyCalls).toBe(0);  // WebContentsView has no .destroy(); removeChildView suffices
    expect(win.removed).toEqual([views[0].view]);
    expect(manager.viewsCreated()).toBe(0);
    expect(manager.getActive()).toBeNull();
    // An unregistered profile is never re-created.
    manager.setActive('p1');
    expect(manager.viewsCreated()).toBe(0);
  });

  it('onWindowResize applies fresh bounds to the active view only (hidden views keep their last bounds)', () => {
    let bounds: ViewBounds = { ...DEFAULT_BOUNDS };
    const { manager, views } = makeManager({ bounds: () => bounds });
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p1');
    manager.setActive('p2');
    // The window shrinks; only the ACTIVE view (p2) re-bounds.
    bounds = { x: 72, y: 0, width: 1000, height: 700 };
    manager.onWindowResize();
    expect(views[1].setBoundsCalls.at(-1)).toEqual({ x: 72, y: 0, width: 1000, height: 700 });
    // p1 keeps the bounds it had when it was last active/created.
    expect(views[0].setBoundsCalls.at(-1)).toEqual(DEFAULT_BOUNDS);
    expect(manager.getActive()).toBe('p2');
  });

  it('did-finish-load shows the newly created view (setVisible(true)) and marks it ready', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.setActive('p1');
    expect(views[0].setVisibleCalls).toEqual([false]);
    expect(views[0].loadHandlers).toHaveLength(1);
    views[0].loadHandlers[0]();
    expect(views[0].setVisibleCalls).toEqual([false, true]);
    // The newly shown view is focused for keyboard/shortcuts.
    expect(views[0].focusCalls).toBe(1);
    // Re-activating the loaded profile stays a no-op for loadURL.
    manager.setActive('p1');
    expect(views[0].loadURLCalls).toHaveLength(1);
    expect(manager.getActive()).toBe('p1');
  });

  it('did-finish-load of a view switched away mid-load does NOT show it (shown on re-activation)', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p1');
    manager.setActive('p2'); // switch away while p1 is still loading
    views[0].loadHandlers[0]();
    // p1 stays hidden (it is no longer the active profile).
    expect(views[0].setVisibleCalls.at(-1)).toBe(false);
    // Re-activating p1 shows the retained (now loaded) view.
    manager.setActive('p1');
    expect(views[0].setVisibleCalls.at(-1)).toBe(true);
    expect(views[0].loadURLCalls).toHaveLength(1);
  });

  it('destroyAll closes + removes every view and clears the manager', async () => {
    const { manager, views, win } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p1');
    manager.setActive('p2');
    await manager.destroyAll();
    expect(views[0].closeCalls).toBe(1);
    expect(views[1].closeCalls).toBe(1);
    expect(win.removed).toEqual([views[0].view, views[1].view]);
    expect(manager.viewsCreated()).toBe(0);
    expect(manager.getActive()).toBeNull();
  });

  it('viewsCreated reflects the map size after each operation', () => {
    const { manager } = makeManager();
    expect(manager.viewsCreated()).toBe(0);
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    expect(manager.viewsCreated()).toBe(0); // registered only
    manager.setActive('p1');
    expect(manager.viewsCreated()).toBe(1);
    manager.addProfile('p2', 'http://127.0.0.1:8080/');
    manager.setActive('p2');
    expect(manager.viewsCreated()).toBe(2);
    manager.removeProfile('p1');
    expect(manager.viewsCreated()).toBe(1);
  });

  it('addProfile is a no-op for an already-registered id (the first origin wins)', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.addProfile('p1', 'http://other.example/');
    manager.setActive('p1');
    expect(views).toHaveLength(1);
    expect(views[0].loadURLCalls).toEqual(['http://127.0.0.1:7070/?desktop=1']);
  });

  it('getView returns the retained view for a profile id, or null when none exists yet', () => {
    const { manager, views } = makeManager();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    expect(manager.getView('p1')).toBeNull(); // registered-only: no view yet
    manager.setActive('p1');
    expect(manager.getView('p1')).toBe(views[0].view);
    expect(manager.getView('ghost')).toBeNull();
    manager.removeProfile('p1');
    expect(manager.getView('p1')).toBeNull();
  });

  it('does NOT block same-host profiles (browser origin rules isolate server origins)', () => {
    const { manager, views } = makeManager();
    manager.addProfile('host-7070', 'http://host.example:7070/');
    manager.addProfile('host-8080', 'http://host.example:8080/');
    manager.setActive('host-7070');
    manager.setActive('host-8080');
    expect(views).toHaveLength(2);
    expect(manager.viewsCreated()).toBe(2);
    expect(manager.getActive()).toBe('host-8080');
  });

  it('setActive with an unknown (unregistered) id is a no-op', () => {
    const { manager, views } = makeManager();
    manager.setActive('ghost');
    expect(views).toHaveLength(0);
    expect(manager.getActive()).toBeNull();
    manager.addProfile('p1', 'http://127.0.0.1:7070/');
    manager.setActive('p1');
    manager.setActive('ghost'); // must not disturb the active view
    expect(manager.getActive()).toBe('p1');
    expect(views).toHaveLength(1);
  });
});
