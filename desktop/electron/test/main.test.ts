// Entry-point/host-loop unit test. Reads src/main.ts (the thin boot
// surface: protocol flags, single-instance gate, deeplink relay) and
// src/desktop.ts (the DesktopHost host loop) and guards the documented
// window security defaults so a future change cannot silently drop
// sandboxing, context isolation, or the loadFile-only rule, and guards
// the single-instance wiring order (lock first, listener before the
// window, preload registered, IPC channels/payloads exact) plus the
// host-loop wiring (tray, controller receiver, hotkey, retained
// per-profile views, rail renderer, before-quit teardown, ...).
//
// Boot/flag/gate/deeplink assertions anchor on mainSource; every
// host-loop assertion anchors on desktopSource. Cross-file ordering
// invariants (gate before window, smoke before tray) are restated as
// intra-file invariants anchored within one source.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Importing the channel constants also typechecks the src modules; the
// 'electron' import inside single-instance.ts is inert outside Electron
// (the npm package exports a path string), so this is safe under vitest.
import { FORWARD_CHANNEL } from '../src/single-instance.js';
import { DEEPLINK_CHANNEL } from '../src/deeplink.js';
import {
  ALWAYS_SAFE_RAIL_CHORDS,
  CONDITIONAL_RAIL_CHORDS,
} from '../src/shortcuts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(
  path.join(here, '..', 'src', 'main.ts'),
  'utf8',
);
const desktopSource = readFileSync(
  path.join(here, '..', 'src', 'desktop.ts'),
  'utf8',
);
const preloadSource = readFileSync(
  path.join(here, '..', 'src', 'preload.ts'),
  'utf8',
);
const singleInstanceSource = readFileSync(
  path.join(here, '..', 'src', 'single-instance.ts'),
  'utf8',
);

