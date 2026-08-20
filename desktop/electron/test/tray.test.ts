/**
 * Unit tests for the system tray (src/tray.ts) — the Electron main-process
 * tray surface, public Electron `Tray`/`Menu`/`nativeImage` API only (no
 * native Win32 calls, no NSStatusItem/StatusNotifierItem code paths).
 *
 * Test isolation (documented convention, same as the other electron
 * slices): NO real Electron runtime is touched. The 'electron' module is
 * stubbed with recording fakes (Tray, Menu, nativeImage, app); the tray
 * under test is built through setupTrayForTest, which injects the fakes
 * through the stubbed module — a real Tray/Menu/nativeImage/app is never
 * constructed, and no real app is ever touched. The missing-icon path is
 * exercised through a fake nativeImage that reports an empty image, so no
 * file on disk is ever read (the asset exists at
 * desktop/electron/assets/tray.png for production; tests never open it).
 *
 * setupTray itself never calls into Electron at module load — only inside
 * setupTray — so importing this test file's target is inert outside a real
 * Electron runtime (the same convention as src/single-instance.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Menu } from 'electron';

// Recording fakes, hoisted so vi.mock('electron') can bind them before the
// module under test is imported.
const { fakeApp, fakeMenu, fakeNativeImage, FakeTray } = vi.hoisted(() => {
  class FakeTray {
    static instances: FakeTray[] = [];
    toolTip = '';
    listeners = new Map<string, () => void>();
    popups: unknown[] = [];
    destroyed = false;
    constructor() {
      FakeTray.instances.push(this);
    }
    setToolTip(t: string): void {
      this.toolTip = t;
    }
    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener);
    }
    popUpContextMenu(menu?: unknown): void {
      this.popups.push(menu);
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return {
    fakeApp: { quit: vi.fn() },
    fakeMenu: {
      buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
    },
    fakeNativeImage: {
      createFromPath: vi.fn(() => ({
        isEmpty: () => true,
        resize: vi.fn((_opts?: unknown) => ({})),
        setTemplateImage: vi.fn(),
      })),
    },
    FakeTray,
  };
});

vi.mock('electron', () => ({
  app: fakeApp,
  Menu: fakeMenu,
  nativeImage: fakeNativeImage,
  Tray: FakeTray,
}));

import {
  TRAY_COMMAND_CHANNEL,
  TRAY_ICON_PATH,
  buildTooltip,
  buildTrayMenu,
  formatCanonicalHostname,
  formatProfileLabel,
  setupTray,
  wireTrayEvents,
  type TrayDeps,
  type TrayHandle,
  type TrayLike,
  type TrayMenuEntry,
  type TrayMenuHandlers,
  type TrayProfile,
} from '../src/tray.js';

type FakeTrayInstance = InstanceType<typeof FakeTray>;

const home: TrayProfile = {
  id: 'home',
  name: 'Home Phi',
  origin: 'http://127.0.0.1:7070/',
};
const work: TrayProfile = {
  id: 'work',
  name: 'Work Phi',
  origin: 'http://10.0.0.5:7070/',
};

/** The menu template Menu.buildFromTemplate was last called with. */
function lastTemplate(): TrayMenuEntry[] {
  const call = fakeMenu.buildFromTemplate.mock.calls.at(-1);
  if (!call) throw new Error('Menu.buildFromTemplate was never called');
  return call[0] as TrayMenuEntry[];
}

/** Click helper: invokes a leaf entry's click (throws for the submenu parent). */
function clickEntry(entry: TrayMenuEntry | undefined): void {
  if (!entry) throw new Error('menu entry missing');
  if (!entry.click)
    throw new Error(`menu entry has no click handler: ${entry.label}`);
  entry.click();
}

