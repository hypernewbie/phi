/**
 * Ambient typing for the preload bridge surface exposed on window.electron
 * (see src/preload.ts — the two sides must stay in sync).
 *
 * The rail payload types (RailProfile/RailHealth/RailState) live here — the
 * typed preload surface — so both src/preload.ts (the bridge) and
 * src/renderer.ts (the consumer) import them type-only from './electron.js'.
 */
import type { DeepLink } from './deeplink.js';
import type { ForwardPayload } from './single-instance.js';

/** One saved server profile as shown on the rail. */
export interface RailProfile {
  id: string;
  name: string;
  origin: string;
  /** Canonical hostname observed on the remote Phi page ('' until observed). */
  hostname: string;
  /** The server's --accent token ('' until observed). */
  accent: string;
  /** The server's CPU percent from its remote page (null until observed or when its view is gone). */
  cpu: number | null;
}

export type RailHealth = 'up' | 'down' | 'unknown';

/** Rail snapshot pushed by the main process on 'phi:rail-state'. */
export interface RailState {
  profiles: RailProfile[];
  activeId: string;
  health: Record<string, RailHealth>;
  unread: Record<string, number>;
}

/** Result of an add-server request pushed by the main process on 'phi:add-server-result'. */
export interface AddServerResult {
  ok: boolean;
  message?: string;
}

/** Window chrome state pushed to the main view page on 'phi:window-state'. */
export interface WindowState {
  isMaximized: boolean;
  focused: boolean;
}

/** Header action-cluster button ids the main process may relay to the active body view. */
export type HeaderActionId =
  | 'header-kanban-btn'
  | 'header-diff-toggle-btn'
  | 'header-clipboard-btn'
  | 'header-btop-btn'
  | 'header-ntfy-btn'
  | 'header-config-pill'
  | 'add-workspace-btn'
  | 'remove-workspace-btn';

/** A header interaction relayed to the ACTIVE body view on 'phi:header-action'. */
export type HeaderAction =
  | { kind: 'click'; id: HeaderActionId }
  | { kind: 'workspace'; value: string };

/** The active server pushed to the main view page on 'phi:active-server'. */
export interface ActiveServer {
  id: string;
  origin: string;
  /** The body's observed --accent token ('' until observed). */
  accent: string;
}

/** The dynamic brand-state snapshot pushed to the main view page on
 *  'phi:header-state'. The main view calls the same
 *  `web/header-state.js` helpers the browser Phi page uses to apply
 *  these to the vendored `.app-header` brand cluster (CPU tier class
 *  on `.brand .logo` + `.brand .brand-name`; `is-active` class on
 *  `#terminal-activity-indicator`). See `web/header-state.js`. */
export interface HeaderState {
  /** Active server's CPU utilisation percentage (0..100) or null when
   *  the body has not published a reading yet. */
  cpuPercent: number | null;
  /** True when any terminal tab on the body is producing output. */
  terminalActivity: boolean;
  /** Active server's active workspace path, or null if unknown. */
  workspace?: string | null;
}

/** The main view page receives this when the active server returns 401
 *  on /api/config and the server's /api/auth/status is enabled. The
 *  paired `requestId` is the only handle the main view page may send
 *  back on the unlock channel; mismatches yield a 'stale' result. */
export interface AuthRequired {
  requestId: string;
  profileId: string;
  origin: string;
  label: string;
}

/** Result of the unlock round-trip. */
export type AuthUnlockCode =
  | 'invalid-password'
  | 'rate-limited'
  | 'unavailable'
  | 'stale';

export interface AuthUnlockOk {
  ok: true;
  /** When non-null, the unlocked /api/config payload (renderer applies). */
  config: unknown;
}
export interface AuthUnlockFail {
  ok: false;
  code: AuthUnlockCode;
  message: string;
}
export type AuthUnlockResult = AuthUnlockOk | AuthUnlockFail;