describe('src/main.ts + src/desktop.ts (phase-1 Electron entry)', () => {
  it('creates a BrowserWindow from app.whenReady', () => {
    // The window is host-owned (DesktopHost.createMainWindow); main.ts only
    // hands control to host.start() from whenReady.
    expect(desktopSource).toContain('BrowserWindow');
    expect(mainSource).toContain('app.whenReady');
    expect(desktopSource).toContain('new BrowserWindow(');
  });

  it('keeps the documented security defaults (regression guard against dropping sandboxing)', () => {
    expect(desktopSource).toContain('nodeIntegration: false');
    expect(desktopSource).toContain('contextIsolation: true');
    expect(desktopSource).toContain('sandbox: true');
    expect(desktopSource).toContain('webSecurity: true');
  });

  it('loads the local main view page via loadFile and never via loadURL', () => {
    expect(desktopSource).toContain('loadFile');
    // A call-level guard: comments may explain the rule, but there must be
    // no loadURL call anywhere in the host loop.
    expect(desktopSource).not.toMatch(/\.loadURL\(/);
  });
});

describe('src/main.ts (phase-2 single-instance + argv routing)', () => {
  it('requests the single-instance lock as the first app call in the gate module', () => {
    // Inside setupSingleInstance the lock is requested before any other
    // app interaction (listener registration, quit).
    const lockIdx = singleInstanceSource.indexOf(
      'app.requestSingleInstanceLock()',
    );
    const onIdx = singleInstanceSource.indexOf("app.on('second-instance'");
    const quitIdx = singleInstanceSource.indexOf('app.quit');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(onIdx);
    expect(lockIdx).toBeLessThan(quitIdx);
  });

  it('runs the single-instance gate before app.whenReady and before the window opens', () => {
    // main.ts calls setupSingleInstance at module top (before whenReady),
    // and the second-instance listener is registered inside it — so the
    // listener exists before any BrowserWindow is ever created. The window
    // is host-owned: the gate closes over the host's lazy window()
    // accessor, and createMainWindow lives in DesktopHost.
    const gateIdx = mainSource.indexOf('setupSingleInstance(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(singleInstanceSource).toContain("app.on('second-instance'");
    expect(gateIdx).toBeLessThan(mainSource.indexOf('app.whenReady()'));
    expect(desktopSource.indexOf('new BrowserWindow(')).toBeGreaterThan(-1);
    expect(mainSource).toContain('host.window()');
    expect(mainSource).toContain('host.activateServerUrl(');
  });

  it('forwards on the documented channel with the exact payload shape and quits the loser', () => {
    expect(FORWARD_CHANNEL).toBe('phi:single-instance-forward');
    expect(singleInstanceSource).toContain("'phi:single-instance-forward'");
    // Payload schema: { kind: 'deep-link' | 'server', value: string }.
    expect(singleInstanceSource).toContain("kind: 'deep-link' | 'server'");
    // The listener posts via webContents.send and foregrounds via
    // restore()+focus(); the losing side quits.
    expect(singleInstanceSource).toContain('webContents.send');
    expect(singleInstanceSource).toContain('restore()');
    expect(singleInstanceSource).toContain('focus()');
    expect(singleInstanceSource).toContain('app.quit');
    // classifyArgv lives in the host loop (the primary's own launch-arg
    // routing inside DesktopHost.start); the boot layer only uses the gate.
    expect(desktopSource).toContain('classifyArgv');
    expect(mainSource).toContain('FORWARD_CHANNEL');
  });

  it('registers the preload while keeping the security defaults', () => {
    expect(desktopSource).toContain('preload:');
    expect(desktopSource).toContain("'preload.js'");
    expect(desktopSource).toContain('nodeIntegration: false');
    expect(desktopSource).toContain('contextIsolation: true');
    expect(desktopSource).toContain('sandbox: true');
    expect(desktopSource).toContain('webSecurity: true');
  });

  it('dispatches renderer deep links on the deeplink channel', () => {
    expect(DEEPLINK_CHANNEL).toBe('phi:deeplink');
    expect(mainSource).toContain('ipcMain.on(DEEPLINK_CHANNEL');
    expect(mainSource).toContain('parseDeepLink');
    expect(mainSource).toContain('dispatchDeepLink');
  });
});

describe('src/main.ts (phase-3 protocol-registration CLI flags)', () => {
  it('handles --register-protocol before the single-instance gate, the window and whenReady', () => {
    const flagIdx = mainSource.indexOf("'--register-protocol'");
    const gateIdx = mainSource.indexOf('setupSingleInstance(');
    expect(flagIdx).toBeGreaterThan(-1);
    // The flag is parsed before the gate is acquired and before any
    // window/ready path, so a flag launch never acquires the lock, never
    // creates a BrowserWindow, and never reaches deep-link routing.
    expect(flagIdx).toBeLessThan(gateIdx);
    expect(flagIdx).toBeLessThan(mainSource.indexOf('app.whenReady()'));
    // The window is host-owned and created only from start() (never at boot).
    expect(desktopSource.indexOf('new BrowserWindow(')).toBeGreaterThan(-1);
  });

  it('runs installProtocol with the trailing -- args, logs the result and exits 0', () => {
    expect(mainSource).toMatch(
      /installProtocol\(realPlatform,\s*\[\s*path\.join\(here, 'main\.js'\),\s*'--',?\s*\],?\s*\)/,
    );
    expect(mainSource).toContain('installed at ${reg.path}, exe ${reg.exe}');
    const installIdx = mainSource.indexOf('installProtocol(realPlatform');
    const exitIdx = mainSource.indexOf('app.exit(0)');
    expect(installIdx).toBeGreaterThan(-1);
    // The registration completes before the app exits.
    expect(installIdx).toBeLessThan(exitIdx);
  });

  it('handles --unregister-protocol before the gate, logging the result and exiting 0', () => {
    const flagIdx = mainSource.indexOf("'--unregister-protocol'");
    const gateIdx = mainSource.indexOf('setupSingleInstance(');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(gateIdx);
    expect(mainSource).toContain('uninstallProtocol(realPlatform)');
    expect(mainSource).toContain(
      'uninstalled at ${unreg.path}, exe ${unreg.exe}',
    );
    expect(mainSource).toContain('app.exit(0)');
  });

  it('makes --register-protocol win when both flags are given (Wails parity)', () => {
    // The register branch is the if, the unregister branch the else-if.
    const registerIdx = mainSource.indexOf("includes('--register-protocol')");
    const unregisterIdx = mainSource.indexOf(
      "includes('--unregister-protocol')",
    );
    expect(registerIdx).toBeGreaterThan(-1);
    expect(unregisterIdx).toBeGreaterThan(registerIdx);
  });

  it('reports registrationNotExercised in the smoke self-check payload', () => {
    expect(desktopSource).toContain('registrationNotExercised');
    // The smoke harness runs with the normal argv: both registration flags
    // must be absent in the payload assertion.
    expect(desktopSource).toContain("includes('--register-protocol')");
    expect(desktopSource).toContain("includes('--unregister-protocol')");
  });
});

describe('src/desktop.ts (phase-4 system tray + host loop)', () => {
  it('builds the tray after the window and before the second-instance listener', () => {
    // Boot ordering: the gate is acquired at module top in main.ts before
    // any host window exists; inside DesktopHost.start the window is
    // created before the tray, and the tray is built before the
    // second-instance listener so a second launch always finds the tray
    // ready.
    const gateIdx = mainSource.indexOf('setupSingleInstance(');
    const windowIdx = desktopSource.indexOf('new BrowserWindow(');
    const trayCallIdx = desktopSource.indexOf('startTray();');
    const listenerIdx = desktopSource.indexOf('installListener()');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(windowIdx).toBeGreaterThan(-1);
    expect(trayCallIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(mainSource.indexOf('app.whenReady()'));
    expect(windowIdx).toBeLessThan(trayCallIdx);
    expect(trayCallIdx).toBeLessThan(listenerIdx);
    // The tray itself is created via the exported setupTray with the
    // production icon path (TRAY_ICON_PATH override in deps).
    expect(desktopSource).toContain('setupTray(deps)');
    expect(desktopSource).toContain('iconPath: TRAY_ICON_PATH');
  });

  it('routes the tray menu intents through the host loop bridge', () => {
    expect(desktopSource).toContain('TRAY_COMMAND_CHANNEL');
    expect(desktopSource).toContain("case 'show'");
    expect(desktopSource).toContain("case 'select-profile'");
    expect(desktopSource).toContain("case 'pet-zoom-in'");
    expect(desktopSource).toContain("case 'pet-zoom-out'");
    expect(desktopSource).toContain("case 'pet-reset-zoom'");
    expect(desktopSource).toContain('setPetZoomFromTray');
    expect(desktopSource).toContain('setZoomPercent(savedPercent)');
    expect(desktopSource).toContain("case 'quit'");
    // Show Phi foregrounds the main window via restore()+focus() (Wails
    // single.ForegroundMainWindow parity).
    const showIdx = desktopSource.indexOf("case 'show'");
    expect(showIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('mainWindow.restore()')).toBeGreaterThan(
      showIdx,
    );
    expect(desktopSource.indexOf('mainWindow.focus()')).toBeGreaterThan(
      showIdx,
    );
    // Quit notifies the main window's renderer on the tray channel.
    expect(desktopSource).toContain('webContents.send(TRAY_COMMAND_CHANNEL');
  });

  it('routes setActiveProfile/setUnread through the host loop (sync + event-driven)', () => {
    // The host loop is the bridge to the (step-5) controller: profile and
    // unread state flows through tray.setActiveProfile / tray.setUnread —
    // one sync after the controller is built plus the event-driven
    // subscription — with the deps reading the controller's store.
    expect(desktopSource).toContain('tray.setActiveProfile(');
    expect(desktopSource).toContain('tray.setUnread(');
    expect(desktopSource).toContain('getProfiles:');
    expect(desktopSource).toContain('getActiveProfileId:');
    expect(desktopSource).toContain('getUnread:');
    expect(desktopSource).toContain('const state = this.controller?.state();');
    expect(desktopSource).toContain(
      "health: state.health.get(p.id) ?? 'unknown'",
    );
    expect(desktopSource).toContain('unread: state.unread.get(p.id) ?? 0');
  });

  it('rebuilds the persisted pet snapshot before restored-pet startup', () => {
    const controllerIdx = desktopSource.indexOf(
      'this.controller = new Controller',
    );
    const rebuildIdx = desktopSource.indexOf(
      'this.trayHandle?.rebuildMenu()',
      controllerIdx,
    );
    const restoreIdx = desktopSource.indexOf(
      'if (this.controller.state().petEnabled) void this.startPet()',
    );
    expect(controllerIdx).toBeGreaterThan(-1);
    expect(rebuildIdx).toBeGreaterThan(controllerIdx);
    expect(restoreIdx).toBeGreaterThan(rebuildIdx);
  });

  it('closes the tray on before-quit (and on non-macOS window-all-closed)', () => {
    expect(desktopSource).toContain("app.on('before-quit'");
    expect(desktopSource).toContain('trayHandle?.close()');
    // window-all-closed (non-darwin) quits, which fires before-quit and
    // tears the tray down — the Wails OnShutdown equivalent.
    expect(desktopSource).toContain("app.on('window-all-closed'");
    expect(desktopSource).toContain("process.platform !== 'darwin'");
    expect(desktopSource).toContain('app.quit()');
  });

  it('never builds the tray in smoke mode and reports trayNotExercised', () => {
    // The smoke path returns before startTray(), so the harness never
    // instantiates a real Tray (it continues to skip on documented
    // no-display preconditions).
    const smokeIdx = desktopSource.indexOf('if (SMOKE)');
    const trayCallIdx = desktopSource.indexOf('startTray();');
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(smokeIdx).toBeLessThan(trayCallIdx);
    expect(desktopSource).toContain('trayNotExercised');
  });
});

describe('src/desktop.ts (step-5 controller receiver + global hotkey)', () => {
  it('builds the controller after the tray and the second-instance listener with the userData persist path', () => {
    const trayIdx = desktopSource.indexOf('startTray();');
    const listenerIdx = desktopSource.indexOf('installListener()');
    const ctorIdx = desktopSource.indexOf('new Controller(', listenerIdx);
    expect(ctorIdx).toBeGreaterThan(-1);
    expect(trayIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeGreaterThan(-1);
    expect(trayIdx).toBeLessThan(listenerIdx);
    expect(listenerIdx).toBeLessThan(ctorIdx);
    expect(desktopSource).toContain(
      "app.getPath('userData') + '/profiles.json'",
    );
  });

  it('wires the controller events to the tray (active -> setActiveProfile, unread -> setUnread)', () => {
    expect(desktopSource).toContain('controller.subscribe(');
    expect(desktopSource).toContain("event.kind === 'active-changed'");
    expect(desktopSource).toContain('setActiveProfile(profile)');
    expect(desktopSource).toContain("event.kind === 'unread-changed'");
    expect(desktopSource).toContain('setUnread(event.id, event.n)');
    expect(desktopSource).toContain('syncTrayFromController()');
  });

  it('rebuilds the tray menu on profiles-changed (the step-6 rebuild hook)', () => {
    expect(desktopSource).toContain("event.kind === 'profiles-changed'");
    expect(desktopSource).toContain('trayHandle?.rebuildMenu()');
    // The rebuild must live inside the subscribe callback (after the
    // active/unread branches), and must not recreate the tray.
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    const profilesIdx = desktopSource.indexOf(
      "event.kind === 'profiles-changed'",
      subscribeIdx,
    );
    expect(profilesIdx).toBeGreaterThan(subscribeIdx);
    expect(
      desktopSource.indexOf('trayHandle?.rebuildMenu()', profilesIdx),
    ).toBeGreaterThan(profilesIdx);
  });

  it('routes the tray select-profile intent into controller.setActive (the receiver)', () => {
    const selectIdx = desktopSource.indexOf("case 'select-profile'");
    expect(selectIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('ctrl.setActive(cmd.id)')).toBeGreaterThan(
      selectIdx,
    );
  });

  it('owns the quit intent: logs, notifies the main window and calls app.quit()', () => {
    const quitIdx = desktopSource.indexOf("case 'quit'");
    expect(quitIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf("'phi-desktop: tray quit'")).toBeGreaterThan(
      quitIdx,
    );
    expect(
      desktopSource.indexOf('webContents.send(TRAY_COMMAND_CHANNEL, cmd)'),
    ).toBeGreaterThan(quitIdx);
    expect(desktopSource.indexOf('app.quit()', quitIdx)).toBeGreaterThan(
      quitIdx,
    );
  });

  it('routes --server and incoming server URLs through activateServerUrl (add when unmatched, then activate)', () => {
    expect(desktopSource).toContain("'--server'");
    // The --server value is consumed through the shared helper.
    expect(desktopSource).toContain('activateServerUrl(serverArg)');
    // The gate in main.ts hands classified second-launch server payloads
    // to the host's helper (exact incoming-server routing).
    expect(mainSource).toContain('host.activateServerUrl(');
    // The helper guards the controller/view manager and logs failures.
    expect(desktopSource).toContain('activateServerUrl(raw: string): void');
    expect(desktopSource).toContain('controller not ready');
    expect(desktopSource).toContain('profile views not ready');
    expect(desktopSource).toContain('parseEndpoint(raw)');
    expect(desktopSource).toContain('ctrl.add(raw)');
    expect(desktopSource).toContain('ctrl.setActive(profile.id)');
    // The primary's own launch loop routes server payloads to the helper;
    // deep links keep the forward channel.
    expect(desktopSource).toContain("payload.kind === 'server'");
    expect(desktopSource).toContain('activateServerUrl(payload.value)');
    expect(desktopSource).toContain(
      'win.webContents.send(FORWARD_CHANNEL, payload)',
    );
  });

  it('registers the global hotkey after the tray and unregisters every registration on before-quit', () => {
    const trayIdx = desktopSource.indexOf('startTray();');
    const hotkeyIdx = desktopSource.indexOf('registerHotkey(');
    expect(hotkeyIdx).toBeGreaterThan(-1);
    expect(hotkeyIdx).toBeGreaterThan(trayIdx);
    expect(desktopSource).toContain('resolveAccelerator()');
    expect(desktopSource).toContain('hotkeyRegistrations');
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('reg.unregister()')).toBeGreaterThan(
      beforeQuitIdx,
    );
  });

  it('restores and focuses the main window from the hotkey action (Show Phi parity)', () => {
    const hotkeyIdx = desktopSource.indexOf('registerHotkey(');
    expect(
      desktopSource.indexOf('mainWindow.restore()', hotkeyIdx),
    ).toBeGreaterThan(hotkeyIdx);
    expect(
      desktopSource.indexOf('mainWindow.focus()', hotkeyIdx),
    ).toBeGreaterThan(hotkeyIdx);
  });

  it('reports hotkeyNotExercised and controllerPersisted in the smoke self-check payload', () => {
    expect(desktopSource).toContain('hotkeyNotExercised');
    expect(desktopSource).toContain('controllerPersisted');
    // The smoke harness never reaches the hotkey registration (it returns
    // before startTray()); the payload must be gated on the registration
    // list being empty.
    expect(desktopSource).toContain('hotkeyRegistrations.length === 0');
    expect(desktopSource).toContain('existsSync(scratch)');
  });
});

describe('src/desktop.ts (step 6B view manager + rail renderer wiring)', () => {
  it('constructs the ProfileViewManager after the controller with the view factories', () => {
    const listenerIdx = desktopSource.indexOf('installListener()');
    const ctorIdx = desktopSource.indexOf('new Controller(', listenerIdx);
    // The smoke-branch manager (recording fakes) is built before the
    // controller; the production manager must come after it.
    const viewsIdx = desktopSource.indexOf('new ProfileViewManager(', ctorIdx);
    expect(viewsIdx).toBeGreaterThan(-1);
    expect(viewsIdx).toBeGreaterThan(ctorIdx);
    expect(desktopSource).toContain('import { ProfileViewManager }');
    expect(desktopSource).toContain('new WebContentsView({');
  });

  it('exports RAIL_WIDTH = 72 and keeps the non-negotiable view security defaults', () => {
    expect(desktopSource).toContain('export const RAIL_WIDTH = 72;');
    // The per-profile view factory must keep the documented defaults.
    const makeViewIdx = desktopSource.indexOf('new WebContentsView({');
    expect(makeViewIdx).toBeGreaterThan(-1);
    const prefsIdx = desktopSource.indexOf('webPreferences:', makeViewIdx);
    expect(prefsIdx).toBeGreaterThan(makeViewIdx);
    expect(desktopSource.indexOf('sandbox: true', prefsIdx)).toBeGreaterThan(
      prefsIdx,
    );
    expect(
      desktopSource.indexOf('contextIsolation: true', prefsIdx),
    ).toBeGreaterThan(prefsIdx);
    expect(
      desktopSource.indexOf('nodeIntegration: false', prefsIdx),
    ).toBeGreaterThan(prefsIdx);
    expect(
      desktopSource.indexOf('webSecurity: true', prefsIdx),
    ).toBeGreaterThan(prefsIdx);
  });

  it('presents same-origin popup children as hidden native windows, shown on ready-to-show and navigation-guarded', () => {
    const guardIdx = desktopSource.indexOf('const attachNavGuard =');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('attachNavGuard(view.webContents)', guardIdx),
    ).toBeGreaterThan(guardIdx);
    const createIdx = desktopSource.indexOf('createWindow: (options) => {');
    expect(createIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(createIdx);
    const childIdx = desktopSource.indexOf('new BrowserWindow({', createIdx);
    expect(childIdx).toBeGreaterThan(createIdx);
    expect(desktopSource.indexOf('show: false', childIdx)).toBeGreaterThan(
      childIdx,
    );
    expect(
      desktopSource.indexOf('session: sharedSession', childIdx),
    ).toBeGreaterThan(childIdx);
    expect(
      desktopSource.indexOf("child.once('ready-to-show'", childIdx),
    ).toBeGreaterThan(childIdx);
    expect(
      desktopSource.indexOf('attachNavGuard(child.webContents)', childIdx),
    ).toBeGreaterThan(childIdx);
    const childRegion = desktopSource.slice(
      childIdx,
      desktopSource.indexOf('return child.webContents;', childIdx),
    );
    expect(childRegion).not.toContain('.loadFile(');
    const sizeIdx = desktopSource.indexOf('const popupSize =');
    expect(sizeIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('?? 860', sizeIdx)).toBeGreaterThan(sizeIdx);
    expect(desktopSource.indexOf('?? 1000', sizeIdx)).toBeGreaterThan(sizeIdx);
    expect(
      desktopSource.indexOf('setWindowOpenHandler', sizeIdx),
    ).toBeGreaterThan(sizeIdx);
  });

  it('computes the normalized comparison origin once and uses it in both guard paths', () => {
    // The origin comparison must be computed once (normalized via
    // `new URL(origin).origin`) before setWindowOpenHandler, and both
    // handler paths (window-open and will-navigate) must compare against
    // the same `allowedOrigin` constant.
    expect(desktopSource).toContain(
      'const allowedOrigin = new URL(origin).origin',
    );
    const allowedIdx = desktopSource.indexOf(
      'const allowedOrigin = new URL(origin).origin',
    );
    const openHandlerIdx = desktopSource.indexOf(
      'setWindowOpenHandler',
      allowedIdx,
    );
    expect(openHandlerIdx).toBeGreaterThan(allowedIdx);
    const windowOpenCompare = desktopSource.indexOf(
      'target.origin === allowedOrigin',
      openHandlerIdx,
    );
    expect(windowOpenCompare).toBeGreaterThan(openHandlerIdx);
    const navGuardCompare = desktopSource.indexOf(
      'target.origin === allowedOrigin',
      windowOpenCompare + 1,
    );
    expect(navGuardCompare).toBeGreaterThan(windowOpenCompare);
    // No stale direct comparison to the raw origin string remains in either path.
    expect(desktopSource.match(/target\.origin === origin/g)).toBeNull();
  });

  it('wires controller active-changed to profileViews.setActive and re-pushes rail-state on every mutation', () => {
    expect(desktopSource).toContain('profileViews?.setActive(event.id)');
    expect(desktopSource).toContain('pushRailState()');
    expect(desktopSource).toContain("'phi:rail-state'");
    expect(desktopSource).toContain('controller.state()');
    // The push must happen for every mutation kind, not only active/unread.
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    expect(subscribeIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('pushRailState()', subscribeIdx),
    ).toBeGreaterThan(subscribeIdx);
  });

  it('syncs divider widths across retained views on active-changed (capture before setActive, apply after)', () => {
    // Desktop-window-only sync: the outgoing view's persisted widths are
    // read before the switch and applied to the incoming retained view
    // by id via getView (immediately when loaded, else on did-finish-load).
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    const syncIdx = desktopSource.indexOf(
      'syncDividersOnSwitch(event.id)',
      subscribeIdx,
    );
    const setActiveIdx = desktopSource.indexOf(
      'profileViews?.setActive(event.id)',
      subscribeIdx,
    );
    expect(syncIdx).toBeGreaterThan(subscribeIdx);
    expect(syncIdx).toBeLessThan(setActiveIdx);
    expect(desktopSource).toContain('READ_DIVIDERS_SCRIPT');
    expect(desktopSource).toContain('applyDividersScript(');
    expect(desktopSource).toContain('profileViews?.getView(');
    expect(desktopSource).toContain(".once('did-finish-load', apply)");
  });

  it('registers phi:select-profile -> controller.setActive (the rail item click handler)', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:select-profile'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('ctrl.setActive(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });

  it('registers phi:add-server -> controller.add (URL validation) + profileViews.addProfile + controller.setActive', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:add-server'");
    expect(handlerIdx).toBeGreaterThan(-1);
    // controller.add is the URL validation (throws on invalid/same-host);
    // the returned profile is registered with the view manager, then
    // activated (the retained-view switch follows active-changed).
    expect(desktopSource.indexOf('ctrl.add(url)', handlerIdx)).toBeGreaterThan(
      handlerIdx,
    );
    expect(
      desktopSource.indexOf(
        'profileViews?.addProfile(profile.id, profile.origin)',
        handlerIdx,
      ),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('ctrl.setActive(profile.id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });

  it('opens the local modal picker from phi:open-picker', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:open-picker'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('modal: true', handlerIdx)).toBeGreaterThan(
      handlerIdx,
    );
    expect(desktopSource.indexOf("'picker.html'", handlerIdx)).toBeGreaterThan(
      handlerIdx,
    );
  });

  it('recomputes the active view and the rail on window resize', () => {
    const resizeIdx = desktopSource.indexOf("win.on('resize'");
    expect(resizeIdx).toBeGreaterThan(-1);
    // The resize handler delegates to the single layout function, which
    // recomputes the two child regions (profile body + rail) below the
    // main view page's header row.
    expect(
      desktopSource.indexOf('layoutChildren()', resizeIdx),
    ).toBeGreaterThan(resizeIdx);
    const layoutIdx = desktopSource.indexOf('const layoutChildren');
    expect(layoutIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('profileViews?.onWindowResize()', layoutIdx),
    ).toBeGreaterThan(layoutIdx);
    expect(desktopSource.indexOf('layoutRail()', layoutIdx)).toBeGreaterThan(
      layoutIdx,
    );
  });

  it('places the rail below the composed header and re-applies its bounds on every resize', () => {
    const layoutIdx = desktopSource.indexOf('const layoutRail =');
    expect(layoutIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('railView.setBounds', layoutIdx),
    ).toBeGreaterThan(layoutIdx);
    // The rail begins at HEADER_HEIGHT; its height is the content height less
    // the header row so the title island never overlaps a rail entry.
    const setBoundsIdx = desktopSource.indexOf('railView.setBounds', layoutIdx);
    expect(desktopSource.indexOf('x: 0,', setBoundsIdx)).toBeGreaterThan(
      setBoundsIdx,
    );
    expect(
      desktopSource.indexOf('y: HEADER_HEIGHT,', setBoundsIdx),
    ).toBeGreaterThan(setBoundsIdx);
    expect(
      desktopSource.indexOf('width: RAIL_WIDTH,', setBoundsIdx),
    ).toBeGreaterThan(setBoundsIdx);
    expect(
      desktopSource.indexOf('b.height - HEADER_HEIGHT', setBoundsIdx),
    ).toBeGreaterThan(setBoundsIdx);
    expect(
      desktopSource.indexOf('railView.webContents.isDestroyed()', layoutIdx),
    ).toBeGreaterThan(layoutIdx);
    const finishLoadIdx = desktopSource.indexOf(
      "rail.webContents.on('did-finish-load'",
      layoutIdx,
    );
    expect(finishLoadIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('layoutRail()', finishLoadIdx),
    ).toBeGreaterThan(finishLoadIdx);
  });

  it('builds the rail renderer as a never-hidden child view loading dist/renderer.html', () => {
    expect(desktopSource).toContain('session: sharedSession');
    expect(desktopSource).toContain('win.contentView.addChildView(rail)');
    const addChildIdx = desktopSource.indexOf(
      'win.contentView.addChildView(rail)',
    );
    expect(desktopSource.indexOf('layoutRail();', addChildIdx)).toBeGreaterThan(
      addChildIdx,
    );
    expect(desktopSource).toContain("'dist', 'renderer.html'");
    // The initial rail-state snapshot is pushed after the page loads.
    const loadFileIdx = desktopSource.indexOf(
      'await rail.webContents.loadFile(',
    );
    expect(loadFileIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('pushRailState()', loadFileIdx),
    ).toBeGreaterThan(loadFileIdx);
  });

  it('tears the retained views down on before-quit BEFORE app.quit()', () => {
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    const destroyIdx = desktopSource.indexOf(
      'profileViews.destroyAll()',
      beforeQuitIdx,
    );
    const quitIdx = desktopSource.indexOf('app.quit()', destroyIdx);
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeGreaterThan(beforeQuitIdx);
    expect(quitIdx).toBeGreaterThan(destroyIdx);
    // The first before-quit defers the quit (preventDefault + guard flag)
    // until destroyAll() completes, then re-quits.
    expect(desktopSource).toContain('event.preventDefault()');
    expect(desktopSource).toContain('viewsTornDown');
  });

  it('builds the view manager with recording fakes in smoke mode and reports the new-geometry payload fields', () => {
    // No real WebContentsView/Session may be constructed by the harness
    // (the no-real-GUI convention): the smoke path uses a fake window and
    // the makeSmokeContentView factory, and never builds the rail child
    // view (its loadFile is a no-op there).
    expect(desktopSource).toContain('makeSmokeContentView()');
    expect(desktopSource).toContain("profileViews.addProfile('127-0-0-1-7070'");
    expect(desktopSource).toContain("profileViews.setActive('127-0-0-1-7070')");
    expect(desktopSource).toContain('result.viewsCreated');
    expect(desktopSource).toContain('result.activeViewId');
    expect(desktopSource).toContain('result.railWidth = RAIL_WIDTH');
    expect(desktopSource).toContain('result.bodyLeftOffset = RAIL_WIDTH');
    expect(desktopSource).toContain('result.bodyTopOffset = HEADER_HEIGHT');
    expect(desktopSource).toContain('result.railTopOffset = HEADER_HEIGHT');
    expect(desktopSource).toContain('result.headerHeight = HEADER_HEIGHT');
  });
});

describe('src/desktop.ts (rail reorder receiver)', () => {
  it('registers phi:reorder-profile -> controller.reorder with a nullable beforeId and no reply channel', () => {
    const handlerIdx = desktopSource.indexOf("'phi:reorder-profile'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('ctrl.reorder(id, beforeId)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf("typeof beforeId !== 'string'", handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('phi-desktop: phi:reorder-profile', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });
});

describe('src/desktop.ts (rail server session context)', () => {
  it('registers phi:open-server-sessions -> controller.setActive, then the retained-view selector click', () => {
    const handlerIdx = desktopSource.indexOf(
      "ipcMain.on('phi:open-server-sessions'",
    );
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('ctrl.setActive(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('openServerSessions(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    // Unknown ids (stale rail entry) are logged and the selector is never opened.
    expect(
      desktopSource.indexOf(
        'phi-desktop: phi:open-server-sessions',
        handlerIdx,
      ),
    ).toBeGreaterThan(handlerIdx);
  });

  it("opens the page's own selector via a fixed guarded #hostname-display click (fixed constant, never interpolated)", () => {
    expect(desktopSource).toContain('const OPEN_SESSIONS_SCRIPT = `(() => {');
    expect(desktopSource).toContain("getElementById('hostname-display')");
    expect(desktopSource).toContain('if (!display) return false;');
    expect(desktopSource).toContain('display.click()');
    expect(desktopSource).toContain('executeJavaScript(OPEN_SESSIONS_SCRIPT)');
  });

  it('delegates to the in-page handler: the script only clicks the display, never renders a dropdown from main', () => {
    const scriptIdx = desktopSource.indexOf('const OPEN_SESSIONS_SCRIPT');
    const scriptEnd = desktopSource.indexOf('})()`', scriptIdx) + 4;
    const script = desktopSource.slice(scriptIdx, scriptEnd);
    expect(script).toContain("getElementById('hostname-display')");
    expect(script).not.toContain('hostname-tabs-dropdown');
    expect(script).not.toContain('renderHostnameTabsDropdown');
  });

  it('reuses the loadedViews did-finish-load gate when the retained view has not finished loading', () => {
    const idx = desktopSource.indexOf('openServerSessions(');
    expect(idx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('profileViews?.getView(id)', idx),
    ).toBeGreaterThan(idx);
    expect(desktopSource.indexOf('loadedViews.has(view)', idx)).toBeGreaterThan(
      idx,
    );
    expect(
      desktopSource.indexOf(
        "view.webContents.once('did-finish-load', open)",
        idx,
      ),
    ).toBeGreaterThan(idx);
    expect(
      desktopSource.indexOf('view.webContents.isDestroyed()', idx),
    ).toBeGreaterThan(idx);
  });
});

describe('src/desktop.ts (step-6 completion: rail-targeted snapshots, content bounds, MRU restore, echo)', () => {
  it('sends phi:rail-state to the RAIL view webContents (the renderer that renders the rail)', () => {
    const pushIdx = desktopSource.indexOf('pushRailState(): void');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('rail.webContents.send', pushIdx),
    ).toBeGreaterThan(pushIdx);
    // The covered main window's own webContents must never receive the
    // rail snapshot.
    expect(
      desktopSource.indexOf("win.webContents.send('phi:rail-state'", pushIdx),
    ).toBe(-1);
  });

  it('bounds the active view from the window CONTENT bounds, below the header, right of the rail', () => {
    const boundsIdx = desktopSource.indexOf('const defaultBounds');
    expect(boundsIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('win.getContentBounds()', boundsIdx),
    ).toBeGreaterThan(boundsIdx);
    expect(desktopSource.indexOf('x: RAIL_WIDTH', boundsIdx)).toBeGreaterThan(
      boundsIdx,
    );
    expect(
      desktopSource.indexOf('y: HEADER_HEIGHT', boundsIdx),
    ).toBeGreaterThan(boundsIdx);
    expect(
      desktopSource.indexOf('b.width - RAIL_WIDTH', boundsIdx),
    ).toBeGreaterThan(boundsIdx);
    expect(
      desktopSource.indexOf('b.height - HEADER_HEIGHT', boundsIdx),
    ).toBeGreaterThan(boundsIdx);
  });

  it('restores the most recently used profile at startup (its retained view loads immediately)', () => {
    const serverIdx = desktopSource.indexOf('--server');
    const hotkeyIdx = desktopSource.indexOf('registerHotkey(');
    const mruIdx = desktopSource.indexOf('controller.mostRecent()');
    expect(mruIdx).toBeGreaterThan(-1);
    expect(mruIdx).toBeGreaterThan(serverIdx);
    expect(mruIdx).toBeLessThan(hotkeyIdx);
    expect(desktopSource).toContain('controller.setActive(mru.id)');
  });

  it('loads the picker from a local file', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:open-picker'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        "picker.loadFile(path.join(here, 'picker.html'))",
        handlerIdx,
      ),
    ).toBeGreaterThan(handlerIdx);
  });
});

describe('src/desktop.ts (title-marker attention routing)', () => {
  it('routes only exact `● ` marker transitions to setUnread, notifies once per entry, and adds no preload/IPC', () => {
    const markerIdx = desktopSource.indexOf("const TITLE_MARKER = '● ';");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('title.startsWith(TITLE_MARKER)', markerIdx),
    ).toBeGreaterThan(markerIdx);
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    expect(makeViewIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf("'page-title-updated'", makeViewIdx),
    ).toBeGreaterThan(makeViewIdx);
    expect(desktopSource).toContain('setUnread(profile.id, 1)');
    expect(desktopSource).toContain('setUnread(profile.id, 0)');
    expect(desktopSource).toContain('marked === prev');
    expect(desktopSource).toContain('title: `Phi · ${profile.name}`');
    expect(desktopSource).toContain("'Terminal done'");
    expect(desktopSource).toContain('isFocused()');
    expect(desktopSource).toContain('isMinimized()');
    expect(desktopSource).toContain("notification.on('click'");
    expect(desktopSource).toContain('ctrl.setActive(profile.id)');
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
  });
});

describe('src/desktop.ts (close-to-tray lifecycle)', () => {
  it('hides the main window on close when the persisted preference is on (default true)', () => {
    const closeIdx = desktopSource.indexOf("win.on('close'");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('event.preventDefault()', closeIdx),
    ).toBeGreaterThan(closeIdx);
    expect(desktopSource.indexOf('win.hide()', closeIdx)).toBeGreaterThan(
      closeIdx,
    );
    expect(desktopSource).toContain('controller?.state().closeToTray ?? true');
  });

  it('guards explicit quits with the quitting flag set in before-quit (no hide-loop)', () => {
    // The close handler must check the flag before hiding.
    const closeIdx = desktopSource.indexOf("win.on('close'");
    expect(desktopSource.indexOf('!this.quitting', closeIdx)).toBeGreaterThan(
      closeIdx,
    );
    // before-quit fires before windows close, so every quit path is covered.
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    expect(
      desktopSource.indexOf('quitting = true;', beforeQuitIdx),
    ).toBeGreaterThan(beforeQuitIdx);
  });

  it('registers the close interception on the main window only (child windows close normally)', () => {
    const closeHandlers = desktopSource.match(/\.on\('close'/g) ?? [];
    expect(closeHandlers).toHaveLength(1);
    // The picker child window creation block registers no close handler.
    const pickerIdx = desktopSource.indexOf(
      'const picker = new BrowserWindow({',
    );
    const pickerEnd = desktopSource.indexOf("picker.once('ready-to-show'");
    const pickerBlock = desktopSource.slice(pickerIdx, pickerEnd);
    expect(pickerBlock).not.toMatch(/\.on\('close'|\.once\('close'/);
  });

  it('routes the tray toggle intent into controller.setCloseToTray and feeds the checkbox from the store', () => {
    const toggleIdx = desktopSource.indexOf("case 'toggle-close-to-tray'");
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'ctrl.setCloseToTray(!ctrl.getCloseToTray())',
        toggleIdx,
      ),
    ).toBeGreaterThan(toggleIdx);
    expect(desktopSource).toContain(
      'getCloseToTray: () => this.controller?.state().closeToTray ?? true',
    );
  });

  it('rebuilds the tray menu on close-to-tray-changed (the checkbox reflects the new state)', () => {
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    const kindIdx = desktopSource.indexOf(
      "event.kind === 'close-to-tray-changed'",
      subscribeIdx,
    );
    expect(kindIdx).toBeGreaterThan(subscribeIdx);
    expect(
      desktopSource.indexOf('trayHandle?.rebuildMenu()', kindIdx),
    ).toBeGreaterThan(kindIdx);
  });

  it('restores a hidden (close-to-tray) window from the tray Show Phi and the hotkey actions', () => {
    const showIdx = desktopSource.indexOf("case 'show'");
    expect(desktopSource.indexOf('mainWindow.show()', showIdx)).toBeGreaterThan(
      showIdx,
    );
    const hotkeyIdx = desktopSource.indexOf('registerHotkey(');
    expect(
      desktopSource.indexOf('mainWindow.show()', hotkeyIdx),
    ).toBeGreaterThan(hotkeyIdx);
  });
});

describe('src/desktop.ts (observed rail identity + accent)', () => {
  it('observes the remote page through a fixed executeJavaScript expression reading #hostname-display and the --accent token', () => {
    expect(desktopSource).toContain(
      "document.getElementById('hostname-display')",
    );
    expect(desktopSource).toContain("getPropertyValue('--accent')");
    expect(desktopSource).toMatch(
      /executeJavaScript\(\s*REMOTE_IDENTITY_SCRIPT/,
    );
  });

  it('keeps remote observation in the view factory, with no preload or IPC on remote origins', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    const titleIdx = factoryRegion.indexOf("'page-title-updated'");
    const loadIdx = factoryRegion.indexOf("'did-finish-load'");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    // Observation rides page-title-updated (post app-ready), never did-finish-load.
    expect(
      factoryRegion.indexOf('observeProfileIdentity(view, origin)', titleIdx),
    ).toBeGreaterThan(titleIdx);
    expect(factoryRegion.slice(loadIdx)).not.toContain(
      'observeProfileIdentity',
    );
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
  });

  it('merges the observed hostname and accent into the rail snapshot, empty until observed', () => {
    expect(desktopSource).toContain('observedIdentity = new Map');
    expect(desktopSource).toContain("hostname: identity?.hostname ?? ''");
    expect(desktopSource).toContain("accent: identity?.accent ?? ''");
  });

  it('caches an observation only once the page reports a hostname or accent', () => {
    expect(desktopSource).toContain(
      "if (identity.hostname === '' && identity.accent === '') return null;",
    );
  });

  it('re-pushes the rail snapshot and refreshes the window title only after a valid observation resolves', () => {
    expect(desktopSource).toContain(
      'observeProfileIdentity(view, origin).then((identity) => {',
    );
    expect(desktopSource).toContain('if (identity !== null) {');
    expect(desktopSource).toContain('refreshWindowTitle();');
  });

  it('drops the observed identity when its profile is removed', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:remove-profile'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('observedIdentity.delete(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });
});

describe('src/desktop.ts (desktop title row + selected-server taskbar title)', () => {
  it('creates the main window frameless with no native titleBarOverlay workaround', () => {
    const windowIdx = desktopSource.indexOf('const win = new BrowserWindow({');
    expect(windowIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('frame: false', windowIdx)).toBeGreaterThan(
      windowIdx,
    );
    // The native-overlay workaround is gone: the desktop composes its own
    // header row, so neither titleBarStyle nor titleBarOverlay may appear.
    expect(desktopSource).not.toContain('titleBarStyle');
    expect(desktopSource).not.toContain('titleBarOverlay');
  });

  it('defines the header geometry constants and keeps the profile view below the header right of the rail', () => {
    expect(desktopSource).toContain('export const RAIL_WIDTH = 72;');
    expect(desktopSource).toContain('export const HEADER_HEIGHT = 48;');
    // The island lane constants are gone with the islands.
    expect(desktopSource).not.toContain('TITLE_LANE_WIDTH');
    expect(desktopSource).not.toContain('CAPTION_LANE_WIDTH');
    expect(desktopSource).not.toContain('TITLE_ROW_HEIGHT');
    const boundsIdx = desktopSource.indexOf('const defaultBounds');
    expect(desktopSource.indexOf('x: RAIL_WIDTH', boundsIdx)).toBeGreaterThan(
      boundsIdx,
    );
    expect(
      desktopSource.indexOf('y: HEADER_HEIGHT', boundsIdx),
    ).toBeGreaterThan(boundsIdx);
  });

  it('composes the selected-server taskbar title from the remote title glyph contract and observed hostname', () => {
    expect(desktopSource).toContain('refreshWindowTitle(): void');
    expect(desktopSource).toContain('observedTitle.get(activeId)');
    expect(desktopSource).toContain('identity.hostname.toUpperCase()');
    const refreshTitleIdx = desktopSource.indexOf('refreshWindowTitle(): void');
    const titleCallIdx = desktopSource.indexOf(
      'win.setTitle(',
      refreshTitleIdx,
    );
    expect(
      desktopSource.indexOf(
        "`${marked ? TITLE_MARKER : ''}${glyph} Phi — ${identity.hostname.toUpperCase()}`",
        titleCallIdx,
      ),
    ).toBeGreaterThan(titleCallIdx);
  });

  it('refreshes the title on active-changed, title updates, and identity observation only', () => {
    expect(desktopSource).toContain('observedTitle.set(profile.id, title);');
    const titleIdx = desktopSource.indexOf("'page-title-updated'");
    expect(
      desktopSource.indexOf('refreshWindowTitle()', titleIdx),
    ).toBeGreaterThan(titleIdx);
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    expect(
      desktopSource.indexOf('refreshWindowTitle()', subscribeIdx),
    ).toBeGreaterThan(subscribeIdx);
  });

  it('falls back to the plain app name before any observation and loads the local main view page', () => {
    expect(desktopSource).toContain("win.setTitle('Phi')");
    const loadFileIdx = desktopSource.indexOf(
      "loadFile(path.join(here, '..', 'web', 'index.html'))",
    );
    expect(loadFileIdx).toBeGreaterThan(-1);
  });
});

describe('src/desktop.ts (main view page + window controls)', () => {
  it('loads the local main view page (the vendored header) via loadFile and never renders an island page', () => {
    const loadFileIdx = desktopSource.indexOf(
      "loadFile(path.join(here, '..', 'web', 'index.html'))",
    );
    expect(loadFileIdx).toBeGreaterThan(-1);
    // The title/caption islands are gone: no island page is ever loaded
    // and no island field or layout remains.
    expect(desktopSource).not.toContain("'title.html'");
    expect(desktopSource).not.toContain("'caption.html'");
    expect(desktopSource).not.toContain('titleIsland');
    expect(desktopSource).not.toContain('captionIsland');
    expect(desktopSource).not.toContain('TITLE_LANE_WIDTH');
    expect(desktopSource).not.toContain('CAPTION_LANE_WIDTH');
  });

  it('registers the three window-control IPC handlers (minimize, toggle-maximize, close)', () => {
    expect(desktopSource).toContain("ipcMain.handle('phi:window-minimize'");
    expect(desktopSource).toContain(
      "ipcMain.handle('phi:window-toggle-maximize'",
    );
    expect(desktopSource).toContain("ipcMain.handle('phi:window-close'");
    const minimizeIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:window-minimize'",
    );
    expect(
      desktopSource.indexOf('win.minimize()', minimizeIdx),
    ).toBeGreaterThan(minimizeIdx);
    const toggleIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:window-toggle-maximize'",
    );
    expect(
      desktopSource.indexOf('win.isMaximized()', toggleIdx),
    ).toBeGreaterThan(toggleIdx);
    expect(
      desktopSource.indexOf('win.unmaximize()', toggleIdx),
    ).toBeGreaterThan(toggleIdx);
    expect(desktopSource.indexOf('win.maximize()', toggleIdx)).toBeGreaterThan(
      toggleIdx,
    );
    const closeIdx = desktopSource.indexOf("ipcMain.handle('phi:window-close'");
    expect(desktopSource.indexOf('win.close()', closeIdx)).toBeGreaterThan(
      closeIdx,
    );
  });

  it('validates the sender: only the main view page (the window webContents) may invoke the window controls', () => {
    const minimizeIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:window-minimize'",
    );
    expect(minimizeIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('isMainViewSender(event)', minimizeIdx),
    ).toBeGreaterThan(minimizeIdx);
    const toggleIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:window-toggle-maximize'",
    );
    expect(
      desktopSource.indexOf('isMainViewSender(event)', toggleIdx),
    ).toBeGreaterThan(toggleIdx);
    const closeIdx = desktopSource.indexOf("ipcMain.handle('phi:window-close'");
    expect(
      desktopSource.indexOf('isMainViewSender(event)', closeIdx),
    ).toBeGreaterThan(closeIdx);
    // The guard compares the sender against the window's own webContents —
    // a remote profile origin, the rail, or the picker can never drive the
    // window.
    const guardIdx = desktopSource.indexOf('const isMainViewSender');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('event.sender === win.webContents', guardIdx),
    ).toBeGreaterThan(guardIdx);
  });

  it('installs the plain-F11 fullscreen toggle on the main view, picker, and popups', () => {
    // The main window's own page (the vendored header).
    expect(desktopSource).toContain(
      'installFullscreenToggle(win.webContents, win)',
    );
    // The local add-server picker (modal child of the main window).
    const pickerIdx = desktopSource.indexOf("ipcMain.on('phi:open-picker'");
    expect(pickerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installFullscreenToggle(picker.webContents, win)',
        pickerIdx,
      ),
    ).toBeGreaterThan(pickerIdx);
    // Same-origin popup children each toggle their own window.
    const popupIdx = desktopSource.indexOf('createWindow: (options) => {');
    expect(popupIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installFullscreenToggle(child.webContents, child)',
        popupIdx,
      ),
    ).toBeGreaterThan(popupIdx);
    // The retained body views install the same contract via the shared
    // module (behavioural coverage in test/views.test.ts + fullscreen.test.ts).
    expect(desktopSource).toContain(
      "import { installFullscreenToggle } from './fullscreen.js'",
    );
  });

  it('installs the F5 reload shortcut on the main view, picker, and popups', () => {
    expect(desktopSource).toMatch(/installReloadShortcut\(\s*win\.webContents/);
    const pickerIdx = desktopSource.indexOf("ipcMain.on('phi:open-picker'");
    expect(pickerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installReloadShortcut(picker.webContents)',
        pickerIdx,
      ),
    ).toBeGreaterThan(pickerIdx);
    const popupIdx = desktopSource.indexOf('createWindow: (options) => {');
    expect(popupIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installReloadShortcut(child.webContents)',
        popupIdx,
      ),
    ).toBeGreaterThan(popupIdx);
    expect(desktopSource).toContain(
      "import { installReloadShortcut } from './reload.js'",
    );
  });

  it('installs the zoom shortcuts on the main view, picker, and popups', () => {
    expect(desktopSource).toContain('installZoomShortcuts(win.webContents');
    const pickerIdx = desktopSource.indexOf("ipcMain.on('phi:open-picker'");
    expect(pickerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installZoomShortcuts(picker.webContents)',
        pickerIdx,
      ),
    ).toBeGreaterThan(pickerIdx);
    const popupIdx = desktopSource.indexOf('createWindow: (options) => {');
    expect(popupIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'installZoomShortcuts(child.webContents)',
        popupIdx,
      ),
    ).toBeGreaterThan(popupIdx);
    expect(desktopSource).toContain(
      "import { installZoomShortcuts } from './zoom.js'",
    );
  });

  it('pushes maximize/focus state and the active server to the main view page on maximize, unmaximize, focus and blur', () => {
    expect(desktopSource).toContain("'phi:window-state'");
    const pushIdx = desktopSource.indexOf('pushWindowState(): void');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf("win.webContents.send('phi:window-state'", pushIdx),
    ).toBeGreaterThan(pushIdx);
    expect(
      desktopSource.indexOf('isMaximized: win.isMaximized()', pushIdx),
    ).toBeGreaterThan(pushIdx);
    expect(
      desktopSource.indexOf('focused: win.isFocused()', pushIdx),
    ).toBeGreaterThan(pushIdx);
    const focusIdx = desktopSource.indexOf("win.on('focus'");
    expect(
      desktopSource.indexOf('pushWindowState()', focusIdx),
    ).toBeGreaterThan(focusIdx);
    expect(desktopSource.indexOf("win.on('blur'", focusIdx)).toBeGreaterThan(
      focusIdx,
    );
    expect(
      desktopSource.indexOf("win.on('maximize'", focusIdx),
    ).toBeGreaterThan(focusIdx);
    expect(
      desktopSource.indexOf("win.on('unmaximize'", focusIdx),
    ).toBeGreaterThan(focusIdx);
    // The header's hostname/project display tracks the SELECTED server.
    expect(desktopSource).toContain("'phi:active-server'");
    expect(desktopSource).toContain('pushActiveServer()');
  });

  it('swaps the window icon to the active server accent on pushActiveServer', () => {
    // The dynamic window icon follows the observed accent (same Φ
    // silhouette, accent glyph color); the white brand icon is the
    // unobserved fallback.
    const pushIdx = desktopSource.indexOf('pushActiveServer(): void');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('win.setIcon(', pushIdx)).toBeGreaterThan(
      pushIdx,
    );
    expect(
      desktopSource.indexOf('iconResolver.resolve(', pushIdx),
    ).toBeGreaterThan(pushIdx);
    expect(desktopSource).toContain(
      "import { iconResolver } from './appicon.js'",
    );
  });

  it('mirrors the observed remote title to the main view page from refreshWindowTitle', () => {
    expect(desktopSource).toContain("'phi:window-title'");
    expect(desktopSource).toContain('pushMainViewTitle(');
    const titleIdx = desktopSource.indexOf('refreshWindowTitle(): void');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('pushMainViewTitle(rest)', titleIdx),
    ).toBeGreaterThan(titleIdx);
  });

  it('proxies the ACTIVE server /api/config to the main view page with sender validation + 401-triggered unlock', () => {
    const handlerIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:server-config'",
    );
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('isMainViewSender(event)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    // The handler delegates to AccessAuth.fetchConfig; the access-auth
    // module pins the path to /api/config so a future rename surfaces
    // here.
    expect(desktopSource).toContain(
      "import { AccessAuth } from './access-auth.js'",
    );
    const accessAuthSource = readFileSync(
      path.join(here, '..', 'src', 'access-auth.ts'),
      'utf8',
    );
    expect(accessAuthSource).toContain("CONFIG_PATH = '/api/config'");
    // 401-triggered unlock wiring lives in the same module so a future
    // refactor cannot remove it without breaking the test.
    expect(desktopSource).toContain("'phi:auth-required'");
    expect(desktopSource).toContain("'phi:auth-unlock'");
    expect(desktopSource).toContain("'phi:body-obscuring'");
    expect(desktopSource).toContain('sendAuthRequired(');
    // The native-fetch cookie stays isolated. The body receives only a
    // fresh one-time challenge/proof and obtains its own cookie by making
    // its same-origin login request before reload.
    expect(desktopSource).toContain('accessAuth.createLoginProof(');
    expect(desktopSource).toContain('bodyAuthLoginScript(');
    expect(desktopSource).not.toContain('sharedSession.cookies.set(');
    expect(desktopSource).not.toContain('session.defaultSession.cookies');
  });

  it('re-authenticates silently from the persisted verifier on a mid-session 401 (no prompt for backend restarts)', () => {
    // Backend restarts wipe the server's in-memory session map
    // (auth.go). The desktop must consult the on-disk PBKDF2 verifier
    // before falling through to the password modal — otherwise every
    // returning user re-prompts after every server bounce.
    const configIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:server-config'",
    );
    expect(configIdx).toBeGreaterThan(-1);
    // Per-origin coalescing prevents two concurrent stale-cookie
    // fetchConfig calls from both deleting a freshly-installed
    // cookie (one would delete the other's S1, the loser poll's
    // outer retry would then 401, the outer code would clear a
    // valid stored credential and prompt). The gate has to start
    // BEFORE the racy fetchConfig, not inside the unauthorized
    // branch (that was the original regression).
    expect(desktopSource).toContain('configOpInFlight');
    expect(desktopSource).toContain('configOpInFlight.get(origin)');
    expect(desktopSource).toContain('configOpInFlight.set(origin, promise)');
    expect(desktopSource).toContain('configOpInFlight.delete(origin)');
    // The silent re-auth block lives between the 'trusted' status check
    // and the `pendingUnlock = {` prompt-creation. Anchor on both ends
    // so a future refactor cannot silently remove the re-auth path.
    const trustedIdx = desktopSource.indexOf(
      "status.kind === 'trusted'",
      configIdx,
    );
    expect(trustedIdx).toBeGreaterThan(configIdx);
    const promptIdx = desktopSource.indexOf('pendingUnlock = {', trustedIdx);
    expect(promptIdx).toBeGreaterThan(trustedIdx);
    expect(
      desktopSource.indexOf('this.storedCredentials.has(origin)', trustedIdx),
    ).toBeLessThan(promptIdx);
    expect(
      desktopSource.indexOf('accessAuth.tryUnlockWithVerifier', trustedIdx),
    ).toBeLessThan(promptIdx);
    // Conservative clearing: ONLY on a server-evaluated proof rejection
    // (invalid-password) or a confirmed salt/iteration rotation.
    // rate-limited is NOT a proof rejection (auth.go returns 429 before
    // consuming the challenge, keyed by client IP — clearing on it
    // would destroy a valid credential from a prior unrelated failure
    // and re-introduce the prompt bug). The old test had a permissive
    // assertion that would have accepted the regression; this asserts
    // the fix.
    const clearIdx = desktopSource.indexOf(
      'this.clearStoredCredential(origin)',
      trustedIdx,
    );
    expect(clearIdx).toBeGreaterThan(trustedIdx);
    expect(
      desktopSource.indexOf("unlock.kind === 'invalid-password'", clearIdx),
    ).toBeGreaterThan(clearIdx);
    expect(
      desktopSource.indexOf("unlock.kind === 'invalid-password'", clearIdx),
    ).toBeLessThan(promptIdx);
    // Between the invalid-password check and the prompt creation,
    // rate-limited must NOT appear as a clear trigger.
    const rateLimitedBetween = desktopSource.lastIndexOf(
      "unlock.kind === 'rate-limited'",
      promptIdx,
    );
    expect(rateLimitedBetween).toBeLessThan(clearIdx);
    // Body reauth failure must not leave the body stuck on its own
    // auth UI: schedule an independent retry with backoff (the next
    // config poll uses the fresh main cookie and never re-enters the
    // 401 branch, so the body needs its own retry chain).
    expect(desktopSource).toContain(
      'scheduleBodyReauthRetry(origin, active.id)',
    );
    expect(desktopSource).toContain('const bodyReauthInFlight = new Map');
    expect(desktopSource).toContain('const scheduleBodyReauthRetry');
    // After a successful silent re-auth the body view is also re-logged-
    // in and reloaded via the cached verifier (B2): the body's Chromium
    // shared-session cookie is stale even when the main-process jar is
    // fresh.
    expect(desktopSource).toContain('silentBodyReauth(origin, active.id)');
    // The helper itself wraps authenticateBodyView with a synthetic
    // pending; the relaxed pendingUnlock check inside
    // authenticateBodyView is the contract tweak that lets the silent
    // path through without disturbing the typed-unlock prompt flow.
    expect(desktopSource).toContain('const silentBodyReauth');
    expect(desktopSource).toContain(
      '(pendingUnlock !== null && pendingUnlock !== pending)',
    );
  });

  it('invalidates in-flight body logins across an A→B→A rail switch via an active-selection epoch', () => {
    // The activeId check alone is an ABA race: A→B→A returns A again
    // but the proof has already been injected into the B view. The
    // epoch counter, bumped on every active-changed event and checked
    // at every await boundary inside authenticateBodyView, is the
    // cross-await guarantee.
    expect(desktopSource).toContain('let activeEpoch = 0');
    // Bumped on active-changed (next to the existing pendingUnlock
    // abort block — a future refactor that moves the abort without
    // also moving the epoch bump would silently reintroduce the race).
    const activeChangedIdx = desktopSource.indexOf(
      "event.kind === 'active-changed'",
    );
    expect(activeChangedIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('activeEpoch++;', activeChangedIdx),
    ).toBeGreaterThan(activeChangedIdx);
    // Captured into both pending types so a synthetic silent path
    // pending can't outlive a rail switch.
    expect(desktopSource).toContain('epoch: activeEpoch');
    // Checked at every await boundary inside authenticateBodyView.
    expect(desktopSource).toContain('pending.epoch !== activeEpoch');
  });

  it('rejects stale config/workspace reads after an active-server switch', () => {
    const configIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:server-config'",
    );
    expect(configIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'ctrl.state().activeId !== capture.profileId',
        configIdx,
      ),
    ).toBeGreaterThan(configIdx);
    const workspaceIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:active-workspace'",
    );
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('isMainViewSender(event)', workspaceIdx),
    ).toBeGreaterThan(workspaceIdx);
    expect(
      desktopSource.indexOf('READ_WORKSPACE_SCRIPT', workspaceIdx),
    ).toBeGreaterThan(workspaceIdx);
    expect(
      desktopSource.indexOf(
        'ctrl.state().activeId !== active.id',
        workspaceIdx,
      ),
    ).toBeGreaterThan(workspaceIdx);
  });

  it('relays header actions to the ACTIVE body view with a fixed button whitelist', () => {
    const handlerIdx = desktopSource.indexOf(
      "ipcMain.handle('phi:header-action'",
    );
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('isMainViewSender(event)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('HEADER_ACTION_BUTTONS', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('headerActionClickScript(action.id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    expect(
      desktopSource.indexOf('setWorkspaceScript(action.value)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
    // The relay targets the retained body view only (never the window).
    expect(
      desktopSource.indexOf('viewByOrigin.get(active.origin)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });

  it('tears the retained views and the rail down on before-quit (no island teardown)', () => {
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('this.railView', beforeQuitIdx),
    ).toBeGreaterThan(beforeQuitIdx);
    expect(desktopSource).not.toContain('titleIsland');
    expect(desktopSource).not.toContain('captionIsland');
  });
});

describe('src/preload.ts (main-view-page window-control + server bridge)', () => {
  it('exposes the window-control posts and the window-state/title subscriptions', () => {
    expect(preloadSource).toContain("'phi:window-minimize'");
    expect(preloadSource).toContain("'phi:window-toggle-maximize'");
    expect(preloadSource).toContain("'phi:window-close'");
    expect(preloadSource).toContain("'phi:window-state'");
    expect(preloadSource).toContain("'phi:window-title'");
    expect(preloadSource).toContain('postWindowMinimize');
    expect(preloadSource).toContain('postWindowToggleMaximize');
    expect(preloadSource).toContain('postWindowClose');
    expect(preloadSource).toContain('onWindowState');
    expect(preloadSource).toContain('onWindowTitle');
  });

  it('exposes the server bridge: config proxy, header-action relay and active-server push', () => {
    expect(preloadSource).toContain("'phi:server-config'");
    expect(preloadSource).toContain("'phi:header-action'");
    expect(preloadSource).toContain("'phi:active-server'");
    expect(preloadSource).toContain('fetchServerConfig');
    expect(preloadSource).toContain('fetchActiveWorkspace');
    expect(preloadSource).toContain("'phi:active-workspace'");
    expect(preloadSource).toContain('postHeaderAction');
    expect(preloadSource).toContain('onActiveServer');
  });
});

describe('src/desktop.ts (per-server CPU observation: rail intensity + taskbar progress)', () => {
  it('reads every retained server CPU via a fixed executeJavaScript selector on .brand .logo data-cpu-pct', () => {
    expect(desktopSource).toContain(
      "document.querySelector('.brand .logo')?.dataset.cpuPct",
    );
    expect(desktopSource).toContain('executeJavaScript(REMOTE_CPU_SCRIPT)');
    // The script is a fixed constant — page data is never interpolated into it.
    expect(desktopSource).toContain('const REMOTE_CPU_SCRIPT = `(() => {');
  });

  it('gates the taskbar progress: cpu above 50 -> cpu/100, at or below 50 -> clear (-1), clamped defensively', () => {
    expect(desktopSource).toMatch(/Math\.min\(100, Math\.max\(0, raw\w*\)/);
    expect(desktopSource).toContain(
      'setProgressBar(next !== null && next > 50 ? next / 100 : -1)',
    );
    expect(desktopSource).toContain('setProgressBar(-1)');
  });

  it('polls every retained view at the remote 2s cadence; the taskbar follows only the selected server', () => {
    const intervalIdx = desktopSource.indexOf('cpuInterval = setInterval');
    expect(intervalIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('pollCpu()', intervalIdx)).toBeGreaterThan(
      intervalIdx,
    );
    expect(desktopSource.indexOf('2_000', intervalIdx)).toBeGreaterThan(
      intervalIdx,
    );
    const pollIdx = desktopSource.indexOf('pollCpu(): void');
    expect(pollIdx).toBeGreaterThan(-1);
    // Every retained view is read (each saved server keeps its own reading).
    expect(
      desktopSource.indexOf('for (const profile of st.profiles)', pollIdx),
    ).toBeGreaterThan(pollIdx);
    expect(
      desktopSource.indexOf('viewByOrigin.get(profile.origin)', pollIdx),
    ).toBeGreaterThan(pollIdx);
    // The taskbar branch applies to the selected server only.
    expect(
      desktopSource.match(
        /profileId !== st\.activeId|profile\.id !== st\.activeId/g,
      ),
    ).not.toBeNull();
  });

  it('clears taskbar progress on active-profile change, destroyed view, missing read, or no active profile', () => {
    // The active-changed subscription deactivates the previous server's
    // progress before the poll re-applies it from the new view.
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    expect(
      desktopSource.indexOf('win.setProgressBar(-1)', subscribeIdx),
    ).toBeGreaterThan(subscribeIdx);
    // A destroyed/no view and a failed or non-finite read clear too.
    const pollIdx = desktopSource.indexOf('pollCpu(): void');
    expect(pollIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('view.webContents.isDestroyed()', pollIdx),
    ).toBeGreaterThan(pollIdx);
    expect(
      desktopSource.indexOf('ctrl.state().activeId !== st.activeId', pollIdx),
    ).toBeGreaterThan(pollIdx);
    expect(
      desktopSource.indexOf('Number.isFinite(cpu)', pollIdx),
    ).toBeGreaterThan(pollIdx);
  });

  it('merges each profile CPU reading into the rail snapshot and clears it when the view or profile is gone', () => {
    // The snapshot carries the per-profile reading (null until observed).
    const pushIdx = desktopSource.indexOf('pushRailState(): void');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('cpu: this.observedCpu.get(p.id) ?? null', pushIdx),
    ).toBeGreaterThan(pushIdx);
    // A destroyed/missing view drops the reading on the next poll.
    const pollIdx = desktopSource.indexOf('pollCpu(): void');
    expect(pollIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('observedCpu.delete(profile.id)', pollIdx),
    ).toBeGreaterThan(pollIdx);
    // Profile removal clears the reading alongside the observed identity.
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:remove-profile'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('observedCpu.delete(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });

  it('polls health every 30 seconds as documented', () => {
    const intervalIdx = desktopSource.indexOf('healthInterval = setInterval');
    expect(intervalIdx).toBeGreaterThan(-1);
    expect(desktopSource.indexOf('30_000', intervalIdx)).toBeGreaterThan(
      intervalIdx,
    );
  });

  it('clears the CPU poll interval on before-quit alongside the health poll', () => {
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('clearInterval(this.cpuInterval)', beforeQuitIdx),
    ).toBeGreaterThan(beforeQuitIdx);
    expect(
      desktopSource.indexOf(
        'clearInterval(this.healthInterval)',
        beforeQuitIdx,
      ),
    ).toBeGreaterThan(beforeQuitIdx);
  });

  it('observes CPU through executeJavaScript only, with no preload or IPC on remote origins', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    expect(factoryRegion).toContain('viewByOrigin.set(origin, view)');
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
  });

  it('keeps the taskbar CPU poll out of smoke mode (no real setProgressBar in the harness)', () => {
    const smokeIdx = desktopSource.indexOf('if (SMOKE)');
    const intervalIdx = desktopSource.indexOf('cpuInterval = setInterval');
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(intervalIdx).toBeGreaterThan(smokeIdx);
  });
});

describe('src/desktop.ts (desktop-local file actions)', () => {
  it('installs the gesture listeners on every profile view via executeJavaScript at did-finish-load', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    const loadIdx = factoryRegion.indexOf("'did-finish-load'");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(
      factoryRegion.indexOf(
        'executeJavaScript(INSTALL_FILE_ACTION_SCRIPT)',
        loadIdx,
      ),
    ).toBeGreaterThan(loadIdx);
    expect(factoryRegion).toContain('pushRailState();');
  });

  it('polls only the ACTIVE retained view with the fixed read-and-clear script', () => {
    const pollIdx = desktopSource.indexOf('pollFileAction(): void');
    expect(pollIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('READ_FILE_ACTION_SCRIPT', pollIdx),
    ).toBeGreaterThan(pollIdx);
    // Only the active profile's view is read (find by activeId, resolve the origin's retained view).
    expect(
      desktopSource.indexOf(
        'st.profiles.find((p) => p.id === st.activeId)',
        pollIdx,
      ),
    ).toBeGreaterThan(pollIdx);
    expect(
      desktopSource.indexOf('viewByOrigin.get(profile.origin)', pollIdx),
    ).toBeGreaterThan(pollIdx);
    // Results are validated before any OS action.
    expect(
      desktopSource.indexOf('parseFileAction(raw)', pollIdx),
    ).toBeGreaterThan(pollIdx);
  });

  it('resolves the local path and gates every action on a local exists check', () => {
    const runIdx = desktopSource.indexOf('async runFileAction');
    expect(runIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('path.resolve(action.cwd, action.rel)', runIdx),
    ).toBeGreaterThan(runIdx);
    expect(
      desktopSource.indexOf('existsSync(localPath)', runIdx),
    ).toBeGreaterThan(runIdx);
  });

  it('opens via the OS shell only: shell.openPath for open, shell.showItemInFolder for folder', () => {
    const runIdx = desktopSource.indexOf('async runFileAction');
    expect(runIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('shell.openPath(localPath)', runIdx),
    ).toBeGreaterThan(runIdx);
    expect(
      desktopSource.indexOf('shell.showItemInFolder(localPath)', runIdx),
    ).toBeGreaterThan(runIdx);
  });

  it('toasts failures in the page and never toasts successful opens', () => {
    const toastIdx = desktopSource.indexOf('toastFileActionFailure');
    expect(toastIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('executeJavaScript(toastErrorScript', toastIdx),
    ).toBeGreaterThan(toastIdx);
    const runIdx = desktopSource.indexOf('async runFileAction');
    const runEndIdx = desktopSource.indexOf('pollFileAction(): void', runIdx);
    const runRegion = desktopSource.slice(runIdx, runEndIdx);
    expect(runRegion).toContain("'not found on this machine'");
    expect(runRegion).toContain('shell.openPath(localPath)');
    expect(runRegion).toContain('shell.showItemInFolder(localPath)');
    // Failure feedback goes through toastFileActionFailure; the success branches carry no toast.
    expect(runRegion).not.toContain('executeJavaScript(toastErrorScript');
  });

  it('keeps the file-action poll out of smoke mode and tears it down on before-quit', () => {
    const smokeIdx = desktopSource.indexOf('if (SMOKE)');
    const intervalIdx = desktopSource.indexOf(
      'fileActionInterval = setInterval',
    );
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(intervalIdx).toBeGreaterThan(smokeIdx);
    expect(
      desktopSource.indexOf('FILE_ACTION_POLL_MS', intervalIdx),
    ).toBeGreaterThan(intervalIdx);
    const beforeQuitIdx = desktopSource.indexOf("app.on('before-quit'");
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'clearInterval(this.fileActionInterval)',
        beforeQuitIdx,
      ),
    ).toBeGreaterThan(beforeQuitIdx);
  });

  it('uses executeJavaScript only — the view factory keeps no preload or IPC on remote origins', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    expect(factoryRegion).toContain(
      'executeJavaScript(INSTALL_FILE_ACTION_SCRIPT)',
    );
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
    // No remote OS/filesystem layer, path translation, or proxying is introduced.
    expect(desktopSource).not.toContain('net.request');
    expect(desktopSource).not.toContain('session.fetch');
  });
});