/** Builds the tray under test with recording fakes and returns every seam. */
function setupTrayForTest(
  opts: { profiles?: TrayProfile[]; deps?: Partial<TrayDeps> } = {},
): {
  handle: TrayHandle;
  tray: FakeTrayInstance;
  ipcSend: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  FakeTray.instances.length = 0;
  fakeMenu.buildFromTemplate.mockClear();
  fakeNativeImage.createFromPath.mockClear();
  fakeApp.quit.mockClear();
  const ipcSend = vi.fn();
  const log = vi.fn();
  const profiles = opts.profiles ?? [];
  const deps: TrayDeps = {
    getProfiles: () => profiles,
    getActiveProfileId: () => '',
    getUnread: () => 0,
    getCloseToTray: () => true,
    getSyncAlerts: () => false,
    getPetAvailable: () => false,
    getPetEnabled: () => false,
    ipcSend,
    log,
    ...opts.deps,
  };
  const handle = setupTray(deps);
  const tray = FakeTray.instances.at(-1);
  if (!tray) throw new Error('setupTray must construct a Tray');
  return { handle, tray, ipcSend, log };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildTrayMenu (pure menu builder)', () => {
  const mkHandlers = (
    over: Partial<TrayMenuHandlers> = {},
  ): TrayMenuHandlers => ({
    show: () => {},
    selectProfile: () => {},
    toggleCloseToTray: () => {},
    toggleSyncAlerts: () => {},
    togglePet: () => {},
    quit: () => {},
    ...over,
  });

  it('renders Show Phi, Profiles, the Close to tray, Sync board alerts and Show pet checkboxes and Quit in order with one submenu entry per profile', () => {
    const alpha: TrayProfile = {
      id: 'alpha',
      name: 'alpha',
      origin: 'http://127.0.0.1:7070/',
      health: 'down',
      unread: 2,
    };
    const menu = buildTrayMenu(
      [home, work, alpha],
      mkHandlers(),
      true,
      false,
      true,
      false,
    );
    expect(menu.map((e) => e.label)).toEqual([
      'Show Phi',
      'Profiles',
      'Close to tray',
      'Sync board alerts',
      'Show pet',
      'Quit',
    ]);
    const profiles = menu[1].submenu;
    // Labels go through formatProfileLabel: name + health status + (N) unread suffix.
    expect(profiles?.map((e) => e.label)).toEqual([
      'Home Phi',
      'Work Phi',
      'alpha — down (2)',
    ]);
  });

  it('always includes Show Phi, the checkboxes and Quit and omits Profiles when no profiles exist', () => {
    const menu = buildTrayMenu([], mkHandlers(), true, false, true, false);
    expect(menu.map((e) => e.label)).toEqual([
      'Show Phi',
      'Close to tray',
      'Sync board alerts',
      'Show pet',
      'Quit',
    ]);
    expect(menu.some((e) => e.label === 'Profiles')).toBe(false);
  });

  it('renders the Close to tray entry as a checkbox carrying the preference state', () => {
    const on = buildTrayMenu([], mkHandlers(), true, false, true, false);
    const off = buildTrayMenu([], mkHandlers(), false, false, true, false);
    const entryOn = on.find((e) => e.label === 'Close to tray');
    const entryOff = off.find((e) => e.label === 'Close to tray');
    expect(entryOn?.type).toBe('checkbox');
    expect(entryOn?.checked).toBe(true);
    expect(entryOff?.type).toBe('checkbox');
    expect(entryOff?.checked).toBe(false);
  });

  it('calls the show handler from Show Phi and the quit handler from Quit', () => {
    const show = vi.fn();
    const quit = vi.fn();
    const menu = buildTrayMenu(
      [home],
      mkHandlers({ show, quit }),
      true,
      false,
      true,
      false,
    );
    clickEntry(menu.find((e) => e.label === 'Show Phi'));
    clickEntry(menu.find((e) => e.label === 'Quit'));
    expect(show).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('calls the toggle handler from the Close to tray checkbox', () => {
    const toggleCloseToTray = vi.fn();
    const menu = buildTrayMenu(
      [home],
      mkHandlers({ toggleCloseToTray }),
      true,
      false,
      true,
      false,
    );
    clickEntry(menu.find((e) => e.label === 'Close to tray'));
    expect(toggleCloseToTray).toHaveBeenCalledTimes(1);
  });

  it('renders the Sync board alerts entry as a checkbox carrying the preference state', () => {
    const on = buildTrayMenu([], mkHandlers(), true, true, true, false);
    const off = buildTrayMenu([], mkHandlers(), true, false, true, false);
    const entryOn = on.find((e) => e.label === 'Sync board alerts');
    const entryOff = off.find((e) => e.label === 'Sync board alerts');
    expect(entryOn?.type).toBe('checkbox');
    expect(entryOn?.checked).toBe(true);
    expect(entryOff?.type).toBe('checkbox');
    expect(entryOff?.checked).toBe(false);
  });

  it('calls the toggle handler from the Sync board alerts checkbox', () => {
    const toggleSyncAlerts = vi.fn();
    const menu = buildTrayMenu(
      [home],
      mkHandlers({ toggleSyncAlerts }),
      true,
      false,
      true,
      false,
    );
    clickEntry(menu.find((e) => e.label === 'Sync board alerts'));
    expect(toggleSyncAlerts).toHaveBeenCalledTimes(1);
  });

  it('renders the Show pet entry as a checkbox carrying petEnabled, enabled only when petAvailable', () => {
    const available = buildTrayMenu([], mkHandlers(), true, false, true, true);
    const unavailable = buildTrayMenu(
      [],
      mkHandlers(),
      true,
      false,
      false,
      true,
    );
    const entryOn = available.find((e) => e.label === 'Show pet');
    const entryOff = unavailable.find((e) => e.label === 'Show pet');
    expect(entryOn?.type).toBe('checkbox');
    expect(entryOn?.checked).toBe(true);
    expect(entryOn?.enabled).toBe(true);
    expect(entryOff?.enabled).toBe(false);
  });

  it('calls the togglePet handler from the Show pet checkbox', () => {
    const togglePet = vi.fn();
    const menu = buildTrayMenu(
      [home],
      mkHandlers({ togglePet }),
      true,
      false,
      true,
      false,
    );
    clickEntry(menu.find((e) => e.label === 'Show pet'));
    expect(togglePet).toHaveBeenCalledTimes(1);
  });

  it('posts the select-profile intent with the profile id from a submenu click', () => {
    const selectProfile = vi.fn();
    const menu = buildTrayMenu(
      [home, work],
      mkHandlers({ selectProfile }),
      true,
      false,
      true,
      false,
    );
    const profiles = menu.find((e) => e.label === 'Profiles')?.submenu ?? [];
    clickEntry(profiles.find((e) => e.label === 'Work Phi'));
    expect(selectProfile).toHaveBeenCalledWith('work');
  });
});

describe('setupTray (wiring, recording fakes)', () => {
  it('loads the tray icon from the assets path and logs once when it is missing', () => {
    const { tray, log } = setupTrayForTest();
    expect(fakeNativeImage.createFromPath).toHaveBeenCalledWith(TRAY_ICON_PATH);
    expect(log).toHaveBeenCalledWith(
      `phi-desktop: tray icon missing at ${TRAY_ICON_PATH}; continuing with the default empty icon`,
    );
    // The tray still exists (default empty icon), per the missing-icon convention.
    expect(tray.destroyed).toBe(false);
  });

  it('uses the production icon path override from deps', () => {
    setupTrayForTest({ deps: { iconPath: '/prod/assets/tray.png' } });
    expect(fakeNativeImage.createFromPath).toHaveBeenCalledWith(
      '/prod/assets/tray.png',
    );
  });

  it('falls back to the sibling PNG when the ICO decodes empty (non-Windows platforms)', () => {
    setupTrayForTest();
    const calls = (
      fakeNativeImage.createFromPath as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as string);
    expect(calls).toEqual([
      TRAY_ICON_PATH,
      TRAY_ICON_PATH.replace(/\.ico$/, '.png'),
    ]);
  });

  it('resizes the icon to 16x16 and marks as template image on macOS', () => {
    const fakeImage = {
      isEmpty: () => false,
      resize: vi.fn((_opts?: unknown) => fakeImage),
      setTemplateImage: vi.fn(),
    };
    (
      fakeNativeImage.createFromPath as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(fakeImage);
    setupTrayForTest();
    if (process.platform === 'darwin') {
      expect(fakeImage.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
      expect(fakeImage.setTemplateImage).toHaveBeenCalledWith(true);
    }
  });

  it('builds the context menu from the profile list (Show Phi / Profiles / Close to tray / Quit)', () => {
    setupTrayForTest({ profiles: [home, work] });
    const template = lastTemplate();
    expect(template.map((e) => e.label)).toEqual([
      'Show Phi',
      'Profiles',
      'Close to tray',
      'Sync board alerts',
      'Show pet',
      'Quit',
    ]);
    expect(template[1].submenu?.map((e) => e.label)).toEqual([
      'Home Phi',
      'Work Phi',
    ]);
  });

  it('sets the initial tooltip to Phi', () => {
    const { tray } = setupTrayForTest();
    expect(tray.toolTip).toBe('Phi');
  });

  it('registers the right-click menu and pops it at the cursor', () => {
    const { tray } = setupTrayForTest();
    expect(tray.listeners.has('right-click')).toBe(true);
    const menu = lastTemplate();
    tray.listeners.get('right-click')?.();
    expect(tray.popups).toEqual([{ template: menu }]);
  });

  it('posts the show intent on plain left-click (restores+focuses the window)', () => {
    const { tray, ipcSend } = setupTrayForTest();
    tray.listeners.get('click')?.();
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'show',
    });
  });

  it('rebuilds the menu from the current profile list without recreating the tray', () => {
    const profiles = [home];
    const { handle, tray, ipcSend } = setupTrayForTest({ profiles });
    const buildsBefore = fakeMenu.buildFromTemplate.mock.calls.length;
    // The profile list changes after setup (the step-6 rebuild hook).
    profiles.push(work);
    handle.rebuildMenu();
    // A fresh Menu.buildFromTemplate runs over the updated profile list.
    expect(fakeMenu.buildFromTemplate.mock.calls.length).toBe(buildsBefore + 1);
    const template = lastTemplate();
    expect(template.map((e) => e.label)).toEqual([
      'Show Phi',
      'Profiles',
      'Close to tray',
      'Sync board alerts',
      'Show pet',
      'Quit',
    ]);
    expect(template[1].submenu?.map((e) => e.label)).toEqual([
      'Home Phi',
      'Work Phi',
    ]);
    // No tray recreation: the original Tray instance is untouched.
    expect(FakeTray.instances).toHaveLength(1);
    expect(tray.destroyed).toBe(false);
    // The popup at click time uses the rebuilt menu (the getter is read
    // at popup time, not at wire time).
    tray.listeners.get('right-click')?.();
    expect(tray.popups).toEqual([{ template }]);
    // The rebuilt menu's actions still route through the retained handlers.
    const profilesEntry =
      template.find((e) => e.label === 'Profiles')?.submenu ?? [];
    clickEntry(profilesEntry.find((e) => e.label === 'Work Phi'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'select-profile',
      id: 'work',
    });
  });

  it('rebuildMenu drops the Profiles submenu when the profile list empties', () => {
    const profiles = [home];
    const { handle } = setupTrayForTest({ profiles });
    profiles.length = 0;
    handle.rebuildMenu();
    expect(lastTemplate().map((e) => e.label)).toEqual([
      'Show Phi',
      'Close to tray',
      'Sync board alerts',
      'Show pet',
      'Quit',
    ]);
  });

  it('renders the Close to tray checkbox from the deps getter and rebuilds with a fresh value', () => {
    let closeToTray = true;
    const { handle } = setupTrayForTest({
      deps: { getCloseToTray: () => closeToTray },
    });
    expect(
      lastTemplate().find((e) => e.label === 'Close to tray'),
    ).toMatchObject({
      type: 'checkbox',
      checked: true,
    });
    closeToTray = false;
    handle.rebuildMenu();
    expect(
      lastTemplate().find((e) => e.label === 'Close to tray')?.checked,
    ).toBe(false);
  });

  it('renders the Sync board alerts checkbox from the deps getter and rebuilds with a fresh value', () => {
    let syncAlerts = false;
    const { handle } = setupTrayForTest({
      deps: { getSyncAlerts: () => syncAlerts },
    });
    expect(
      lastTemplate().find((e) => e.label === 'Sync board alerts'),
    ).toMatchObject({
      type: 'checkbox',
      checked: false,
    });
    syncAlerts = true;
    handle.rebuildMenu();
    expect(
      lastTemplate().find((e) => e.label === 'Sync board alerts')?.checked,
    ).toBe(true);
  });

  it('posts the toggle-close-to-tray intent from the checkbox entry', () => {
    const { ipcSend } = setupTrayForTest();
    clickEntry(lastTemplate().find((e) => e.label === 'Close to tray'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'toggle-close-to-tray',
    });
  });

  it('posts the toggle-sync-alerts intent from the checkbox entry', () => {
    const { ipcSend } = setupTrayForTest();
    clickEntry(lastTemplate().find((e) => e.label === 'Sync board alerts'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'toggle-sync-alerts',
    });
  });

  it('emits the show intent from the Show Phi entry', () => {
    const { ipcSend } = setupTrayForTest();
    const template = lastTemplate();
    clickEntry(template.find((e) => e.label === 'Show Phi'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'show',
    });
  });

  it('emits the select-profile intent with the profile id from a submenu entry', () => {
    const { ipcSend } = setupTrayForTest({ profiles: [home, work] });
    const template = lastTemplate();
    const profiles =
      template.find((e) => e.label === 'Profiles')?.submenu ?? [];
    clickEntry(profiles.find((e) => e.label === 'Work Phi'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'select-profile',
      id: 'work',
    });
  });

  it('posts the quit intent and lets the host loop own app.quit() (step-5 receiver)', () => {
    const { ipcSend } = setupTrayForTest();
    clickEntry(lastTemplate().find((e) => e.label === 'Quit'));
    expect(ipcSend).toHaveBeenCalledWith(TRAY_COMMAND_CHANNEL, {
      kind: 'quit',
    });
    // Step 5: the host-loop receiver (main.ts) logs, notifies the main
    // window and calls app.quit(); the tray no longer quits directly, so
    // a real app.quit() never fires from the tray.
    expect(fakeApp.quit).not.toHaveBeenCalled();
  });

  it('updates the tooltip with the active profile name and canonical hostname', () => {
    const { handle, tray } = setupTrayForTest();
    handle.setActiveProfile(home);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1)');
  });

  it('appends the unread suffix only to the active profile tooltip', () => {
    const { handle, tray } = setupTrayForTest();
    handle.setActiveProfile(home);
    // A non-active bump must not change the visible tooltip.
    handle.setUnread('work', 2);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1)');
    // The active profile's bump gets the suffix.
    handle.setUnread('home', 2);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1) (2 unread)');
  });

  it('carries the stored unread suffix into the tooltip when a profile becomes active', () => {
    const { handle, tray } = setupTrayForTest();
    handle.setActiveProfile(home);
    handle.setUnread('home', 0);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1)');
    handle.setUnread('home', 5);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1) (5 unread)');
    handle.setActiveProfile(work);
    // The active switch replaces the tooltip (work has no stored unread).
    expect(tray.toolTip).toBe('Phi — Work Phi (10.0.0.5)');
  });

  it('clamps negative unread counts to zero', () => {
    const { handle, tray } = setupTrayForTest();
    handle.setActiveProfile(home);
    handle.setUnread('home', -3);
    expect(tray.toolTip).toBe('Phi — Home Phi (127.0.0.1)');
  });

  it('destroys the tray on close (before-quit teardown)', () => {
    const { handle, tray } = setupTrayForTest();
    expect(tray.destroyed).toBe(false);
    handle.close();
    expect(tray.destroyed).toBe(true);
  });
});

