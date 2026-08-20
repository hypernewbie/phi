/**
 * phi-desktop host loop.
 *
 * DesktopHost owns every desktop-only orchestration concern: the main
 * window and its title-row chrome, the tray bridge, the retained
 * per-profile views and the rail renderer, controlled page-state
 * observation (identity, CPU, file gestures, divider layout),
 * notifications, taskbar state, native file actions, rail-selection
 * shortcuts and the close-to-tray lifecycle. The focused primitives
 * (controller.ts, views.ts, tray.ts, hotkeys.ts, injected.ts,
 * shortcuts.ts) stay separate; this class is the bridge that wires them
 * together. main.ts is the thin boot/wiring layer that owns the
 * protocol-registration flags, the single-instance gate and the
 * deeplink IPC relay, then hands control to `host.start()`.
 *
 * Security defaults (non-negotiable):
 *   - nodeIntegration: false
 *   - contextIsolation: true
 *   - sandbox: true
 *   - webSecurity: true
 *   - local pages load via `loadFile`; remote profile origins are
 *     sandboxed WebContentsView children with no preload bridge.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  session,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProfileViewManager } from './views.js';
import { AccessAuth } from './access-auth.js';
import type {
  ActiveServer,
  HeaderAction,
  HeaderState,
  RailState,
} from './electron.js';
import {
  classifyArgv,
  FORWARD_CHANNEL,
  type SingleInstanceHandle,
} from './single-instance.js';
import { parseDeepLink, dispatchDeepLink } from './deeplink.js';
import {
  Controller,
  parseEndpoint,
  type HealthChecker,
  type ProfileMeta,
} from './controller.js';
import {
  registerHotkey,
  resolveAccelerator,
  type HotkeyRegistration,
} from './hotkeys.js';
import {
  setupTray,
  TRAY_COMMAND_CHANNEL,
  TRAY_ICON_PATH,
  type TrayCommand,
  type TrayDeps,
  type TrayHandle,
} from './tray.js';
import {
  INSTALL_FILE_ACTION_SCRIPT,
  READ_FILE_ACTION_SCRIPT,
  parseFileAction,
  toastErrorScript,
  READ_DIVIDERS_SCRIPT,
  applyDividersScript,
  parseDividers,
  PLAY_ALARM_CHIME_SCRIPT,
  headerActionClickScript,
  setWorkspaceScript,
  READ_WORKSPACE_SCRIPT,
  bodyAuthLoginScript,
} from './injected.js';
import type { FileAction, Dividers } from './injected.js';
import { installFullscreenToggle } from './fullscreen.js';
import { installReloadShortcut } from './reload.js';
import { installZoomShortcuts } from './zoom.js';
import {
  ALWAYS_SAFE_RAIL_CHORDS,
  TERMINAL_FOCUS_SCRIPT,
  resolveRailChord,
} from './shortcuts.js';
import { iconResolver } from './appicon.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Phi application/window icon. Windows shell surfaces (taskbar,
 *  Alt-Tab, shortcut overlays) prefer a multi-size .ico so the
 *  compositor can pick the closest pre-rendered size at every DPI
 *  rather than downscaling a single PNG, which is what causes the
 *  aliased look in the taskbar. The .ico ships with 16/24/32/48/64/
 *  128/256 entries rendered through GDI+ at native resolution, with
 *  proper antialiasing at each size. The 256x256 PNG is retained
 *  as the fallback for surfaces that don't accept .ico. */
const APP_ICON_PATH =
  process.platform === 'win32'
    ? path.join(here, '..', 'assets', 'icon.ico')
    : path.join(here, '..', 'assets', 'icon.png');

/** Smoke mode is driven by the e2e harness (test/smoke.test.ts, `pnpm run smoke`). */
const SMOKE = process.env.PHI_DESKTOP_SMOKE === '1';

/** The rail gutter width (px) — the rail view's width. */
export const RAIL_WIDTH = 72;

/** Single-row header height (px): the main view page's vendored header row. */
export const HEADER_HEIGHT = 48;

/** '● ' title prefix from the remote app signals unread on the selected profile. */
const TITLE_MARKER = '● ';

// Sync Board desktop-alert markers, observed as transient remote page
// titles (see web-src/sync.ts). The trailing space is part of the
// marker: the remote page writes 'PHI_NOTIF <key>' / 'PHI_ALARM <key>'.
const SYNC_NOTIF_MARKER = 'PHI_NOTIF ';
const SYNC_ALARM_MARKER = 'PHI_ALARM ';

/** Random unguessable id bound to one in-flight access-auth prompt. */
const randomRequestId = (): string => randomBytes(16).toString('hex');

/** Main-view auth-required push payload — main process -> renderer. */
interface AuthRequired {
  requestId: string;
  profileId: string;
  origin: string;
  label: string;
}

/** Fixed page-observation expression for remote Phi pages (never interpolated). */
const REMOTE_IDENTITY_SCRIPT = `(() => {
  const host = document.getElementById('hostname-display');
  const root = getComputedStyle(document.documentElement);
  return {
    hostname: host ? (host.textContent || '').trim() : '',
    accent: root.getPropertyValue('--accent').trim(),
  };
})()`;

/** Fixed page-observation expression for the remote page's CPU percent (never interpolated). */
const REMOTE_CPU_SCRIPT = `(() => {
  const raw = document.querySelector('.brand .logo')?.dataset.cpuPct;
  if (raw === undefined) return null;
  const cpu = Number(raw);
  return Number.isFinite(cpu) ? cpu : null;
})()`;

/** Fixed page-observation expression for the remote page's terminal-activity state. The
 *  `#terminal-activity-indicator` element is updated by `web/header-state.js`
 *  `applyTerminalActivityIndicator(hasActivity, hostnameKnown)`; reading the
 *  `is-active` class is enough — the body webContents owns the activity
 *  events, the desktop just mirrors them to the main view. */
const REMOTE_ACTIVITY_SCRIPT = `(() => {
  const indicator = document.getElementById('terminal-activity-indicator');
  return indicator ? indicator.classList.contains('is-active') : false;
})()`;

/** Fixed page-observation expression: a guarded click on
 * #hostname-display — the in-page handler toggles the dropdown and
 * renders the active tabs. */
const OPEN_SESSIONS_SCRIPT = `(() => {
  const display = document.getElementById('hostname-display');
  if (!display) return false;
  display.click();
  return true;
})()`;

/** Absolute file:// URL of the alarm bell asset (the local rail page plays it; the desktop package has no web/). */
const ALARM_CHIME_URL = pathToFileURL(
  path.join(here, '..', 'assets', 'bell.wav'),
).href;

/** The full alarm burst window: a re-fire inside it is dropped so bursts never stack on the shared audio element. */
const ALARM_CHIME_BURST_MS = 3_000;

/** The poll cadence for a recorded desktop file-tree gesture. */
const FILE_ACTION_POLL_MS = 250;

/**
 * The real HTTP health checker: probes each profile origin's /healthz
 * endpoint with a 3s timeout — 'up' only on an HTTP ok response, 'down'
 * otherwise (any non-ok status, abort, or fetch/network failure). The
 * controller's default placeholder checker reports 'unknown' for every
 * origin.
 */