describe('src/desktop.ts (native window chrome + branding)', () => {
  it('replaces the default Electron menu with the Phi menu: null on non-darwin, minimal Phi menu on darwin', () => {
    const menuIdx = desktopSource.indexOf('installAppMenu(): void');
    expect(menuIdx).toBeGreaterThan(-1);
    expect(desktopSource).toContain('Menu.setApplicationMenu(null)');
    expect(desktopSource).toContain("process.platform !== 'darwin'");
    // The darwin template carries no generic File/View boilerplate.
    const menuRegion = desktopSource.slice(
      menuIdx,
      desktopSource.indexOf('createMainWindow(): BrowserWindow', menuIdx),
    );
    expect(menuRegion).not.toContain("role: 'fileMenu'");
    expect(menuRegion).not.toContain("role: 'viewMenu'");
    // macOS keeps the system menu bar functional (app menu + edit menu for clipboard + window menu).
    expect(menuRegion).toContain("{ role: 'editMenu' }");
    expect(menuRegion).toContain("{ role: 'windowMenu' }");
    expect(menuRegion).toContain("role: 'about'");
    expect(menuRegion).toContain("role: 'quit'");
  });

  it('installs the menu inside whenReady before the main window is created', () => {
    // main.ts hands control to host.start() from whenReady; inside the host
    // the menu is installed before the main window is created.
    const readyIdx = mainSource.indexOf('app.whenReady');
    expect(readyIdx).toBeGreaterThan(-1);
    expect(mainSource.indexOf('host.start(', readyIdx)).toBeGreaterThan(
      readyIdx,
    );
    const installIdx = desktopSource.indexOf('installAppMenu()');
    const createIdx = desktopSource.indexOf('createMainWindow()');
    expect(installIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(createIdx);
  });

  it('sets the main window icon to the generated Phi icon (APP_ICON_PATH)', () => {
    const windowIdx = desktopSource.indexOf('const win = new BrowserWindow({');
    expect(windowIdx).toBeGreaterThan(-1);
    // The icon option sits inside the window options block.
    const windowEnd = desktopSource.indexOf("win.on('close'", windowIdx);
    const windowRegion = desktopSource.slice(windowIdx, windowEnd);
    expect(windowRegion).toContain('icon: APP_ICON_PATH');
    // The path resolves to the multi-size .ico so the Windows shell
    // (taskbar, Alt-Tab) picks the closest pre-rendered layer at
    // every DPI rather than downscaling a single PNG.
    expect(desktopSource).toContain("'assets', 'icon.ico'");
  });
});

describe('electron-builder.json (native branding)', () => {
  it('packages the runtime assets used by the desktop host', () => {
    const builder = JSON.parse(
      readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'),
    ) as {
      files?: string[];
    };
    expect(builder.files).toContain('assets/**');
  });

  it('points win.icon at the generated 256px icon asset without adding build targets', () => {
    const builder = JSON.parse(
      readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'),
    ) as {
      win?: { icon?: string };
    };
    expect(builder.win).toEqual({ icon: 'assets/icon.png' });
  });

  it('uses phi-client for both the packaged app and release artifacts', () => {
    const builder = JSON.parse(
      readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'),
    ) as {
      productName?: string;
      artifactName?: string;
    };
    expect(builder.productName).toBe('phi-client');
    expect(builder.artifactName).toBe(
      'phi-client-${version}-${os}-${arch}.${ext}',
    );
  });
});

describe('src/desktop.ts (sync board desktop alerts)', () => {
  it('defines the PHI_NOTIF / PHI_ALARM marker prefixes with the trailing space the remote page writes', () => {
    expect(desktopSource).toContain("const SYNC_NOTIF_MARKER = 'PHI_NOTIF ';");
    expect(desktopSource).toContain("const SYNC_ALARM_MARKER = 'PHI_ALARM ';");
  });

  it('detects the marker prefixes in onProfileTitleUpdated and skips the attention path', () => {
    const markerIdx = desktopSource.indexOf('const SYNC_NOTIF_MARKER');
    expect(markerIdx).toBeGreaterThan(-1);
    const titleIdx = desktopSource.indexOf('onProfileTitleUpdated(');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('title.startsWith(SYNC_NOTIF_MARKER)', titleIdx),
    ).toBeGreaterThan(titleIdx);
    expect(
      desktopSource.indexOf('title.startsWith(SYNC_ALARM_MARKER)', titleIdx),
    ).toBeGreaterThan(titleIdx);
    // A marker must never reach the ● attention transition (it must not
    // clear an existing unread state), so both marker branches return.
    const markedIdx = desktopSource.indexOf(
      'const marked = title.startsWith(TITLE_MARKER)',
      titleIdx,
    );
    const notifIdx = desktopSource.indexOf('this.onSyncAlert(', titleIdx);
    expect(notifIdx).toBeGreaterThan(-1);
    expect(notifIdx).toBeLessThan(markedIdx);
    expect(desktopSource.indexOf('return;', notifIdx)).toBeGreaterThan(
      notifIdx,
    );
  });

  it('gates the alert on the opt-in syncAlerts preference and dedupes by key within a per-profile set', () => {
    expect(desktopSource).toContain(
      '!(this.controller?.state().syncAlerts ?? true)',
    );
    expect(desktopSource).toContain(
      'firedSyncKeys = new Map<string, Set<string>>();',
    );
    expect(desktopSource).toContain('seen.has(key)');
  });

  it('notifies with the profile title, the Sync: <key> body and a distinct alarm label, then flashes once', () => {
    const alertIdx = desktopSource.indexOf('onSyncAlert(');
    expect(alertIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('title: `Phi · ${profile.name}`', alertIdx),
    ).toBeGreaterThan(alertIdx);
    expect(desktopSource.indexOf('`Sync: ${key}`', alertIdx)).toBeGreaterThan(
      alertIdx,
    );
    expect(
      desktopSource.indexOf('`Sync ALARM: ${key}`', alertIdx),
    ).toBeGreaterThan(alertIdx);
    expect(desktopSource.indexOf('flashFrame(true)', alertIdx)).toBeGreaterThan(
      alertIdx,
    );
  });

  it('clears the taskbar flash and focuses the active view when the main window regains focus', () => {
    const focusIdx = desktopSource.indexOf("win.on('focus'");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('flashFrame(false)', focusIdx),
    ).toBeGreaterThan(focusIdx);
    expect(
      desktopSource.indexOf('view.webContents.focus()', focusIdx),
    ).toBeGreaterThan(focusIdx);
  });

  it('routes the notification click to focusProfile (restore+show+focus, then setActive)', () => {
    expect(desktopSource).toContain(
      "notification.on('click', () => this.focusProfile(profile))",
    );
    const focusIdx = desktopSource.indexOf('focusProfile(');
    expect(focusIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('ctrl.setActive(profile.id)', focusIdx),
    ).toBeGreaterThan(focusIdx);
  });

  it('drops the fired-key set when the profile is removed', () => {
    const handlerIdx = desktopSource.indexOf("ipcMain.on('phi:remove-profile'");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('firedSyncKeys.delete(id)', handlerIdx),
    ).toBeGreaterThan(handlerIdx);
  });

  it('feeds the tray checkbox from the store and routes the toggle intent into setSyncAlerts', () => {
    expect(desktopSource).toContain(
      'getSyncAlerts: () => this.controller?.state().syncAlerts ?? true',
    );
    const toggleIdx = desktopSource.indexOf("case 'toggle-sync-alerts'");
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf(
        'ctrl.setSyncAlerts(!ctrl.getSyncAlerts())',
        toggleIdx,
      ),
    ).toBeGreaterThan(toggleIdx);
  });

  it('rebuilds the tray menu on sync-alerts-changed alongside close-to-tray-changed', () => {
    const subscribeIdx = desktopSource.indexOf('controller.subscribe(');
    const kindIdx = desktopSource.indexOf(
      "event.kind === 'sync-alerts-changed'",
      subscribeIdx,
    );
    expect(kindIdx).toBeGreaterThan(subscribeIdx);
    expect(
      desktopSource.indexOf('trayHandle?.rebuildMenu()', kindIdx),
    ).toBeGreaterThan(kindIdx);
  });

  it('keeps the alert observation on the existing page-title-updated path with no preload or IPC on remote origins', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    expect(factoryRegion).toContain("'page-title-updated'");
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
    // No new remote channel: the alert rides the existing title observation.
    expect(desktopSource).not.toContain("'phi:sync-alert'");
  });
});