describe('wireTrayEvents (platform menu convention)', () => {
  function fakeTray(): TrayLike & {
    listeners: Map<string, () => void>;
    popups: unknown[];
  } {
    const listeners = new Map<string, () => void>();
    const popups: unknown[] = [];
    return {
      listeners,
      popups,
      on(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
      popUpContextMenu(menu?: unknown) {
        popups.push(menu);
      },
    };
  }

  it('shows the menu on right-click on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const tray = fakeTray();
      wireTrayEvents(tray, () => ({ m: 1 }) as unknown as Menu, platform);
      expect(tray.listeners.has('right-click')).toBe(true);
    }
  });

  it('shows the menu on left-click on macOS only (the platform convention)', () => {
    // The menu getter is read at popup time, so swapping the current menu
    // is picked up by the next click without re-wiring.
    let menu: Menu = { m: 1 } as unknown as Menu;
    const mac = fakeTray();
    wireTrayEvents(mac, () => menu, 'darwin');
    expect(mac.listeners.has('click')).toBe(true);
    mac.listeners.get('click')?.();
    expect(mac.popups).toEqual([{ m: 1 }]);
    menu = { m: 2 } as unknown as Menu;
    mac.listeners.get('click')?.();
    expect(mac.popups).toEqual([{ m: 1 }, { m: 2 }]);

    const win = fakeTray();
    wireTrayEvents(win, () => menu, 'win32');
    expect(win.listeners.has('click')).toBe(false);
    const linux = fakeTray();
    wireTrayEvents(linux, () => menu, 'linux');
    expect(linux.listeners.has('click')).toBe(false);
  });
});