const realHealthChecker: HealthChecker = {
  check: async (origin) => {
    try {
      const res = await fetch(new URL('/healthz', origin), {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? 'up' : 'down';
    } catch {
      return 'down';
    }
  },
};

export class DesktopHost {
  // --- Host-loop state ---
  mainWindow: BrowserWindow | null = null;
  // The tray is a pure DI surface (src/tray.ts); the controller is a pure
  // TS surface (src/controller.ts). The host loop is the bridge: the tray
  // never imports the controller and the controller never imports
  // Electron.
  trayHandle: TrayHandle | null = null;
  controller: Controller | null = null;
  // Interval handles (cleared in before-quit so no pending probe outlives
  // the retained views).
  healthInterval: ReturnType<typeof setInterval> | null = null;
  cpuInterval: ReturnType<typeof setInterval> | null = null;
  fileActionInterval: ReturnType<typeof setInterval> | null = null;
  // The retained per-profile view manager + the rail child view.
  profileViews: ProfileViewManager | null = null;
  railView: WebContentsView | null = null;
  // before-quit deferral guard: the first before-quit defers the quit
  // until destroyAll() (and the rail view teardown) completes, then
  // re-quits; the guard keeps the re-entrant before-quit from deferring
  // again.
  viewsTornDown = false;
  // Close-to-tray guard: set in before-quit (which fires before windows
  // close) so explicit quits are never intercepted into a hide-loop.
  quitting = false;
  hotkeyRegistrations: HotkeyRegistration[] = [];
  // Switch-time divider snapshot read from the outgoing active view and
  // applied to the incoming retained view once the switch lands (never
  // persisted — each view keeps its own localStorage).
  pendingDividers: Dividers | null = null;
  /** Retained views that have finished loading (the divider-sync loaded gate). */
  loadedViews = new WeakSet<WebContentsView>();
  /** Per-view '● ' marker state (the attention transition gate). */
  markerPresent = new WeakMap<WebContentsView, boolean>();
  /** In-memory per-profile keys already alerted (session-scoped sync-alert dedupe). */
  firedSyncKeys = new Map<string, Set<string>>();
  /** In-memory per-profile observed remote document title (never persisted). */
  observedTitle = new Map<string, string>();
  /** In-memory per-profile remote identity (never persisted). */
  observedIdentity = new Map<string, { hostname: string; accent: string }>();
  /** Retained per-origin view lookup for the CPU poll (never persisted). */
  viewByOrigin = new Map<string, WebContentsView>();
  /** In-memory per-profile CPU percent from the remote page (never persisted). */
  observedCpu = new Map<string, number>();
  /** In-memory per-profile terminal-activity flag from the remote page
   *  (any tab producing output drives the brand-glow `▍` glyph and the
   *  `phi:header-state` push). Never persisted. */
  observedActivity = new Map<string, boolean>();
  /** Path of the encrypted credential file. Holds the per-origin
   *  PBKDF2 verifiers (rotated server-side) so a subsequent launch can
   *  auto-reauthenticate without prompting for the password. The file
   *  is `safeStorage`-encrypted (DPAPI on Windows, Keychain on macOS,
   *  libsecret on Linux); the on-disk bytes are never usable without
   *  the host process. */
  readonly credentialsPath: string = path.join(
    app.getPath('userData'),
    'access-credentials.bin',
  );
  /** Per-origin verifier persistence (in-memory mirror of the
   *  decrypted file). Cleared when the corresponding origin is removed
   *  or the stored credential fails a server-side rotation check. */
  private readonly storedCredentials = new Map<
    string,
    {
      verifier: Buffer;
      salt: Buffer;
      iterations: number;
      version: 'v1';
      algorithm: 'pbkdf2-sha256';
    }
  >();
  /** Last CPU+activity+workspace push sent to the main view, for change-only
   *  emission. Null until the first push. */
  lastHeaderState: HeaderState | null = null;
  /** Last alarm-chime fire time (the burst rate-limit). */
  lastAlarmChimeAt = 0;

  /** The live main window, or null before/after it exists (the single-instance gate reads it lazily). */
  window(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * Builds the system tray and starts its host loop. Never called in smoke
   * mode.
   */
  startTray(): TrayHandle {
    const deps: TrayDeps = {
      // Read lazily — the controller is built after the tray in start(),
      // so the menu snapshot is taken before the store is read.
      getProfiles: () => {
        const state = this.controller?.state();
        if (!state) return [];
        return state.profiles.map((p) => ({
          ...p,
          health: state.health.get(p.id) ?? 'unknown',
          unread: state.unread.get(p.id) ?? 0,
        }));
      },
      getActiveProfileId: () => this.controller?.state().activeId ?? '',
      getUnread: (id) => this.controller?.state().unread.get(id) ?? 0,
      getCloseToTray: () => this.controller?.state().closeToTray ?? true,
      getSyncAlerts: () => this.controller?.state().syncAlerts ?? true,
      // The intent bridge (the host loop): show foregrounds the main
      // window; select-profile lands in the controller; quit is owned here
      // (log, notify the main window's renderer, then app.quit()).
      ipcSend: (channel, payload) => {
        if (channel !== TRAY_COMMAND_CHANNEL) return;
        const cmd = payload as TrayCommand;
        switch (cmd.kind) {
          case 'show':
            // Bring the main window to the foreground. A close-to-tray
            // window is hidden, not minimized — show() brings it back.
            if (this.mainWindow) {
              if (this.mainWindow.isMinimized()) this.mainWindow.restore();
              this.mainWindow.show();
              this.mainWindow.focus();
            }
            break;
          case 'select-profile': {
            // The Profiles submenu posts {kind:'select-profile', id};
            // unknown ids (a stale menu after a profile removal) are
            // logged and ignored.
            const ctrl = this.controller;
            if (!ctrl) break;
            try {
              ctrl.setActive(cmd.id);
            } catch (err) {
              console.log(
                `phi-desktop: tray select-profile ${cmd.id}: ${String(err)}`,
              );
            }
            break;
          }
          case 'toggle-close-to-tray': {
            // Flip the persisted preference; close-to-tray-changed
            // rebuilds the menu so the checkbox reflects the new state.
            const ctrl = this.controller;
            if (!ctrl) break;
            try {
              ctrl.setCloseToTray(!ctrl.getCloseToTray());
            } catch (err) {
              console.log(
                `phi-desktop: tray toggle-close-to-tray: ${String(err)}`,
              );
            }
            break;
          }
          case 'toggle-sync-alerts': {
            // Flip the persisted preference; sync-alerts-changed rebuilds
            // the menu so the checkbox reflects the new state.
            const ctrl = this.controller;
            if (!ctrl) break;
            try {
              ctrl.setSyncAlerts(!ctrl.getSyncAlerts());
            } catch (err) {
              console.log(
                `phi-desktop: tray toggle-sync-alerts: ${String(err)}`,
              );
            }
            break;
          }
          case 'quit':
            // Log, notify the main window's renderer on the tray channel,
            // then quit.
            console.log('phi-desktop: tray quit');
            if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
              this.mainWindow.webContents.send(TRAY_COMMAND_CHANNEL, cmd);
            }
            app.quit();
            break;
        }
      },
      log: (msg) => console.log(msg),
      iconPath: TRAY_ICON_PATH,
    };
    const tray = setupTray(deps);
    this.trayHandle = tray;
    return tray;
  }

  /**
   * One-time sync of the controller's current profile/unread state into
   * the tray; ongoing updates arrive through the controller subscription.
   * Unread is pushed first so the active profile's tooltip suffix is
   * correct when setActiveProfile then renders it.
   */
  syncTrayFromController(): void {
    const tray = this.trayHandle;
    const ctrl = this.controller;
    if (!tray || !ctrl) return;
    const st = ctrl.state();
    for (const p of st.profiles) tray.setUnread(p.id, st.unread.get(p.id) ?? 0);
    const active = st.profiles.find((p) => p.id === st.activeId) ?? null;
    if (active) tray.setActiveProfile(active);
  }

  /**
   * Routes a server URL (from --server, a forwarded second-launch payload,
   * or the primary's own argv): ensures the URL exists as a profile —
   * added only when no profile matches its normalized origin — then
   * activates it. Guards the controller and the view manager (a second
   * launch can arrive before either is built); every failure is logged,
   * not thrown.
   */
  activateServerUrl(raw: string): void {
    const ctrl = this.controller;
    if (!ctrl) {
      console.log(
        `phi-desktop: activateServerUrl ${raw}: controller not ready`,
      );
      return;
    }
    if (!this.profileViews) {
      console.log(
        `phi-desktop: activateServerUrl ${raw}: profile views not ready`,
      );
      return;
    }
    try {
      const normalized = parseEndpoint(raw);
      let profile =
        ctrl.state().profiles.find((p) => p.origin === normalized.origin) ??
        null;
      if (!profile) {
        profile = ctrl.add(raw);
        this.profileViews.addProfile(profile.id, profile.origin);
      }
      ctrl.setActive(profile.id);
    } catch (err) {
      console.log(`phi-desktop: activateServerUrl ${raw}: ${String(err)}`);
    }
  }

  /**
   * Pushes a fresh phi:rail-state snapshot to the RAIL view's webContents
   * — the renderer that actually renders the rail (the main window's own
   * webContents is a covered blank container and must not receive it).
   * The controller's Maps are flattened to plain records (the renderer's
   * RailState shape).
   */
  pushRailState(): void {
    const ctrl = this.controller;
    const rail = this.railView;
    if (!ctrl || !rail || rail.webContents.isDestroyed()) return;
    const st = ctrl.state();
    const state: RailState = {
      profiles: st.profiles.map((p) => {
        const identity = this.observedIdentity.get(p.id);
        return {
          id: p.id,
          name: p.name,
          origin: p.origin,
          hostname: identity?.hostname ?? '',
          accent: identity?.accent ?? '',
          cpu: this.observedCpu.get(p.id) ?? null,
        };
      }),
      activeId: st.activeId,
      health: Object.fromEntries(st.health),
      unread: Object.fromEntries(st.unread),
    };
    rail.webContents.send('phi:rail-state', state);
  }

  /**
   * Caches the observed hostname/accent for the profile at origin; null
   * while the remote page has reported neither or on failure.
   */
  async observeProfileIdentity(
    view: WebContentsView,
    origin: string,
  ): Promise<{ hostname: string; accent: string } | null> {
    const ctrl = this.controller;
    if (!ctrl || view.webContents.isDestroyed()) return null;
    try {
      const observed = (await view.webContents.executeJavaScript(
        REMOTE_IDENTITY_SCRIPT,
      )) as {
        hostname?: unknown;
        accent?: unknown;
      };
      const profile =
        ctrl.state().profiles.find((p) => p.origin === origin) ?? null;
      if (!profile) return null;
      const identity = {
        hostname:
          typeof observed.hostname === 'string' ? observed.hostname : '',
        accent: typeof observed.accent === 'string' ? observed.accent : '',
      };
      if (identity.hostname === '' && identity.accent === '') return null;
      this.observedIdentity.set(profile.id, identity);
      return identity;
    } catch (err) {
      console.log(`phi-desktop: observe identity ${origin}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Polls each retained profile view's CPU percent AND terminal-activity
   * state. The remote page publishes CPU on `.brand .logo`'s data-cpu-pct
   * (via `web/header-state.js` `applyBrandCpuTier`) and the activity flag
   * on `#terminal-activity-indicator.is-active` (via
   * `applyTerminalActivityIndicator`).
   *
   * Both readings are mirrored to:
   *   - The SELECTED server's Windows taskbar progress indicator (CPU
   *     only, shown above 50%, cleared otherwise).
   *   - The main view page's `.app-header` brand cluster via the
   *     `phi:header-state` IPC push (CPU + activity). The main view's
   *     mainview.js calls the same `web/header-state.js` helpers the
   *     browser Phi page calls, so the desktop TBAR runs the same
   *     code path as the browser Phi header (vendored web single source of
   *     truth).
   *
   * Each saved server keeps its own readings (never aggregated); the
   * rail snapshot is re-pushed only when CPU changes.
   */
  pollCpu(): void {
    const win = this.mainWindow;
    const ctrl = this.controller;
    if (!win || win.isDestroyed() || !ctrl) return;
    const st = ctrl.state();
    for (const profile of st.profiles) {
      const view = this.viewByOrigin.get(profile.origin);
      if (!view || view.webContents.isDestroyed()) {
        // A profile without a live retained view keeps no rail reading.
        if (this.observedCpu.delete(profile.id)) this.pushRailState();
        if (profile.id === st.activeId && !win.isDestroyed()) {
          win.setProgressBar(-1);
          this.pushHeaderState(null, false);
        }
        continue;
      }
      const profileId = profile.id;
      void Promise.all([
        view.webContents.executeJavaScript(REMOTE_CPU_SCRIPT).catch(() => null),
        view.webContents
          .executeJavaScript(REMOTE_ACTIVITY_SCRIPT)
          .catch(() => false),
        view.webContents
          .executeJavaScript(READ_WORKSPACE_SCRIPT)
          .catch(() => null),
      ]).then(([rawCpu, rawActivity, rawWorkspace]) => {
        const cpu =
          typeof rawCpu === 'number' && Number.isFinite(rawCpu)
            ? Math.min(100, Math.max(0, rawCpu))
            : NaN;
        const next = Number.isFinite(cpu) ? cpu : null;
        const prev = this.observedCpu.get(profileId) ?? null;
        if (next === null) this.observedCpu.delete(profileId);
        else this.observedCpu.set(profileId, next);
        const activity = Boolean(rawActivity);
        const prevActivity = this.observedActivity.get(profileId) ?? false;
        if (activity !== prevActivity) {
          if (activity) this.observedActivity.set(profileId, true);
          else this.observedActivity.delete(profileId);
          this.pushRailState();
        }
        if (next !== prev) this.pushRailState();
        // The taskbar progress and the main view TBAR follow the
        // selected server only.
        if (profileId !== st.activeId || win.isDestroyed()) return;
        if (ctrl.state().activeId !== st.activeId) {
          win.setProgressBar(-1);
          return;
        }
        win.setProgressBar(next !== null && next > 50 ? next / 100 : -1);
        const workspace =
          typeof rawWorkspace === 'string' && rawWorkspace !== ''
            ? rawWorkspace
            : null;
        this.pushHeaderState(next, activity, workspace);
      });
    }
  }

  /** Pushes the active server's CPU percent and terminal-activity
   *  flag to the main view page. The main view's mainview.js applies
   *  these via `web/header-state.js` (the same helpers the browser
   *  Phi page calls from `web/terminal.js`). The push is a no-op when
   *  the values haven't changed since the last push (the main view
   *  applies them idempotently).
   *
   *  The main view's TBAR runs without terminal activity events of
   *  its own (no terminals there); without this push the brand
   *  glow stays at idle and the activity indicator stays in its
   *  initial state regardless of what the body is doing. */
  pushHeaderState(
    cpuPercent: number | null,
    terminalActivity: boolean,
    workspace?: string | null,
  ): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const state: HeaderState = {
      cpuPercent,
      terminalActivity,
      workspace: workspace ?? null,
    };
    if (
      this.lastHeaderState !== null &&
      this.lastHeaderState.cpuPercent === state.cpuPercent &&
      this.lastHeaderState.terminalActivity === state.terminalActivity &&
      this.lastHeaderState.workspace === state.workspace
    ) {
      return;
    }
    this.lastHeaderState = state;
    win.webContents.send('phi:header-state', state);
  }

  // ── Access-credential persistence (re-auth across restarts) ─────
  //
  // The browser stores the access verifier in `localStorage` under
  // `phi_access_credential_v1` so a returning user doesn't retype
  // the password every load. The desktop has no localStorage of its
  // own (the main view is `file://`), so we persist the same data on
  // disk, encrypted at rest with `safeStorage` (DPAPI / Keychain /
  // libsecret). On the next launch the host silently re-authenticates
  // the saved origins in the background; the user sees the unlock
  // modal only if the server rotated the credential or if the disk
  // record is corrupted.

  /** Loads the encrypted credential file from disk. Reads a missing
   *  file as "no stored credentials" (the normal first-launch state)
   *  and surfaces a corrupted file as an empty store (a future
   *  successful unlock re-populates it). */
  private loadStoredCredentials(): void {
    if (!existsSync(this.credentialsPath)) return;
    let raw: Buffer;
    try {
      raw = readFileSync(this.credentialsPath);
    } catch {
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    let plaintext: string;
    try {
      plaintext = safeStorage.decryptString(raw);
    } catch {
      // Wrong key, tampered file, or schema mismatch. Wipe so a
      // future unlock starts clean.
      this.storedCredentials.clear();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      this.storedCredentials.clear();
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const entries = (parsed as { origins?: Record<string, unknown> }).origins;
    if (!entries || typeof entries !== 'object') return;
    for (const [origin, raw] of Object.entries(entries)) {
      const c = this.parseStoredCredential(raw);
      if (c) this.storedCredentials.set(origin, c);
    }
  }

  /** Validates and clones one entry of the credential blob. Defensive
   *  against partial / tampered files: a malformed entry is dropped
   *  silently rather than crashing the host. */
  private parseStoredCredential(raw: unknown): {
    verifier: Buffer;
    salt: Buffer;
    iterations: number;
    version: 'v1';
    algorithm: 'pbkdf2-sha256';
  } | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== 'v1' || r.algorithm !== 'pbkdf2-sha256') return null;
    if (typeof r.iterations !== 'number' || !Number.isFinite(r.iterations))
      return null;
    if (
      typeof r.saltBase64 !== 'string' ||
      typeof r.verifierBase64 !== 'string'
    )
      return null;
    const salt = Buffer.from(r.saltBase64, 'base64url');
    const verifier = Buffer.from(r.verifierBase64, 'base64url');
    if (salt.length === 0 || verifier.length !== 32) return null;
    return {
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: r.iterations,
      salt,
      verifier,
    };
  }

  /** Writes the encrypted credential file. Captures a single atomic
   *  snapshot of `this.storedCredentials` so a torn write (kill -9 in
   *  the middle) leaves either the old or the new file, not a half
   *  file. Failures are silent: a missing credentials file is the
   *  normal first-launch state, so a write that fails just means
   *  the next launch re-prompts. */
  private saveStoredCredentials(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const origins: Record<string, unknown> = {};
    for (const [origin, c] of this.storedCredentials) {
      origins[origin] = {
        version: c.version,
        algorithm: c.algorithm,
        iterations: c.iterations,
        saltBase64: c.salt.toString('base64url'),
        verifierBase64: c.verifier.toString('base64url'),
      };
    }
    const plaintext = JSON.stringify({ origins });
    let encrypted: Buffer;
    try {
      encrypted = safeStorage.encryptString(plaintext);
    } catch {
      return;
    }
    try {
      writeFileSync(this.credentialsPath, encrypted);
    } catch {
      // Disk full or permission denied; ignore (next launch will
      // re-prompt, no security loss).
    }
  }

  /** Captures the verifier AccessAuth cached after a successful
   *  password-typed unlock, stores the salt+iterations alongside, and
   *  flushes the encrypted credentials file. Called by the unlock
   *  IPC handler right after a `tryUnlock` returns `ok`. */
  /** Attempts to recover a credential for a local server origin from ~/.phi/config.json.
   *  Allows silent authentication on fresh installs or after app data clears. */
  private tryRecoverLocalCredential(origin: string): {
    verifier: Buffer;
    salt: Buffer;
    iterations: number;
    version: 'v1';
    algorithm: 'pbkdf2-sha256';
  } | null {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase();
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0';
      if (!isLocal) return null;

      const phiConfigPath = path.join(os.homedir(), '.phi', 'config.json');
      if (!existsSync(phiConfigPath)) return null;

      const content = readFileSync(phiConfigPath, 'utf8');
      const cfg = JSON.parse(content) as { password_hash?: string };
      if (!cfg.password_hash || typeof cfg.password_hash !== 'string')
        return null;

      const parts = cfg.password_hash.split('.');
      if (
        parts.length !== 5 ||
        parts[0] !== 'v1' ||
        parts[1] !== 'pbkdf2-sha256'
      )
        return null;

      const iterations = Number(parts[2]);
      if (!Number.isFinite(iterations) || iterations < 1) return null;

      const salt = Buffer.from(parts[3], 'base64url');
      const verifier = Buffer.from(parts[4], 'base64url');
      if (salt.length === 0 || verifier.length !== 32) return null;

      const cred = {
        version: 'v1' as const,
        algorithm: 'pbkdf2-sha256' as const,
        iterations,
        salt,
        verifier,
      };
      this.storedCredentials.set(origin, cred);
      this.saveStoredCredentials();
      return cred;
    } catch {
      return null;
    }
  }

  /** Resolves a stored credential from memory, loading from disk or local config fallback. */
  private getOrRecoverCredential(origin: string): {
    verifier: Buffer;
    salt: Buffer;
    iterations: number;
    version: 'v1';
    algorithm: 'pbkdf2-sha256';
  } | null {
    let cred = this.storedCredentials.get(origin);
    if (!cred) {
      this.loadStoredCredentials();
      cred = this.storedCredentials.get(origin);
    }
    if (!cred) {
      cred = this.tryRecoverLocalCredential(origin) ?? undefined;
    }
    return cred ?? null;
  }

  /** Captures the verifier and trust parameters AccessAuth cached after a successful
   *  unlock, and flushes the encrypted credentials file. Called by the unlock
   *  IPC handler right after a `tryUnlock` returns `ok`. */
  private persistVerifierAfterUnlock(
    origin: string,
    accessAuth: AccessAuth,
  ): void {
    const cred = accessAuth.getLastCredential(origin);
    if (cred) {
      this.storedCredentials.set(origin, {
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations: cred.iterations,
        salt: Buffer.from(cred.salt),
        verifier: Buffer.from(cred.verifier),
      });
      this.saveStoredCredentials();
      return;
    }
    const verifier = accessAuth.getLastVerifier(origin);
    if (!verifier) return;
    void this.fetchAuthStatusForPersistence(origin).then((status) => {
      if (!status) return;
      this.storedCredentials.set(origin, {
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations: status.iterations,
        salt: status.salt,
        verifier: Buffer.from(verifier),
      });
      this.saveStoredCredentials();
    });
  }

  /** Best-effort status read for credential persistence. */
  private async fetchAuthStatusForPersistence(
    origin: string,
  ): Promise<{ salt: Buffer; iterations: number } | null> {
    try {
      const res = await fetch(new URL('/api/auth/status', origin), {
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
      if (!res.ok) return null;
      const status = (await res.json()) as {
        enabled?: boolean;
        algorithm?: string;
        iterations?: number;
        salt?: string;
      };
      if (!status.enabled) return null;
      if (status.algorithm !== 'pbkdf2-sha256') return null;
      if (typeof status.iterations !== 'number' || status.iterations < 1)
        return null;
      if (typeof status.salt !== 'string' || status.salt === '') return null;
      return {
        salt: Buffer.from(status.salt, 'base64url'),
        iterations: status.iterations,
      };
    } catch {
      return null;
    }
  }

  /** Drops a persisted credential (e.g. when the user removes a
   *  server profile, or when a re-auth fails because the server
   *  rotated the salt). Writes the file so the entry is gone on
   *  disk, not just in memory. */
  clearStoredCredential(origin: string): void {
    if (this.storedCredentials.delete(origin)) this.saveStoredCredentials();
  }

  /** Re-authenticates an origin from a persisted verifier. Returns
   *  `true` if the re-auth succeeded (the cookie jar is fresh), `false`
   *  if the user must be prompted (no stored credential, the stored
   *  credential is stale, or the server rejected the proof). */
  private async tryReauthWithStoredCredential(
    origin: string,
    accessAuth: AccessAuth,
  ): Promise<boolean> {
    const cred = this.getOrRecoverCredential(origin);
    if (!cred) return false;
    const status = await this.fetchAuthStatusForPersistence(origin);
    if (!status) {
      // Server is offline, starting up, or transient network hiccup.
      // Do not clear the credential!
      return false;
    }
    if (
      status.iterations !== cred.iterations ||
      !status.salt.equals(cred.salt)
    ) {
      this.clearStoredCredential(origin);
      return false;
    }
    const verifierCopy = Buffer.from(cred.verifier);
    try {
      const result = await accessAuth.tryUnlockWithVerifier(
        origin,
        verifierCopy,
      );
      if (result.kind === 'invalid-password') {
        this.clearStoredCredential(origin);
        return false;
      }
      return result.kind === 'ok';
    } finally {
      verifierCopy.fill(0);
    }
  }

  /** Iterates every saved profile at startup and re-authenticates
   *  any that have a persisted credential. Called once during
   *  `start()` after the view manager is ready and before the first
   *  `/api/config` poll. */
  async bootstrapStoredCredentials(accessAuth: AccessAuth): Promise<void> {
    this.loadStoredCredentials();
    const profiles = this.controller?.state().profiles ?? [];
    for (const p of profiles) {
      if (!this.storedCredentials.has(p.origin)) {
        this.tryRecoverLocalCredential(p.origin);
      }
    }
    if (this.storedCredentials.size === 0) return;
    const origins = Array.from(this.storedCredentials.keys());
    for (const origin of origins) {
      await this.tryReauthWithStoredCredential(origin, accessAuth);
    }
  }

  /** Injects Phi's error toast into the view for a failed local file action. */
  toastFileActionFailure(
    view: WebContentsView,
    action: FileAction,
    reason: string,
  ): void {
    if (view.webContents.isDestroyed()) return;
    void view.webContents
      .executeJavaScript(toastErrorScript(`"${action.rel}" — ${reason}`))
      .catch(() => {});
  }

  /**
   * Opens a recorded file-tree gesture against the local filesystem: the
   * path is resolved from the recorded cwd and gated on a local exists
   * check — a missing local path only toasts in the page.
   */
  async runFileAction(
    action: FileAction,
    view: WebContentsView,
  ): Promise<void> {
    const localPath = path.resolve(action.cwd, action.rel);
    if (!existsSync(localPath)) {
      this.toastFileActionFailure(view, action, 'not found on this machine');
      return;
    }
    if (action.kind === 'open') {
      try {
        const err = await shell.openPath(localPath);
        if (err) this.toastFileActionFailure(view, action, err);
      } catch (err) {
        this.toastFileActionFailure(view, action, String(err));
      }
    } else {
      shell.showItemInFolder(localPath);
    }
  }

  /**
   * Polls the ACTIVE retained view for a recorded file-tree gesture
   * (window.__phiFileAction, read-and-cleared) and runs it — or toasts the
   * failure in the page.
   */
  pollFileAction(): void {
    const ctrl = this.controller;
    const win = this.mainWindow;
    if (!ctrl || !win || win.isDestroyed()) return;
    const st = ctrl.state();
    const profile = st.profiles.find((p) => p.id === st.activeId) ?? null;
    if (!profile) return;
    const view = this.viewByOrigin.get(profile.origin);
    if (!view || view.webContents.isDestroyed()) return;
    void view.webContents.executeJavaScript(READ_FILE_ACTION_SCRIPT).then(
      (raw) => {
        const action = parseFileAction(raw);
        if (action) void this.runFileAction(action, view);
      },
      () => {
        /* the view navigated away mid-read */
      },
    );
  }

  /** Applies the captured divider snapshot to the incoming view — immediately
   *  when it has finished loading, else on its first did-finish-load — and
   *  clears the transient. */
  applyPendingDividers(targetId: string): void {
    const pending = this.pendingDividers;
    if (pending === null) return;
    this.pendingDividers = null;
    if (pending.left === null && pending.right === null) return;
    const view = this.profileViews?.getView(targetId) ?? null;
    if (!view || view.webContents.isDestroyed()) return;
    const apply = (): void => {
      if (view.webContents.isDestroyed()) return;
      void view.webContents
        .executeJavaScript(applyDividersScript(pending.left, pending.right))
        .catch(() => {});
    };
    if (this.loadedViews.has(view)) apply();
    else view.webContents.once('did-finish-load', apply);
  }

  /** Opens a profile's own session selector on its retained view —
   * immediately when loaded, else on its first did-finish-load (the
   * loadedViews gate). */
  openServerSessions(id: string): void {
    const view = this.profileViews?.getView(id) ?? null;
    if (!view || view.webContents.isDestroyed()) return;
    const open = (): void => {
      if (view.webContents.isDestroyed()) return;
      void view.webContents
        .executeJavaScript(OPEN_SESSIONS_SCRIPT)
        .catch(() => {});
    };
    if (this.loadedViews.has(view)) open();
    else view.webContents.once('did-finish-load', open);
  }

  /** Switch-time divider sync: reads the OUTGOING active view's persisted
   *  divider widths before the switch hides it, so the incoming retained
   *  view adopts the same layout once the read resolves (after setActive). */
  syncDividersOnSwitch(incomingId: string): void {
    this.pendingDividers = null;
    const outgoingId = this.profileViews?.getActive() ?? null;
    const outgoing =
      outgoingId === null
        ? null
        : (this.profileViews?.getView(outgoingId) ?? null);
    if (!outgoing || outgoing.webContents.isDestroyed()) return;
    void outgoing.webContents.executeJavaScript(READ_DIVIDERS_SCRIPT).then(
      (raw) => {
        this.pendingDividers = parseDividers(raw);
        this.applyPendingDividers(incomingId);
      },
      () => {},
    );
  }

  isFocusedVisibleProfile(profileId: string): boolean {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized() || !win.isFocused()) return false;
    const ctrl = this.controller;
    return ctrl !== null && ctrl.state().activeId === profileId;
  }

  /** Foregrounds the main window and activates the profile (notification click contract). */
  focusProfile(profile: ProfileMeta): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.show();
      this.mainWindow.focus();
    }
    const ctrl = this.controller;
    if (!ctrl) return;
    try {
      ctrl.setActive(profile.id);
    } catch (err) {
      console.log(
        `phi-desktop: notification click ${profile.id}: ${String(err)}`,
      );
    }
  }

  showTerminalDone(profile: ProfileMeta): void {
    const notification = new Notification({
      title: `Phi · ${profile.name}`,
      body: 'Terminal done',
    });
    notification.on('click', () => this.focusProfile(profile));
    notification.show();
  }

  /** Plays the Sync Board alarm chime on the rail view — the one local loadFile page that can play audio. */
  playAlarmChime(): void {
    const rail = this.railView;
    if (!rail || rail.webContents.isDestroyed()) return;
    const now = Date.now();
    if (now - this.lastAlarmChimeAt < ALARM_CHIME_BURST_MS) return;
    this.lastAlarmChimeAt = now;
    void rail.webContents
      .executeJavaScript(PLAY_ALARM_CHIME_SCRIPT(ALARM_CHIME_URL))
      .catch(() => {});
  }

  /**
   * Fires a Sync Board desktop alert observed in the remote page title:
   * PHI_NOTIF -> native notification, one taskbar flash, rail attention;
   * PHI_ALARM -> the same with a distinct alarm body label plus the
   * bounded alarm chime on the rail view. Gated on the opt-in syncAlerts
   * preference and deduped by key within the profile — a repeat of the
   * same key does not re-fire, a new key does. The marker is untrusted
   * display data only and never triggers a remote action.
   */
  onSyncAlert(profile: ProfileMeta, marker: string, key: string): void {
    if (!(this.controller?.state().syncAlerts ?? true)) return;
    let seen = this.firedSyncKeys.get(profile.id);
    if (!seen) {
      seen = new Set<string>();
      this.firedSyncKeys.set(profile.id, seen);
    }
    if (seen.has(key)) return;
    seen.add(key);
    const alarm = marker === SYNC_ALARM_MARKER;
    const notification = new Notification({
      title: `Phi · ${profile.name}`,
      body: alarm ? `Sync ALARM: ${key}` : `Sync: ${key}`,
    });
    notification.on('click', () => this.focusProfile(profile));
    notification.show();
    if (this.mainWindow && !this.mainWindow.isDestroyed())
      this.mainWindow.flashFrame(true);
    this.controller?.setUnread(profile.id, 1);
    if (alarm) this.playAlarmChime();
  }

  onProfileTitleUpdated(
    view: WebContentsView,
    origin: string,
    title: string,
  ): void {
    const ctrl = this.controller;
    if (!ctrl) return;
    const profile =
      ctrl.state().profiles.find((p) => p.origin === origin) ?? null;
    if (!profile) return;
    this.observedTitle.set(profile.id, title);
    this.refreshWindowTitle();
    // Sync Board alert markers are transient page titles (the
    // terminal-activity updater rewrites them on the next tick). React to
    // the first observation and skip the attention path so a marker never
    // clears an existing unread state.
    if (title.startsWith(SYNC_NOTIF_MARKER)) {
      this.onSyncAlert(
        profile,
        SYNC_NOTIF_MARKER,
        title.slice(SYNC_NOTIF_MARKER.length),
      );
      return;
    }
    if (title.startsWith(SYNC_ALARM_MARKER)) {
      this.onSyncAlert(
        profile,
        SYNC_ALARM_MARKER,
        title.slice(SYNC_ALARM_MARKER.length),
      );
      return;
    }
    const marked = title.startsWith(TITLE_MARKER);
    const prev = this.markerPresent.get(view) ?? false;
    if (marked === prev) return; // not a marker transition
    this.markerPresent.set(view, marked);
    if (marked) {
      ctrl.setUnread(profile.id, 1);
      if (!this.isFocusedVisibleProfile(profile.id))
        this.showTerminalDone(profile);
    } else {
      ctrl.setUnread(profile.id, 0);
    }
  }

  /** Window/taskbar title from the SELECTED profile's observed title + hostname ('Phi' before any observation). */
  refreshWindowTitle(): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const activeId = this.controller?.state().activeId ?? '';
    const title = this.observedTitle.get(activeId) ?? '';
    const identity = this.observedIdentity.get(activeId);
    if (title === '' || !identity || identity.hostname === '') {
      win.setTitle('Phi');
      this.pushMainViewTitle('');
      return;
    }
    const marked = title.startsWith(TITLE_MARKER);
    const rest = marked ? title.slice(TITLE_MARKER.length) : title;
    const glyph = rest.startsWith('ϕ') ? 'ϕ' : 'Φ';
    win.setTitle(
      `${marked ? TITLE_MARKER : ''}${glyph} Phi — ${identity.hostname.toUpperCase()}`,
    );
    // The main view page renders the marker-stripped remote title.
    this.pushMainViewTitle(rest);
  }

  /** Mirrors the observed remote title to the main view page (channel 'phi:window-title'). */
  pushMainViewTitle(title: string): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('phi:window-title', title);
  }

  /** Pushes the window's maximize/focus state to the main view page (channel 'phi:window-state'). */
  pushWindowState(): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('phi:window-state', {
      isMaximized: win.isMaximized(),
      focused: win.isFocused(),
    });
  }

  /** Pushes the SELECTED server's id/origin/observed accent to the main view page (channel 'phi:active-server'). */
  pushActiveServer(): void {
    const win = this.mainWindow;
    const ctrl = this.controller;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || !ctrl)
      return;
    const st = ctrl.state();
    const active = st.profiles.find((p) => p.id === st.activeId) ?? null;
    if (!active) return;
    const identity = this.observedIdentity.get(active.id);
    const info: ActiveServer = {
      id: active.id,
      origin: active.origin,
      accent: identity?.accent ?? '',
    };
    // The window icon follows the active server's accent (same Φ
    // silhouette, accent glyph color); unobserved servers keep the white
    // brand icon.
    if (info.accent !== '') {
      win.setIcon(iconResolver.resolve(info.accent));
    }
    win.webContents.send('phi:active-server', info);
  }

  /**
   * Smoke-mode fake WebContentsView (recording, never touches the GPU):
   * the ProfileViewManager's makeView under PHI_DESKTOP_SMOKE=1 — the
   * same no-real-GUI convention as the tray/hotkey gates: no real
   * WebContentsView or Session is ever constructed by the harness.
   */
  makeSmokeContentView(): WebContentsView {
    return {
      webContents: {
        on: () => {},
        loadURL: () => Promise.resolve(),
        close: () => {},
        focus: () => {},
        isDestroyed: () => false,
      },
      setBounds: () => {},
      setVisible: () => {},
      destroy: () => {},
    } as unknown as WebContentsView;
  }

  /**
   * Smoke self-check: reports what the harness asserts and exits 0/1.
   * Runs only when PHI_DESKTOP_SMOKE=1.
   */
  async runSmokeChecks(win: BrowserWindow): Promise<void> {
    const result: Record<string, unknown> = {
      isBrowserWindow: win instanceof BrowserWindow,
    };
    try {
      const dom = (await win.webContents.executeJavaScript(`(() => {
      const header = document.querySelector('.app-header');
      const bodyArea = document.getElementById('body-area');
      return {
        title: document.title,
        header: !!header,
        headerDrag: header ? getComputedStyle(header).getPropertyValue('-webkit-app-region') : '',
        captionControls: !!document.querySelector('.caption-controls'),
        bodyArea: !!bodyArea,
        bodyAreaClass: bodyArea ? bodyArea.className : '',
      };
    })()`)) as {
        title: string;
        header: boolean;
        headerDrag: string;
        captionControls: boolean;
        bodyArea: boolean;
        bodyAreaClass: string;
      };
      result.title = win.getTitle();
      result.header = dom.header;
      result.headerDrag = dom.headerDrag;
      result.captionControls = dom.captionControls;
      result.bodyArea = dom.bodyArea;
      result.bodyAreaHasDesktopClass =
        dom.bodyAreaClass.includes('desktop-body-area');
      // The smoke run uses the normal argv (no --register-protocol /
      // --unregister-protocol); the CLI flags exit before any window.
      result.registrationNotExercised =
        !process.argv.slice(1).includes('--register-protocol') &&
        !process.argv.slice(1).includes('--unregister-protocol');
      // The smoke path returns before startTray(), so no real Tray is ever
      // instantiated by the harness.
      result.trayNotExercised = this.trayHandle === null;
      // The ready callback returns before the hotkey registration line in
      // smoke mode, so no real globalShortcut registration ever exists.
      result.hotkeyNotExercised = this.hotkeyRegistrations.length === 0;
      // Persistence proof: a controller at a scratch path under the OS temp
      // dir (never the real userData profiles.json); the payload reports
      // whether the JSON file exists on disk afterwards.
      result.controllerPersisted = false;
      try {
        const scratch = path.join(
          app.getPath('temp'),
          `phi-desktop-smoke-${Date.now()}-profiles.json`,
        );
        const smokeController = new Controller({
          persistPath: scratch,
          log: console.log,
        });
        smokeController.add('http://127.0.0.1:7070/');
        result.controllerPersisted = existsSync(scratch);
      } catch (err) {
        result.controllerPersisted = false;
        result.controllerPersistedError = String(err);
      }
      // The view manager runs on recording fakes (no real
      // WebContentsView/Session); viewsCreated/activeViewId prove the
      // wiring; railWidth/bodyLeftOffset/bodyTopOffset/railTopOffset/
      // headerHeight are the geometry literals.
      result.viewsCreated = this.profileViews?.viewsCreated() ?? 0;
      result.activeViewId = this.profileViews?.getActive() ?? null;
      result.railWidth = RAIL_WIDTH;
      result.bodyLeftOffset = RAIL_WIDTH;
      result.bodyTopOffset = HEADER_HEIGHT;
      result.railTopOffset = HEADER_HEIGHT;
      result.headerHeight = HEADER_HEIGHT;
      // Argv routing: classify this launch's positional args exactly like a
      // real launch, and dispatch the harness's deep-link test arg.
      const argvPayloads = classifyArgv(process.argv.slice(1));
      result.argvRouted = argvPayloads.length > 0;
      result.argvDeepLinkParsed = false;
      const deepLinkArg = argvPayloads.find((p) => p.kind === 'deep-link');
      if (deepLinkArg) {
        const parsed = parseDeepLink(deepLinkArg.value);
        result.argvDeepLinkParsed = parsed.ok;
        if (parsed.ok) dispatchDeepLink(win, parsed);
      }
      const ok =
        result.isBrowserWindow === true &&
        result.title === 'Phi' &&
        result.header === true &&
        result.headerDrag === 'drag' &&
        result.captionControls === true &&
        result.bodyArea === true &&
        result.bodyAreaHasDesktopClass === true &&
        result.argvRouted === true &&
        result.argvDeepLinkParsed === true &&
        result.registrationNotExercised === true &&
        result.trayNotExercised === true &&
        result.hotkeyNotExercised === true &&
        result.controllerPersisted === true &&
        result.viewsCreated === 1 &&
        result.activeViewId === '127-0-0-1-7070' &&
        result.railWidth === 72 &&
        result.bodyLeftOffset === 72 &&
        result.bodyTopOffset === 48 &&
        result.railTopOffset === 48 &&
        result.headerHeight === 48;
      console.log(`PHI_SMOKE_RESULT ${JSON.stringify(result)}`);
      app.exit(ok ? 0 : 1);
    } catch (err) {
      result.error = String(err);
      console.log(`PHI_SMOKE_RESULT ${JSON.stringify(result)}`);
      app.exit(1);
    }
  }

  /**
   * Phi-native application menu. Windows/Linux get no menu bar (the tray
   * and rail own those actions); macOS keeps a minimal Phi menu with Edit
   * and Window menus so standard clipboard (Cmd+C/V/X/A/Z) and system window
   * actions stay functional.
   */
  installAppMenu(): void {
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
      return;
    }
    if (typeof app.setAboutPanelOptions === 'function') {
      app.setAboutPanelOptions({
        applicationName: 'phi-client',
        applicationVersion: app.getVersion(),
        copyright: 'Copyright © 2025-2026 Phi Contributors',
        credits:
          'Terminal multiplexer and browser-based control center for AI coding assistants.',
        authors: ['hypernewbie'],
        website: 'https://github.com/hypernewbie/phi',
        iconPath: path.join(here, '..', 'assets', 'icon.png'),
      });
    }
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'phi-client',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  createMainWindow(): BrowserWindow {
    if (
      process.platform === 'darwin' &&
      app.dock &&
      typeof app.dock.setIcon === 'function'
    ) {
      app.dock.setIcon(APP_ICON_PATH);
    }
    const win = new BrowserWindow({
      title: 'Phi',
      // The generated Phi icon; the tray keeps its own 16px asset (tray sizes differ).
      icon: APP_ICON_PATH,
      width: 1200,
      height: 800,
      // Frameless: the desktop uses its vendored .app-header (the same
      // DOM as the browser Phi header) as the native drag row, with
      // caption controls as in-flow children at the right edge.
      frame: false,
      // Narrow-width contract: at 800px and below, the full desktop
      // header (brand + workspace + action cluster + 138px caption lane
      // + 12px gaps) overruns the available width and the action cluster
      // clips. Below 720 the desktop can't keep caption, workspace, and
      // actions all legible at once; mobile rules below the 768px
      // breakpoint handle smaller widths.
      minWidth: 720,
      // Phi's base background token, so the first paint is not a white flash.
      backgroundColor: '#08080a',
      // The smoke harness verifies the loaded page; it needs no visible window.
      show: !SMOKE,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: path.join(here, 'preload.js'),
      },
    });
    // Close-to-tray (default on): close hides the window instead of
    // quitting, keeping the retained views alive (hide() preserves
    // WebContentsView children). before-quit sets `quitting` so explicit
    // quits are never intercepted; child windows carry no close handler.
    win.on('close', (event) => {
      if (!this.quitting && (this.controller?.state().closeToTray ?? true)) {
        event.preventDefault();
        win.hide();
      }
    });
    // Plain F11 toggles fullscreen on the BrowserWindow (any view — main
    // view, body views, picker). before-input-event fires per webContents,
    // so the toggle is installed on every desktop-owned surface (the
    // retained bodies install it via ProfileViewManager; the picker and
    // popups below install it on their own contents). Modified F11 chords
    // stay untouched; xterm.js does not claim plain F11.
    installFullscreenToggle(win.webContents, win);
    installReloadShortcut(
      win.webContents,
      () => {
        const activeId = this.profileViews?.getActive() ?? null;
        if (activeId !== null) {
          const view = this.profileViews?.getView(activeId) ?? null;
          if (view && !view.webContents.isDestroyed()) return view.webContents;
        }
        return win.webContents;
      },
      (ignoringCache) => this.profileViews?.reloadAll(ignoringCache),
    );
    installZoomShortcuts(win.webContents, () => {
      const activeId = this.profileViews?.getActive() ?? null;
      if (activeId !== null) {
        const view = this.profileViews?.getView(activeId) ?? null;
        if (view && !view.webContents.isDestroyed()) return view.webContents;
      }
      return win.webContents;
    });
    // A sync-alert taskbar flash clears when the window regains focus; the
    // main view page also reflects the focus state (native dim-when-unfocused).
    win.on('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false);
      this.pushWindowState();
      const activeId = this.profileViews?.getActive() ?? null;
      if (activeId !== null) {
        const view = this.profileViews?.getView(activeId) ?? null;
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.focus();
        }
      }
    });
    win.on('blur', () => this.pushWindowState());
    // The main view page (the vendored header + local caption controls +
    // the empty body area). Local page only — never loadURL to an
    // external origin here.
    void win.loadFile(path.join(here, '..', 'web', 'index.html'));
    return win;
  }

  /**
   * Boots the desktop host once the app is ready: window, tray, retained
   * views, rail renderer, intervals, hotkey, IPC receivers and the
   * lifecycle handlers. Never reached on the losing side of the
   * single-instance gate (that side quits at boot).
   */
  async start(singleInstance: SingleInstanceHandle): Promise<void> {
    app.on('before-quit', (event) => {
      // before-quit fires before windows close, so setting the flag here
      // lets every real quit (tray Quit, Cmd+Q, window-all-closed) through.
      this.quitting = true;
      // Stop the polls before the view teardown below (no pending probe or
      // executeJavaScript may outlive the retained views).
      if (this.healthInterval !== null) {
        clearInterval(this.healthInterval);
        this.healthInterval = null;
      }
      if (this.cpuInterval !== null) {
        clearInterval(this.cpuInterval);
        this.cpuInterval = null;
      }
      if (this.fileActionInterval !== null) {
        clearInterval(this.fileActionInterval);
        this.fileActionInterval = null;
      }
      // Unregister every active global hotkey, then tear the tray down (icon
      // removed).
      for (const reg of this.hotkeyRegistrations) reg.unregister();
      this.hotkeyRegistrations.length = 0;
      this.trayHandle?.close();
      this.trayHandle = null;
      // Tear every retained view down before the app quits. The first
      // before-quit defers the quit until destroyAll() (and the rail view
      // teardown) completes, then re-quits; the guard flag keeps the
      // re-entrant before-quit from deferring again.
      if (this.profileViews && !this.viewsTornDown) {
        this.viewsTornDown = true;
        event.preventDefault();
        void this.profileViews.destroyAll().then(() => {
          // The rail view is NEVER hidden during the app's life; it is
          // removed only here, at quit, alongside the profile views
          // (WebContentsView teardown = webContents.close() + removeChildView).
          // Guard for mainWindow/contentView being torn down concurrently.
          if (this.railView) {
            try {
              if (!this.railView.webContents.isDestroyed())
                this.railView.webContents.close();
            } catch (err) {
              console.log(`phi-desktop: rail view close: ${String(err)}`);
            }
            try {
              if (
                this.mainWindow &&
                !this.mainWindow.isDestroyed() &&
                this.mainWindow.contentView
              ) {
                this.mainWindow.contentView.removeChildView(this.railView);
              }
            } catch (err) {
              console.log(`phi-desktop: rail view detach: ${String(err)}`);
            }
            this.railView = null;
          }
          app.quit();
        });
      }
    });
    app.on('window-all-closed', () => {
      // Non-macOS: quit here; before-quit tears the tray down.
      if (process.platform !== 'darwin') app.quit();
    });
    this.installAppMenu();
    const win = this.createMainWindow();
    this.mainWindow = win;
    if (SMOKE) {
      // Smoke gate (the same no-real-GUI convention as the tray and hotkey
      // gates): the ProfileViewManager is built with a recording-fake
      // window and view factory — no real WebContentsView or Session is
      // ever constructed by the harness. One probe profile is registered
      // and activated so the payload can report viewsCreated/activeViewId.
      const fakeWin = {
        contentView: { addChildView: () => {} },
        getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      } as unknown as BrowserWindow;
      this.profileViews = new ProfileViewManager({
        win: fakeWin,
        makeView: () => this.makeSmokeContentView(),
        defaultBounds: () => ({
          x: RAIL_WIDTH,
          y: HEADER_HEIGHT,
          width: 1200 - RAIL_WIDTH,
          height: 800 - HEADER_HEIGHT,
        }),
        railWidth: RAIL_WIDTH,
        log: (msg) => console.log(`phi-desktop: views: ${msg}`),
      });
      this.profileViews.addProfile('127-0-0-1-7070', 'http://127.0.0.1:7070/');
      this.profileViews.setActive('127-0-0-1-7070');
      win.webContents.once('did-finish-load', () => {
        void this.runSmokeChecks(win);
      });
      return;
    }
    // The tray is built before the second-instance listener, so a second
    // launch that foregrounds the window always finds the tray ready.
    this.startTray();
    singleInstance.installListener();
    // The controller is built after the tray and the listener: a persisted,
    // non-secret profile store plus active/unread/health state.
    this.controller = new Controller({
      persistPath: app.getPath('userData') + '/profiles.json',
      log: (msg) => console.log(`phi-desktop: controller: ${msg}`),
    });
    // Access-auth state — declared here (before any subscribe callback
    // can fire) so a synchronously-emitted active-changed event during
    // initial state doesn't trigger a ReferenceError trying to read
    // these bindings while they are still in the temporal dead zone.
    /** Monotonic counter incremented on every active-changed event.
     *  Captured into each pending (typed-unlock AND silent-body) at
     *  creation; checked at every await boundary inside
     *  `authenticateBodyView`. Without the epoch, an A→B→A rail
     *  switch during an in-flight body login would pass every
     *  activeId check (activeId returns A again) but the proof has
     *  already been injected into the B view — an ABA race. */
    let activeEpoch = 0;
    let pendingUnlock: {
      requestId: string;
      profileId: string;
      origin: string;
      abort: AbortController;
      epoch: number;
    } | null = null;
    let unlockInFlight = false;
    let promptSuppressedFor: string | null = null;
    const accessAuth = new AccessAuth();
    // Tray receiver wiring: active-changed -> setActiveProfile,
    // unread-changed -> setUnread, profiles-changed -> rebuildMenu;
    // syncTrayFromController() then pushes the store's pre-existing state
    // (the menu is rebuilt on the first profiles-changed after startup).
    this.controller.subscribe((event) => {
      const ctrl = this.controller;
      if (!ctrl) return;
      if (event.kind === 'active-changed') {
        const profile =
          ctrl.state().profiles.find((p) => p.id === event.id) ?? null;
        if (profile) this.trayHandle?.setActiveProfile(profile);
        this.syncDividersOnSwitch(event.id);
        // The retained-view switch follows the controller's active id (the
        // manager owns the view lifecycle — create/hide/show).
        this.profileViews?.setActive(event.id);
        // The window title follows the SELECTED profile only.
        this.refreshWindowTitle();
        // The header's hostname/project display follows the SELECTED server.
        this.pushActiveServer();
        // Deactivate the previous server's taskbar progress; the CPU poll
        // re-applies it from the newly selected view on its next tick.
        if (!win.isDestroyed()) win.setProgressBar(-1);
        // Cancels any in-flight access-auth prompt: the active origin
        // changed and the pending requestId is no longer for this
        // server. The renderer also closes any modal it had open.
        if (pendingUnlock !== null) {
          pendingUnlock.abort.abort();
          pendingUnlock = null;
          if (typeof sendBodyObscuring === 'function') sendBodyObscuring(false);
        }
        // A rail switch is the explicit retry gesture after dismissal.
        promptSuppressedFor = null;
        // Bump the epoch so any pending body-login (typed or silent) is
        // invalidated at its next await boundary. The active-changed
        // event above already ran setActive which fires the rail, but
        // the epoch is the cross-await guarantee against A→B→A races
        // (the activeId check alone is insufficient: it returns A
        // again after B, and the proof has already been injected into
        // the B view).
        activeEpoch++;
      } else if (
        event.kind === 'unread-changed' ||
        event.kind === 'profiles-changed' ||
        event.kind === 'health-changed' ||
        event.kind === 'close-to-tray-changed' ||
        event.kind === 'sync-alerts-changed'
      ) {
        if (event.kind === 'unread-changed') {
          this.trayHandle?.setUnread(event.id, event.n);
        }
        // The tray menu snapshots the profile list and the close-to-tray
        // checkbox at build time; rebuild it on every store mutation and
        // preference toggle (rebuildMenu only swaps the Menu).
        this.trayHandle?.rebuildMenu();
      }
      // Every controller mutation re-pushes the rail snapshot so the rail
      // renderer stays in sync.
      this.pushRailState();
      // A first activation appends a new profile view to the content view;
      // re-assert the rail's bounds and the active view's size.
      layoutChildren();
    });
    this.syncTrayFromController();
    // Retained per-profile views + rail renderer. The manager (src/views.ts)
    // owns the per-profile WebContentsView lifecycle (lazy creation,
    // retain-on-switch, hide-when-inactive, single shared persistent
    // session); the host loop drives it from active-changed events and
    // tears everything down on before-quit. The factories are closures
    // over `win` so defaultBounds() is re-read on every
    // setActive/onWindowResize (the window bounds change during use).
    const sharedSession = session.defaultSession;
    const makeView = (origin: string): WebContentsView => {
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          session: sharedSession,
        },
      });
      // The CPU poll resolves the selected server's view from this lookup
      // (the retained views are owned by ProfileViewManager).
      this.viewByOrigin.set(origin, view);
      // The normalized comparison origin: computed once per view so both
      // guard paths (window-open and will-navigate) compare the same
      // canonical origin string.
      const allowedOrigin = new URL(origin).origin;
      const popupSize = (
        features: string,
      ): { width: number; height: number } => {
        const token = (name: string): number | null => {
          const m = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(
            features,
          );
          return m ? Number(m[1]) : null;
        };
        return {
          width: token('width') ?? 860,
          height: token('height') ?? 1000,
        };
      };
      view.webContents.setWindowOpenHandler(({ url, features }) => {
        try {
          const target = new URL(url);
          if (target.origin === allowedOrigin) {
            const size = popupSize(features);
            return {
              action: 'allow',
              createWindow: (options) => {
                const child = new BrowserWindow({
                  ...options,
                  width: size.width,
                  height: size.height,
                  show: false,
                  webPreferences: {
                    ...options.webPreferences,
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    webSecurity: true,
                    session: sharedSession,
                  },
                });
                child.once('ready-to-show', () => {
                  if (!child.isDestroyed()) child.show();
                });
                attachNavGuard(child.webContents);
                installFullscreenToggle(child.webContents, child);
                installReloadShortcut(child.webContents);
                installZoomShortcuts(child.webContents);
                return child.webContents;
              },
            };
          }
          if (target.protocol === 'http:' || target.protocol === 'https:')
            void shell.openExternal(url);
        } catch {
          /* deny malformed URLs */
        }
        return { action: 'deny' };
      });
      // Navigation guard (security): a retained profile view may only
      // navigate within its own origin — the same same-origin rule as the
      // window-open guard above. Same-origin navigations are allowed;
      // http(s) targets are handed to the OS browser via
      // shell.openExternal; everything else is denied. The main process's
      // own loadURL calls do not emit will-navigate, so the view manager's
      // initial page loads are unaffected.
      const attachNavGuard = (contents: typeof view.webContents): void => {
        contents.on('will-navigate', (event, url) => {
          try {
            const target = new URL(url);
            if (target.origin === allowedOrigin) return; // same-origin: allow
            if (target.protocol === 'http:' || target.protocol === 'https:') {
              void shell.openExternal(url);
            }
          } catch {
            /* malformed URL: deny below */
          }
          event.preventDefault();
        });
      };
      attachNavGuard(view.webContents);
      // Rail-selection shortcuts: before-input-event runs in the browser
      // process, so a chord is caught before the renderer. The always-safe
      // digits (Ctrl+1/2/9) produce no PTY byte and switch synchronously.
      // The conditional chords (Ctrl+3..8, Tab/Shift+Tab) are live
      // terminal bytes, so they are never preventDefaulted; the terminal-
      // focus probe runs after the dispatch and switches only when the
      // page is not focused in a terminal.
      view.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (!input.control || input.alt || input.meta) return;
        const ctrl = this.controller;
        if (!ctrl) return;
        const profiles = ctrl.state().profiles;
        const target = resolveRailChord(input, profiles.length);
        if (!target) return;
        const select = (): void => {
          try {
            if (target.kind === 'index') {
              ctrl.setActive(profiles[target.index].id);
              return;
            }
            const activeIdx = profiles.findIndex(
              (p) => p.id === ctrl.state().activeId,
            );
            const step = target.kind === 'next' ? 1 : -1;
            const base = activeIdx < 0 ? (step === 1 ? -1 : 0) : activeIdx;
            ctrl.setActive(
              profiles[(base + step + profiles.length) % profiles.length].id,
            );
          } catch (err) {
            console.log(
              `phi-desktop: rail select ${input.key}: ${String(err)}`,
            );
          }
        };
        if (target.kind === 'index' && ALWAYS_SAFE_RAIL_CHORDS.has(input.key)) {
          event.preventDefault();
          select();
          return;
        }
        void view.webContents.executeJavaScript(TERMINAL_FOCUS_SCRIPT).then(
          (raw) => {
            if (raw === true) return;
            select();
          },
          () => {},
        );
      });
      view.webContents.on('page-title-updated', (_event, title) => {
        this.onProfileTitleUpdated(view, origin, title);
        this.pollCpu();
        // The remote app titles its page only once the hostname/accent are
        // live, so identity observation rides this event; the rail snapshot
        // is repushed only after a real result.
        void this.observeProfileIdentity(view, origin).then((identity) => {
          if (identity !== null) {
            this.pushRailState();
            this.refreshWindowTitle();
            // The observed accent drives the header's chrome; re-push the
            // active server so the main view page picks it up.
            this.pushActiveServer();
          }
        });
      });
      // Fresh rail snapshot after a view finishes loading, plus the
      // desktop-local file-action listener install (executeJavaScript only
      // — no preload or IPC on remote origins).
      view.webContents.on('did-finish-load', () => {
        this.loadedViews.add(view);
        this.pushRailState();
        void view.webContents
          .executeJavaScript(INSTALL_FILE_ACTION_SCRIPT)
          .catch(() => {});
        // A first activation can request header config before this body has
        // populated its workspace selector. Re-push the active server after
        // load so the main header reads this server's actual selected project.
        const state = this.controller?.state();
        const active = state?.profiles.find(
          (profile) => profile.id === state.activeId,
        );
        if (active?.origin === origin) this.pushActiveServer();
      });
      return view;
    };
    const defaultBounds = (): {
      x: number;
      y: number;
      width: number;
      height: number;
    } => {
      // WebContentsView bounds are relative to the window's CONTENT area,
      // so the content bounds drive the active view's size — never the
      // outer frame bounds. The retained bodies start below the main view
      // page's vendored header row (HEADER_HEIGHT) and sit right of the
      // rail gutter; the header is never covered.
      const b = win.getContentBounds();
      return {
        x: RAIL_WIDTH,
        y: HEADER_HEIGHT,
        width: b.width - RAIL_WIDTH,
        height: b.height - HEADER_HEIGHT,
      };
    };
    this.profileViews = new ProfileViewManager({
      win,
      makeView,
      defaultBounds,
      railWidth: RAIL_WIDTH,
      log: (msg) => console.log(`phi-desktop: views: ${msg}`),
    });
    // Sync every persisted profile into the view manager so setActive
    // can find the origin to loadURL. Without this, setActive returns
    // silently (the profile was never registered with the manager).
    for (const p of this.controller.state().profiles) {
      this.profileViews.addProfile(p.id, p.origin);
    }
    // The rail begins below the main view page's header row. Its top edge
    // sits at HEADER_HEIGHT so the vendored header is never overlapped by
    // a rail entry.
    const layoutRail = (): void => {
      if (this.railView && !this.railView.webContents.isDestroyed()) {
        const b = win.getContentBounds();
        this.railView.setBounds({
          x: 0,
          y: HEADER_HEIGHT,
          width: RAIL_WIDTH,
          height: Math.max(0, b.height - HEADER_HEIGHT),
        });
      }
    };
    // Recomputes the two child regions (active profile body + rail) from
    // the content bounds. The main view page's header row occupies
    // y=0..HEADER_HEIGHT as the window's own webContents; the children
    // live below it.
    const layoutChildren = (): void => {
      this.profileViews?.onWindowResize();
      layoutRail();
    };
    // Window resize: recompute the children from the content bounds.
    win.on('resize', () => layoutChildren());
    // Maximize/restore change the content bounds; the window-state icon follows.
    win.on('maximize', () => {
      layoutChildren();
      this.pushWindowState();
    });
    win.on('unmaximize', () => {
      layoutChildren();
      this.pushWindowState();
    });
    // Rail renderer click handler (window.electron.postSelectProfile):
    // activate the clicked profile.
    ipcMain.on('phi:select-profile', (_event, id: unknown) => {
      const ctrl = this.controller;
      if (!ctrl || typeof id !== 'string' || id === '') return;
      try {
        ctrl.setActive(id);
      } catch (err) {
        console.log(`phi-desktop: phi:select-profile ${id}: ${String(err)}`);
      }
    });
    // Activate the profile, then open its own hostname/session selector on
    // its retained view (the guarded #hostname-display click).
    ipcMain.on('phi:open-server-sessions', (_event, id: unknown) => {
      const ctrl = this.controller;
      if (!ctrl || typeof id !== 'string' || id === '') return;
      try {
        ctrl.setActive(id);
      } catch (err) {
        console.log(
          `phi-desktop: phi:open-server-sessions ${id}: ${String(err)}`,
        );
        return;
      }
      this.openServerSessions(id);
    });
    // A modal child window hosting the local picker.html form via loadFile
    // with the sandboxed preload.
    ipcMain.on('phi:open-picker', () => {
      const picker = new BrowserWindow({
        width: 500,
        height: 420,
        parent: win,
        modal: true,
        show: false,
        resizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          preload: path.join(here, 'preload.js'),
        },
      });
      void picker.loadFile(path.join(here, 'picker.html'));
      installFullscreenToggle(picker.webContents, win);
      installReloadShortcut(picker.webContents);
      installZoomShortcuts(picker.webContents);
      picker.once('ready-to-show', () => {
        if (!picker.isDestroyed()) picker.show();
      });
    });
    // controller.add validates the URL (an invalid URL or a same-host
    // conflict throws and is logged); the profile is registered with the
    // retained view manager, then activated.
    ipcMain.on('phi:add-server', (event, url: unknown) => {
      const ctrl = this.controller;
      if (!ctrl || typeof url !== 'string' || url === '') return;
      try {
        const profile = ctrl.add(url);
        this.profileViews?.addProfile(profile.id, profile.origin);
        ctrl.setActive(profile.id);
        // Probe the newly added profile once (fire-and-forget, no polling)
        // so its rail health dot reflects a real /healthz result instead of
        // 'unknown'.
        void ctrl.updateHealth(realHealthChecker);
        event.sender.send('phi:add-server-result', { ok: true });
      } catch (err) {
        console.log(`phi-desktop: phi:add-server ${url}: ${String(err)}`);
        if (!event.sender.isDestroyed()) {
          event.sender.send('phi:add-server-result', {
            ok: false,
            message: String(err),
          });
        }
      }
    });
    // Requires a nonempty profile id and a nonempty name; controller.rename
    // throws on unknown ids — logged, no reply channel.
    ipcMain.on('phi:rename-profile', (_event, id: unknown, name: unknown) => {
      const ctrl = this.controller;
      if (
        !ctrl ||
        typeof id !== 'string' ||
        id === '' ||
        typeof name !== 'string' ||
        name === ''
      )
        return;
      try {
        ctrl.rename(id, name);
      } catch (err) {
        console.log(`phi-desktop: phi:rename-profile ${id}: ${String(err)}`);
      }
    });
    // Requires a nonempty profile id; controller.remove throws on unknown
    // ids — logged, no reply channel. After the removal the retained views
    // follow the controller's (possibly new) active id explicitly:
    // setActive(activeId) when one remains, setActive(null) when the store
    // is empty (the controller's active-changed fallback to '' would not
    // clear the view manager).
    ipcMain.on('phi:remove-profile', (_event, id: unknown) => {
      const ctrl = this.controller;
      if (!ctrl || typeof id !== 'string' || id === '') return;
      const origin =
        ctrl.state().profiles.find((p) => p.id === id)?.origin ?? '';
      try {
        ctrl.remove(id);
      } catch (err) {
        console.log(`phi-desktop: phi:remove-profile ${id}: ${String(err)}`);
        return;
      }
      const activeId = ctrl.state().activeId;
      if (activeId !== '') this.profileViews?.setActive(activeId);
      else this.profileViews?.setActive(null);
      this.observedIdentity.delete(id);
      this.observedCpu.delete(id);
      this.firedSyncKeys.delete(id);
      if (origin !== '') {
        this.viewByOrigin.delete(origin);
        const authOrigin = new URL(origin).origin;
        accessAuth.cancel(authOrigin);
        this.clearStoredCredential(authOrigin);
      }
    });
    ipcMain.on(
      'phi:reorder-profile',
      (_event, id: unknown, beforeId: unknown) => {
        const ctrl = this.controller;
        if (!ctrl || typeof id !== 'string' || id === '') return;
        if (
          beforeId !== null &&
          (typeof beforeId !== 'string' || beforeId === '')
        )
          return;
        try {
          ctrl.reorder(id, beforeId);
        } catch (err) {
          console.log(`phi-desktop: phi:reorder-profile ${id}: ${String(err)}`);
        }
      },
    );
    ipcMain.on('phi:reload-profile', (_event, id: unknown) => {
      const targetId = typeof id === 'string' && id !== '' ? id : undefined;
      this.profileViews?.reloadActive(targetId);
    });
    ipcMain.on('phi:reload-all-servers', () => {
      this.profileViews?.reloadAll();
    });
    // Rail renderer: a never-hidden child view spanning the left rail
    // gutter (RAIL_WIDTH px), loading the local rail page
    // (renderer.html + renderer.js) via loadFile. Destroyed only at quit
    // (the before-quit teardown, alongside profileViews.destroyAll()). The
    // rail page is LOCAL and needs the typed preload bridge, so the preload
    // is attached to THIS view only; the makeView factory above stays
    // unpreloaded — remote profile origins never run the bridge.
    const rail = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: path.join(here, 'preload.js'),
        session: sharedSession,
      },
    });
    this.railView = rail;
    win.contentView.addChildView(rail);
    // Re-apply the bounds once the page loads, then push a fresh rail
    // snapshot.
    rail.webContents.on('did-finish-load', () => {
      layoutRail();
      this.pushRailState();
    });
    layoutRail();
    try {
      await rail.webContents.loadFile(
        path.join(app.getAppPath(), 'dist', 'renderer.html'),
      );
    } catch (err) {
      console.log(`phi-desktop: rail loadFile failed: ${String(err)}`);
    }
    if (!rail.webContents.isDestroyed()) this.pushRailState();
    // The main view page IS the window's own webContents (the vendored
    // header + caption controls + empty body area); the rail and the
    // retained profile views are the only child views. Push the current
    // window state and active server once the page is live.
    win.webContents.on('did-finish-load', () => {
      this.pushWindowState();
      this.pushActiveServer();
    });
    // Window-control IPC: only the main view page may drive the window;
    // any other sender (a remote profile origin, the rail, the picker) is
    // rejected.
    const isMainViewSender = (event: IpcMainInvokeEvent): boolean =>
      event.sender === win.webContents;
    ipcMain.handle('phi:window-minimize', (event) => {
      if (!isMainViewSender(event)) return;
      win.minimize();
    });
    ipcMain.handle('phi:window-toggle-maximize', (event) => {
      if (!isMainViewSender(event)) return;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    });
    ipcMain.handle('phi:window-close', (event) => {
      if (!isMainViewSender(event)) return;
      win.close();
    });
    // The main view page resolves the ACTIVE server's /api/config through
    // the main process (a file:// page must not fetch a remote origin
    // directly; the path is pinned to /api/config and the sender is
    // validated).
    //
    // Access-auth flow: on a 401 from /api/config, the main process
    // validates the server's /api/auth/status (disabled / trusted /
    // unavailable). If trusted, a single in-flight `phi:auth-required`
    // push fires to the main view page; the modal shows up there, the
    // user types a password, the modal invokes `phi:auth-unlock` with
    // a paired requestId, the main process runs the PBKDF2/HMAC
    // handshake, captures the `phi_access_session` cookie (HttpOnly
    // only), retries /api/config, then closes the modal on success.
    // The renderer is responsible for hiding the active body view via
    // the `phi:body-obscuring` channel — a parent-page DOM modal
    // cannot paint above a child WebContentsView on its own.
    // Re-authenticate every saved origin from the on-disk credential
    // store (if one exists) BEFORE the first config poll. A returning
    // user with valid persisted credentials never sees the unlock
    // modal. Failures (server rotation, corrupted file, etc.) silently
    // fall back to a prompt on the first 401.
    void this.bootstrapStoredCredentials(accessAuth);

    const sendAuthRequired = (info: AuthRequired): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('phi:auth-required', info);
    };
    const sendBodyObscuring = (obscured: boolean): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('phi:body-obscuring', obscured);
      this.profileViews?.setObscured(obscured);
    };

    /** Waits for one main-frame load without exposing a timer or callback to
     *  the remote page. Used both before the one-time login and after reload. */
    const waitForBodyLoad = (
      view: WebContentsView,
      reload: boolean,
    ): Promise<boolean> =>
      new Promise((resolve) => {
        const contents = view.webContents;
        if (contents.isDestroyed()) {
          resolve(false);
          return;
        }
        let settled = false;
        const finish = (loaded: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          contents.removeListener('did-finish-load', onLoaded);
          resolve(loaded);
        };
        const onLoaded = (): void => finish(true);
        const timer = setTimeout(() => finish(false), 10_000);
        contents.once('did-finish-load', onLoaded);
        if (reload) contents.reload();
      });

    /** Gives the active remote body its own independently-issued session
     *  after the user has unlocked the desktop header. Only a fresh,
     *  single-use challenge/proof pair enters that renderer; the password,
     *  verifier, and native-fetch cookie stay in the main process. Reloading
     *  then lets the browser's unchanged auth bootstrap observe its cookie,
     *  so it never asks the user for the same password a second time. */
    const authenticateBodyView = async (pending: {
      requestId: string;
      profileId: string;
      origin: string;
      abort: AbortController;
      epoch: number;
    }): Promise<
      | { ok: true }
      | { ok: false; code: 'stale' | 'unavailable'; message: string }
    > => {
      const ctrl = this.controller;
      if (
        !ctrl ||
        ctrl.state().activeId !== pending.profileId ||
        pending.abort.signal.aborted
      ) {
        return { ok: false, code: 'stale', message: 'Prompt expired.' };
      }
      const profile =
        ctrl.state().profiles.find((p) => p.id === pending.profileId) ?? null;
      const view = profile ? this.viewByOrigin.get(profile.origin) : null;
      if (!view || view.webContents.isDestroyed()) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'The server view is unavailable.',
        };
      }
      if (
        !this.loadedViews.has(view) &&
        !(await waitForBodyLoad(view, false))
      ) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'The server view did not finish loading.',
        };
      }
      const login = await accessAuth.createLoginProof(
        pending.origin,
        pending.abort.signal,
      );
      if (login.kind === 'stale')
        return { ok: false, code: 'stale', message: login.message };
      if (login.kind === 'unavailable') {
        return { ok: false, code: 'unavailable', message: login.message };
      }
      // `pendingUnlock` is null on the silent re-auth path (no user prompt
      // is active). The active-id check below still aborts on a rail switch
      // (the active-changed handler nulls pendingUnlock and clears state),
      // so the only behaviour change vs the typed-unlock path is that the
      // silent path passes through when no prompt is in flight. The
      // epoch check is the cross-await guarantee against A→B→A ABA
      // races (activeId returns A again after B but the proof has
      // already been injected into the B view).
      if (
        (pendingUnlock !== null && pendingUnlock !== pending) ||
        pending.epoch !== activeEpoch ||
        ctrl.state().activeId !== pending.profileId
      ) {
        return { ok: false, code: 'stale', message: 'Prompt expired.' };
      }
      if (login.kind === 'ok') {
        let status: unknown;
        try {
          status = await view.webContents.executeJavaScript(
            bodyAuthLoginScript(login.challenge, login.proof),
          );
        } catch {
          return {
            ok: false,
            code: 'unavailable',
            message: 'Unable to authenticate the server view.',
          };
        }
        if (status !== 200) {
          return {
            ok: false,
            code: 'unavailable',
            message: 'The server view did not accept the session.',
          };
        }
      }
      if (
        (pendingUnlock !== null && pendingUnlock !== pending) ||
        pending.epoch !== activeEpoch ||
        ctrl.state().activeId !== pending.profileId
      ) {
        return { ok: false, code: 'stale', message: 'Prompt expired.' };
      }
      if (!(await waitForBodyLoad(view, true))) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'The authenticated server view did not reload.',
        };
      }
      if (
        (pendingUnlock !== null && pendingUnlock !== pending) ||
        pending.epoch !== activeEpoch ||
        ctrl.state().activeId !== pending.profileId
      ) {
        return { ok: false, code: 'stale', message: 'Prompt expired.' };
      }
      return { ok: true };
    };

    /** Silently re-login + reload the active body view using the verifier
     *  cached by AccessAuth after a successful main-process re-auth. The
     *  body's Chromium shared-session cookie is stale after a backend
     *  restart even though the main-process jar was just refreshed; this
     *  re-runs the same one-time challenge/proof handshake the typed-
     *  unlock path uses, without ever opening a modal. Reuses
     *  authenticateBodyView with a synthetic pending (no requestId,
     *  fresh abort controller) — the relaxed `pendingUnlock !== null &&
     *  pendingUnlock !== pending` check inside authenticateBodyView lets
     *  the silent path through while the active-id check still aborts on
     *  a rail switch. */
    const silentBodyReauth = async (
      origin: string,
      profileId: string,
    ): Promise<
      | { ok: true }
      | { ok: false; code: 'stale' | 'unavailable'; message: string }
    > =>
      authenticateBodyView({
        requestId: '',
        profileId,
        origin,
        abort: new AbortController(),
        epoch: activeEpoch,
      });

    /** Per-origin coalescing for the full config fetch + reauth +
     *  retry sequence. Two concurrent 10s polls for the same origin
     *  would otherwise race: both send the stale cookie, both get
     *  401, both call `fetchConfig`'s `this.cookies.delete(origin)`
     *  — the second poll deletes the FIRST poll's freshly-installed
     *  cookie S1. The outer retry then sees no cookie, gets 401, and
     *  the silent re-auth's outer code clears a valid stored
     *  credential and prompts. Joining the in-flight Promise prevents
     *  the second fetchConfig from issuing until the first finishes.
     *  Cleared when the operation resolves. */
    const configOpInFlight = new Map<string, Promise<unknown>>();
    /** Independent body-reauth retry chain. silentBodyReauth can fail
     *  for transient reasons (the body view tearing down from a
     *  server restart); the next config poll uses the fresh main
     *  cookie so it never re-enters the 401 branch and the body
     *  would otherwise stay stuck on its own auth UI. Up to 3
     *  attempts with 2s/4s/6s backoff. Per-origin dedup; cleared when
     *  the chain resolves. */
    const bodyReauthInFlight = new Map<string, Promise<void>>();
    /** Fire-and-forget body-reauth retry with backoff. Coalesces
     *  concurrent requests for the same origin. Stops early when
     *  the active profile switches away from this origin. */
    const scheduleBodyReauthRetry = (
      origin: string,
      profileId: string,
    ): void => {
      const existing = bodyReauthInFlight.get(origin);
      if (existing) return;
      const p = (async (): Promise<void> => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt - 1)));
          }
          if (this.controller?.state().activeId !== profileId) return;
          const result = await silentBodyReauth(origin, profileId);
          if (result.ok) return;
          console.log(
            `phi-desktop: silent body reauth retry ${attempt}/3 ${origin}: ${result.message}`,
          );
        }
      })();
      bodyReauthInFlight.set(origin, p);
      p.finally(() => bodyReauthInFlight.delete(origin));
    };

    ipcMain.handle('phi:server-config', async (event) => {
      if (!isMainViewSender(event)) return null;
      const ctrl = this.controller;
      if (!ctrl) return null;
      const st = ctrl.state();
      const active = st.profiles.find((p) => p.id === st.activeId) ?? null;
      if (!active) return null;
      const origin = new URL(active.origin).origin;
      // Coalesce concurrent calls for the same origin. The handler
      // does a racy fetchConfig (which deletes the cookie on 401)
      // before any per-call gate could run; the outer coalescing
      // prevents two stale fetches from both clobbering a
      // freshly-installed cookie.
      const cached = configOpInFlight.get(origin);
      if (cached !== undefined) return cached;
      const promise = (async (): Promise<unknown> => {
        const capture = { profileId: active.id, origin, ts: Date.now() };
        const result = await accessAuth.fetchConfig(origin);
        // A config response for the outgoing server must never repaint the
        // header after the rail has switched to another profile.
        if (ctrl.state().activeId !== capture.profileId) return null;
        if (result.kind === 'ok') return result.config;
        if (result.kind === 'unavailable') return null;
        // result.kind === 'unauthorized': the server requires access.
        // Validate the status before prompting. Re-check active profile at
        // every await point to avoid A-response-after-switch races.
        if (ctrl.state().activeId !== active.id) return null;
        const status = await accessAuth
          .fetchStatus(
            origin,
            pendingUnlock === null ? undefined : pendingUnlock.abort.signal,
          )
          .catch(() => null);
        if (status === null) return null;
        if (status.kind === 'no-auth') {
          // Server reports no auth protection — the unlock is moot.
          const cfg = await accessAuth.fetchConfig(origin).catch(() => null);
          if (ctrl.state().activeId !== capture.profileId) return null;
          return cfg?.kind === 'ok' ? cfg.config : null;
        }
        if (status.kind === 'unavailable') return null;
        // status.kind === 'trusted': server asks for a password. Attempt a
        // silent re-auth from the persisted verifier first — a backend
        // restart wipes in-memory sessions server-side (auth.go keeps the
        // session map in process memory, so any returning client must
        // re-authenticate), and the verifier on disk is exactly the secret
        // that lets us do that without a prompt. Only when no valid
        // credential exists (or the server rotated the salt) do we fall
        // through to the modal below.
        if (pendingUnlock !== null) return null; // one prompt at a time
        if (promptSuppressedFor === origin) return null; // user dismissed; require explicit retry
        if (unlockInFlight) return null;
        const cred = this.getOrRecoverCredential(origin);
        if (cred !== null) {
          // Conservative: compare the server's CURRENT salt/iterations
          // against the stored credential so a confirmed rotation
          // clears it, but a transient network blip (status fetch
          // throws, retry needed) keeps it intact for the next
          // attempt. The outer handler already established `status`
          // is `trusted`, so we can compare against it directly
          // instead of re-fetching.
          const trustMatches =
            status.iterations === cred.iterations &&
            status.salt.equals(cred.salt);
          let unlock: Awaited<
            ReturnType<typeof accessAuth.tryUnlockWithVerifier>
          > | null = null;
          if (trustMatches) {
            const verifierCopy = Buffer.from(cred.verifier);
            try {
              unlock = await accessAuth.tryUnlockWithVerifier(
                origin,
                verifierCopy,
              );
            } finally {
              verifierCopy.fill(0);
            }
          }
          if (unlock?.kind === 'ok' && ctrl.state().activeId === active.id) {
            // Main-process cookie is fresh; the body's Chromium cookie
            // is still stale, so silently re-login + reload it via the
            // verifier cached in AccessAuth.lastVerifier (the typed
            // password never enters the renderer — the trust model is
            // unchanged).
            const bodyResult = await silentBodyReauth(origin, active.id);
            if (!bodyResult.ok) {
              console.log(
                `phi-desktop: silent body reauth ${origin}: ${bodyResult.message}`,
              );
              // The next config poll uses the fresh main cookie and
              // never re-enters the 401 branch, so the body would
              // otherwise stay stuck on its own auth UI. Schedule an
              // independent retry with backoff (coalesced per origin).
              scheduleBodyReauthRetry(origin, active.id);
            }
            const retry = await accessAuth.fetchConfig(origin);
            if (ctrl.state().activeId === active.id) {
              if (retry.kind === 'ok') return retry.config;
              if (retry.kind === 'unauthorized') {
                // Re-auth said ok but the server still rejects — the
                // stored credential is bad. Clear so the prompt that
                // follows re-seeds with a fresh verifier.
                this.clearStoredCredential(origin);
              } else {
                return null; // unavailable
              }
            } else {
              return null;
            }
          } else if (!trustMatches) {
            // Confirmed salt/iteration rotation — the stored verifier
            // is for an old password. Clear so the prompt that
            // follows re-seeds with the current trust settings.
            this.clearStoredCredential(origin);
          } else if (unlock && unlock.kind === 'invalid-password') {
            // The server EVALUATED the HMAC and rejected it: the
            // stored verifier is bad. (rate-limited is NOT a proof
            // rejection — auth.go returns 429 before consuming the
            // challenge, keyed by client IP, so a prior unrelated
            // failed attempt can cause it. Clearing on rate-limit
            // would destroy a valid credential; the next poll or the
            // outer modal will re-evaluate.)
            this.clearStoredCredential(origin);
          }
          // else: trustMatches && (unlock null because the verifier
          // path threw / returned a transient unavailable/stale) —
          // keep the credential and fall through to the modal. The
          // prompt path will retry; if the server is actually
          // unreachable it surfaces 'unavailable' which the renderer
          // never paints as a real prompt.
        }
        pendingUnlock = {
          requestId: randomRequestId(),
          profileId: capture.profileId,
          origin: capture.origin,
          abort: new AbortController(),
          epoch: activeEpoch,
        };
        sendBodyObscuring(true);
        sendAuthRequired({
          requestId: pendingUnlock.requestId,
          profileId: pendingUnlock.profileId,
          origin: pendingUnlock.origin,
          label: active.name !== '' ? active.name : pendingUnlock.origin,
        });
        return null; // caller will retry once phi:auth-unlock resolves
      })();
      configOpInFlight.set(origin, promise);
      promise.finally(() => configOpInFlight.delete(origin));
      return promise;
    });

    ipcMain.handle('phi:active-workspace', async (event) => {
      if (!isMainViewSender(event)) return null;
      const ctrl = this.controller;
      if (!ctrl) return null;
      const st = ctrl.state();
      const active = st.profiles.find((p) => p.id === st.activeId) ?? null;
      if (!active) return null;
      const view = this.viewByOrigin.get(active.origin);
      if (!view || view.webContents.isDestroyed()) return null;
      try {
        const raw = await view.webContents.executeJavaScript(
          READ_WORKSPACE_SCRIPT,
        );
        if (ctrl.state().activeId !== active.id) return null;
        return typeof raw === 'string' && raw !== '' ? raw : null;
      } catch {
        return null;
      }
    });

    ipcMain.handle('phi:auth-unlock', async (event, payload) => {
      if (!isMainViewSender(event))
        return { ok: false, code: 'stale', message: 'forbidden' };
      if (!payload || typeof payload !== 'object') {
        return { ok: false, code: 'unavailable', message: 'missing payload' };
      }
      const { requestId, password } = payload as {
        requestId?: unknown;
        password?: unknown;
      };
      if (
        typeof requestId !== 'string' ||
        (typeof password !== 'string' && password !== null)
      ) {
        return { ok: false, code: 'unavailable', message: 'bad payload' };
      }
      const pending = pendingUnlock;
      if (pending === null || pending.requestId !== requestId) {
        return { ok: false, code: 'stale', message: 'expired' };
      }
      if (password === null) {
        // user dismissed: suppress future prompts for this origin until
        // the active server switches or the app quits.
        promptSuppressedFor = pending.origin;
        pending.abort.abort();
        pendingUnlock = null;
        sendBodyObscuring(false);
        return { ok: false, code: 'stale', message: 'dismissed' };
      }
      if (unlockInFlight) return { ok: false, code: 'stale', message: 'busy' };
      unlockInFlight = true;
      try {
        const result = await accessAuth.tryUnlock(
          pending.origin,
          password,
          pending.abort.signal,
        );
        // Drop the password reference immediately — Node strings aren't
        // guaranteed to zero but we at least release the local binding.
        void password;
        if (pendingUnlock !== pending) {
          return { ok: false, code: 'stale', message: 'replaced' };
        }
        if (result.kind === 'ok') {
          const bodyResult = await authenticateBodyView(pending);
          if (!bodyResult.ok) return bodyResult;
          pendingUnlock = null;
          sendBodyObscuring(false);
          // Persist the verifier for next launch's auto-reauth (the
          // password is never stored — only the PBKDF2 verifier, which
          // the browser itself stores in `localStorage` under the same
          // shape). Without this, every launch prompts for the
          // password even though the user already proved ownership.
          this.persistVerifierAfterUnlock(pending.origin, accessAuth);
          return { ok: true, config: result.config };
        }
        // Wrong-password, rate-limit, and transient failures keep the same
        // prompt and child-view obstruction in place. Clearing either here
        // would reveal the body's browser prompt and force a second entry.
        if (result.kind === 'stale')
          return { ok: false, code: 'stale', message: result.message };
        return { ok: false, code: result.kind, message: result.message };
      } finally {
        unlockInFlight = false;
      }
    });
    // Header interactions relay to the ACTIVE body view's own header (the
    // body's native listeners fire the same /api calls the browser page's
    // header fires). The sender must be the main view page and the action
    // id must be on the fixed whitelist; the workspace value is embedded
    // as a JSON literal by the injected script.
    const HEADER_ACTION_BUTTONS = new Set([
      'header-kanban-btn',
      'header-diff-toggle-btn',
      'header-clipboard-btn',
      'header-btop-btn',
      'header-ntfy-btn',
      'header-config-pill',
      'header-export-btn',
      'header-import-btn',
      'add-workspace-btn',
      'remove-workspace-btn',
    ]);
    ipcMain.handle('phi:header-action', (event, payload: unknown) => {
      if (!isMainViewSender(event)) return;
      const ctrl = this.controller;
      if (!ctrl) return;
      const st = ctrl.state();
      const active = st.profiles.find((p) => p.id === st.activeId) ?? null;
      if (!active) return;
      const view = this.viewByOrigin.get(active.origin);
      if (!view || view.webContents.isDestroyed()) return;
      const action = payload as HeaderAction | null;
      if (action === null || typeof action !== 'object') return;
      if (
        action.kind === 'click' &&
        typeof action.id === 'string' &&
        HEADER_ACTION_BUTTONS.has(action.id)
      ) {
        void view.webContents
          .executeJavaScript(headerActionClickScript(action.id))
          .catch(() => {});
      } else if (
        action.kind === 'workspace' &&
        typeof action.value === 'string' &&
        action.value.length > 0 &&
        action.value.length <= 4096
      ) {
        void view.webContents
          .executeJavaScript(setWorkspaceScript(action.value))
          .catch(() => {});
      }
    });
    // --server <url>: ensure the server exists as a profile — added only
    // when no profile matches the URL — then activate it, via the shared
    // activateServerUrl helper.
    const serverArg = (() => {
      const eqIdx = process.argv.findIndex((a) => a.startsWith('--server='));
      if (eqIdx >= 0) return process.argv[eqIdx].slice('--server='.length);
      const spIdx = process.argv.indexOf('--server');
      return spIdx >= 0 ? process.argv[spIdx + 1] : undefined;
    })();
    if (serverArg !== undefined) this.activateServerUrl(serverArg);
    // Startup restore: when the store already has profiles and no explicit
    // selection (--server) activated one, the MRU profile becomes active.
    if (
      this.controller.state().activeId === '' &&
      this.controller.state().profiles.length > 0
    ) {
      const mru = this.controller.mostRecent();
      if (mru) this.controller.setActive(mru.id);
    }
    // One fire-and-forget probe of every saved / added profile with the
    // real HTTP checker — after the startup selection (--server) and the
    // MRU restore so every profile is present when updateHealth snapshots
    // them. health-changed re-pushes rail-state through the subscribe
    // wiring above.
    void this.controller.updateHealth(realHealthChecker);
    // The 30s liveness poll — fire-and-forget updateHealth probes on the
    // same real checker. Guarded so a second interval is never created.
    if (this.healthInterval === null) {
      this.healthInterval = setInterval(() => {
        void this.controller?.updateHealth(realHealthChecker);
      }, 30_000);
    }
    // Poll every retained view at the remote page's own 2s CPU cadence
    // (never reached in smoke mode — the smoke gate returns before this
    // line).
    if (this.cpuInterval === null) {
      this.cpuInterval = setInterval(() => this.pollCpu(), 2_000);
    }
    // Poll the active view for a recorded file-tree gesture at a short
    // cadence (never reached in smoke mode — the smoke gate returns before
    // this line).
    if (this.fileActionInterval === null) {
      this.fileActionInterval = setInterval(
        () => this.pollFileAction(),
        FILE_ACTION_POLL_MS,
      );
    }
    // Global hotkey: Ctrl/Cmd+Shift+L brings the main window to the
    // foreground. Registered after the tray; unregistered on before-quit.
    // The smoke harness never reaches this line (the PHI_DESKTOP_SMOKE
    // gate), so no real globalShortcut registration ever happens in smoke
    // mode.
    this.hotkeyRegistrations.push(
      registerHotkey(
        resolveAccelerator(),
        () => {
          if (this.mainWindow) {
            if (this.mainWindow.isMinimized()) this.mainWindow.restore();
            // A close-to-tray window is hidden, not minimized — show() brings it back.
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        },
        { log: (msg) => console.log(msg) },
      ),
    );
    // Route this instance's own positional phi:// and http(s):// args
    // exactly like a forwarded second launch, after the page is loaded so
    // the preload's listeners exist. Server payloads go to
    // activateServerUrl; deep links keep the FORWARD_CHANNEL path.
    const ownPayloads = classifyArgv(process.argv.slice(1));
    win.webContents.once('did-finish-load', () => {
      for (const payload of ownPayloads) {
        if (payload.kind === 'server') this.activateServerUrl(payload.value);
        else win.webContents.send(FORWARD_CHANNEL, payload);
      }
    });
    app.on('activate', () => {
      // macOS convention: re-create a window when the dock icon is clicked
      // and none are open.
      if (BrowserWindow.getAllWindows().length === 0) {
        this.mainWindow = this.createMainWindow();
      }
    });
  }
}