describe('src/desktop.ts (sync board alarm chime)', () => {
  it('triggers the chime for the ALARM marker only, after the opt-in gate, in onSyncAlert', () => {
    const alertIdx = desktopSource.indexOf('onSyncAlert(');
    expect(alertIdx).toBeGreaterThan(-1);
    const afterAlert = desktopSource.slice(alertIdx);
    const optInIdx = afterAlert.indexOf(
      '!(this.controller?.state().syncAlerts ?? true)',
    );
    const chimeIdx = afterAlert.indexOf('if (alarm) this.playAlarmChime()');
    expect(optInIdx).toBeGreaterThan(-1);
    expect(chimeIdx).toBeGreaterThan(optInIdx);
    expect(afterAlert.match(/playAlarmChime/g)).toEqual(['playAlarmChime']);
  });

  it('executes the fixed chime script on the RAIL view via executeJavaScript, with no new IPC channel', () => {
    const chimeIdx = desktopSource.indexOf('playAlarmChime(): void');
    expect(chimeIdx).toBeGreaterThan(-1);
    expect(
      desktopSource.indexOf('executeJavaScript(', chimeIdx),
    ).toBeGreaterThan(chimeIdx);
    expect(
      desktopSource.indexOf(
        'PLAY_ALARM_CHIME_SCRIPT(ALARM_CHIME_URL)',
        chimeIdx,
      ),
    ).toBeGreaterThan(chimeIdx);
    expect(desktopSource).not.toContain("'phi:alarm-chime'");
  });

  it('resolves the bell asset as an absolute file:// URL beside the tray icon asset', () => {
    expect(desktopSource).toMatch(
      /const ALARM_CHIME_URL = pathToFileURL\(\s*path\.join\(here, '\.\.', 'assets', 'bell\.wav'\),\s*\)\.href;/,
    );
  });

  it('guards a destroyed rail view and rate-limits rapid re-fires to one burst at a time', () => {
    expect(desktopSource).toContain('const ALARM_CHIME_BURST_MS = 3_000;');
    expect(desktopSource).toContain('lastAlarmChimeAt = 0;');
    const chimeIdx = desktopSource.indexOf('playAlarmChime(): void');
    expect(
      desktopSource.indexOf('rail.webContents.isDestroyed()', chimeIdx),
    ).toBeGreaterThan(chimeIdx);
    expect(
      desktopSource.indexOf(
        'now - this.lastAlarmChimeAt < ALARM_CHIME_BURST_MS',
        chimeIdx,
      ),
    ).toBeGreaterThan(chimeIdx);
    expect(
      desktopSource.indexOf('lastAlarmChimeAt = now;', chimeIdx),
    ).toBeGreaterThan(chimeIdx);
  });

  it('never steals focus in the chime path', () => {
    const chimeIdx = desktopSource.indexOf('playAlarmChime(): void');
    const alertIdx = desktopSource.indexOf('onSyncAlert(', chimeIdx);
    const chimeRegion = desktopSource.slice(chimeIdx, alertIdx);
    expect(chimeRegion).not.toMatch(/focus/);
  });
});