describe('formatProfileLabel (profile label contract)', () => {
  it('renders name — up with no unread suffix when healthy and unread is 0', () => {
    expect(formatProfileLabel('Home', 'up', 0)).toBe('Home — up');
  });

  it('renders name — down with the unread suffix when down and unread is 3', () => {
    expect(formatProfileLabel('Home', 'down', 3)).toBe('Home — down (3)');
  });

  it('renders the bare name with no unread suffix when health is unknown', () => {
    expect(formatProfileLabel('Home', 'unknown', 0)).toBe('Home');
  });

  it('canonicalizes host[:port] names to the uppercase hostname, never the port', () => {
    expect(formatProfileLabel('127.0.0.1:7070', 'up', 0)).toBe(
      '127.0.0.1 — up',
    );
    expect(formatProfileLabel('charon.local:7070', 'up', 0)).toBe(
      'CHARON — up',
    );
    expect(formatProfileLabel('charon.local:7070', 'down', 3)).toBe(
      'CHARON — down (3)',
    );
  });

  it('passes explicit names through unchanged (no host[:port] shape)', () => {
    expect(formatProfileLabel('Server: Primary', 'up', 0)).toBe(
      'Server: Primary — up',
    );
    expect(formatProfileLabel('Home Phi', 'unknown', 0)).toBe('Home Phi');
  });
});