export interface ElectronApi {
  /** Subscribe to parsed deep links (channel 'phi:deeplink'); returns an unsubscribe function. */
  onDeeplink(cb: (link: DeepLink) => void): () => void;
  /** Subscribe to forwarded second-launch args (channel 'phi:single-instance-forward'); returns an unsubscribe function. */
  onForwardPayload(cb: (payload: ForwardPayload) => void): () => void;
  /** Subscribe to rail state snapshots (channel 'phi:rail-state'); returns an unsubscribe function. */
  onRailState(cb: (state: RailState) => void): () => void;
  /** Subscribe to add-server results (channel 'phi:add-server-result'); returns an unsubscribe function. */
  onAddServerResult(cb: (result: AddServerResult) => void): () => void;
  /** Ask the main process to activate a saved profile (channel 'phi:select-profile'). */
  postSelectProfile(id: string): void;
  /** Ask the main process to open a saved profile's own session selector on its retained view (channel 'phi:open-server-sessions'). */
  postOpenServerSessions(id: string): void;
  /** Ask the main process to open the add-server picker (channel 'phi:open-picker'). */
  postOpenPicker(): void;
  /** Ask the main process to add a server profile from a raw URL (channel 'phi:add-server'). */
  postAddServer(url: string): void;
  /** Ask the main process to rename a saved profile (channel 'phi:rename-profile'). */
  postRenameProfile(id: string, name: string): void;
  /** Ask the main process to remove a saved profile (channel 'phi:remove-profile'). */
  postRemoveProfile(id: string): void;
  /** Ask the main process to move a saved profile before another in rail order; null moves it to the end (channel 'phi:reorder-profile'). */
  postReorderProfile(id: string, beforeId: string | null): void;
  /** Ask the main process to reload a saved server view (channel 'phi:reload-profile'). */
  postReloadServer(id?: string): void;
  /** Ask the main process to reload all retained server views (channel 'phi:reload-all-servers'). */
  postReloadAllServers(): void;
  /** Ask the main process to minimize the window (channel 'phi:window-minimize'). */
  postWindowMinimize(): void;
  /** Ask the main process to toggle the window between maximized and restored (channel 'phi:window-toggle-maximize'). */
  postWindowToggleMaximize(): void;
  /** Ask the main process to close the window (channel 'phi:window-close'). */
  postWindowClose(): void;
  /** Subscribe to caption-island window state (channel 'phi:window-state'); returns an unsubscribe function. */
  onWindowState(cb: (state: WindowState) => void): () => void;
  /** Subscribe to the observed remote title for the main view page (channel 'phi:window-title'); returns an unsubscribe function. */
  onWindowTitle(cb: (title: string) => void): () => void;
  /** Resolve the ACTIVE server's /api/config JSON through the main process (channel 'phi:server-config'). */
  fetchServerConfig(): Promise<unknown>;
  /** Relay a header interaction to the active body view (channel 'phi:header-action'). */
  postHeaderAction(action: HeaderAction): void;
  /** Read the active retained body's own workspace selector (channel 'phi:active-workspace'). */
  fetchActiveWorkspace(): Promise<string | null>;
  /** Subscribe to active-server changes (channel 'phi:active-server'); returns an unsubscribe function. */
  onActiveServer(cb: (info: ActiveServer) => void): () => void;
  /** Subscribe to access-auth prompts (channel 'phi:auth-required');
   *  the main view page shows a modal and calls submitAccessPassword
   *  when the user types a password. Returns an unsubscribe function. */
  onAuthRequired(cb: (info: AuthRequired) => void): () => void;
  /** Subscribe to body-view obscuring toggles (channel 'phi:body-obscuring');
   *  the main view page dims the body's pane while a modal is open and
   *  re-shows it on dismiss/unlock. Returns an unsubscribe function. */
  onBodyObscuring(cb: (obscured: boolean) => void): () => void;
  /** Reply to an access-auth prompt with a password (or null to dismiss).
   *  The main process validates requestId; mismatches yield 'stale'. */
  submitAccessPassword(requestId: string, password: string | null): Promise<AuthUnlockResult>;
}

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