describe('src/desktop.ts (rail-selection shortcuts)', () => {
  it('imports the shortcuts module and attaches before-input-event in the production view factory only (smoke-gated)', () => {
    expect(desktopSource).toContain('ALWAYS_SAFE_RAIL_CHORDS');
    expect(desktopSource).toContain('TERMINAL_FOCUS_SCRIPT');
    expect(desktopSource).toContain('resolveRailChord');
    const smokeIdx = desktopSource.indexOf('if (SMOKE)');
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    expect(makeViewIdx).toBeGreaterThan(-1);
    expect(makeViewIdx).toBeGreaterThan(smokeIdx);
    const makeViewEndIdx = desktopSource.indexOf('return view;', makeViewIdx);
    const factoryRegion = desktopSource.slice(makeViewIdx, makeViewEndIdx);
    expect(factoryRegion).toMatch(/["']before-input-event["']/);
    expect(factoryRegion).toContain('ALWAYS_SAFE_RAIL_CHORDS.has(input.key)');
    expect(factoryRegion).toContain('TERMINAL_FOCUS_SCRIPT');
    expect(factoryRegion).not.toContain('preload:');
    expect(factoryRegion).not.toContain('ipcMain.');
  });

  it('preventDefaults the always-safe digits synchronously and switches through controller.setActive', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const listenerIdx = desktopSource.indexOf(
      'before-input-event',
      makeViewIdx,
    );
    expect(listenerIdx).toBeGreaterThan(-1);
    const listenerRegion = desktopSource.slice(
      listenerIdx,
      desktopSource.indexOf('return view;', listenerIdx),
    );
    expect(listenerRegion).toMatch(/input\.type !== ["']keyDown["']/);
    // Shift is allowed at the outer guard so Ctrl+Shift+Tab can resolve
    // to prev; the resolver rejects Shift for digits.
    expect(listenerRegion).toContain(
      '!input.control || input.alt || input.meta',
    );
    expect(listenerRegion).toContain(
      'resolveRailChord(input, profiles.length)',
    );
    expect(listenerRegion).toContain('ALWAYS_SAFE_RAIL_CHORDS.has(input.key)');
    expect(listenerRegion).toContain('event.preventDefault()');
    expect(listenerRegion).toContain(
      'ctrl.setActive(profiles[target.index].id)',
    );
    // The always-safe preventDefault precedes the conditional probe.
    expect(
      listenerRegion.indexOf('ALWAYS_SAFE_RAIL_CHORDS.has(input.key)'),
    ).toBeLessThan(listenerRegion.indexOf('TERMINAL_FOCUS_SCRIPT'));
  });

  it('never preventDefaults the conditional chords and gates them on the terminal-focus probe', () => {
    const makeViewIdx = desktopSource.indexOf(
      'const makeView = (origin: string): WebContentsView => {',
    );
    const listenerIdx = desktopSource.indexOf(
      'before-input-event',
      makeViewIdx,
    );
    const listenerRegion = desktopSource.slice(
      listenerIdx,
      desktopSource.indexOf('return view;', listenerIdx),
    );
    expect(listenerRegion).toContain(
      'executeJavaScript(TERMINAL_FOCUS_SCRIPT)',
    );
    expect(listenerRegion).toContain('if (raw === true) return;');
    expect(listenerRegion).toContain('const step = target.kind ===');
    // The only preventDefault sits inside the always-safe branch: after
    // the membership guard, before the conditional probe.
    const guardIdx = listenerRegion.indexOf(
      'ALWAYS_SAFE_RAIL_CHORDS.has(input.key)',
    );
    const preventIdx = listenerRegion.indexOf('event.preventDefault()');
    const probeIdx = listenerRegion.indexOf('TERMINAL_FOCUS_SCRIPT');
    expect(preventIdx).toBeGreaterThan(guardIdx);
    expect(preventIdx).toBeLessThan(probeIdx);
    expect(
      listenerRegion.indexOf('executeJavaScript', probeIdx),
    ).toBeGreaterThan(preventIdx);
  });

  it('keeps protected chords, terminal control chords and Ctrl+L unbound (no new interception)', () => {
    expect(ALWAYS_SAFE_RAIL_CHORDS.size).toBe(3);
    expect(CONDITIONAL_RAIL_CHORDS.size).toBe(7);
    for (const key of [
      '+',
      '-',
      '0',
      'r',
      'R',
      'F5',
      'w',
      'W',
      't',
      'T',
      'Escape',
      'l',
      'L',
      'c',
      'o',
      'p',
    ]) {
      expect(ALWAYS_SAFE_RAIL_CHORDS.has(key)).toBe(false);
      expect(CONDITIONAL_RAIL_CHORDS.has(key)).toBe(false);
    }
    expect(desktopSource).not.toContain("'phi:palette'");
    expect(desktopSource).not.toContain("'CommandOrControl+L'");
  });
});