describe('buildTooltip / formatCanonicalHostname (tooltip contract)', () => {
  it('formats an origin URL as the canonical hostname and falls back for junk', () => {
    expect(formatCanonicalHostname('http://127.0.0.1:7070/')).toBe('127.0.0.1');
    expect(formatCanonicalHostname('https://example.com/x')).toBe(
      'EXAMPLE.COM',
    );
    expect(formatCanonicalHostname('http://charon.local:7070/')).toBe('CHARON');
    expect(formatCanonicalHostname('not a url')).toBe('not a url');
    expect(formatCanonicalHostname('')).toBe('');
  });

  it('builds the one-line tooltip with name, canonical hostname and unread suffix', () => {
    expect(buildTooltip({})).toBe('Phi');
    expect(
      buildTooltip({ name: 'Home Phi', origin: 'http://127.0.0.1:7070/' }),
    ).toBe('Phi — Home Phi (127.0.0.1)');
    expect(
      buildTooltip({
        name: 'Home Phi',
        origin: 'http://127.0.0.1:7070/',
        unread: 2,
      }),
    ).toBe('Phi — Home Phi (127.0.0.1) (2 unread)');
    // Name-less active profile: the canonical hostname stands in (the documented example).
    expect(buildTooltip({ origin: 'http://127.0.0.1:7070/', unread: 2 })).toBe(
      'Phi — 127.0.0.1 (2 unread)',
    );
    expect(
      buildTooltip({
        name: 'Work',
        origin: 'http://10.0.0.5:7070/',
        unread: 0,
      }),
    ).toBe('Phi — Work (10.0.0.5)');
  });

  it('exposes the documented tray command channel constant', () => {
    expect(TRAY_COMMAND_CHANNEL).toBe('phi:tray-command');
  });
});
