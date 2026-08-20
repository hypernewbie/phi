/**
 * Preload bridge for the phi-desktop shell renderer (sandboxed, context
 * isolated). Exposes a minimal receive-only typed surface on
 * window.electron:
 *
 *   - onDeeplink(cb):        subscribe to parsed deep links dispatched by
 *                            the main process (channel 'phi:deeplink');
 *                            returns an unsubscribe function.
 *   - onForwardPayload(cb):  subscribe to forwarded second-launch args
 *                            (channel 'phi:single-instance-forward');
 *                            returns an unsubscribe function.
 *   - onRailState(cb):       subscribe to rail state snapshots pushed by
 *                            the main process (channel 'phi:rail-state');
 *                            returns an unsubscribe function.
 *   - postSelectProfile(id): tell the main process to activate a saved
 *                            profile (channel 'phi:select-profile').
 *   - postOpenServerSessions(id): tell the main process to open a saved
 *                            profile's own session selector on its
 *                            retained view (channel
 *                            'phi:open-server-sessions').
 *   - postOpenPicker():      tell the main process to open the add-server
 *                            picker (channel 'phi:open-picker').
 *   - postAddServer(url):    tell the main process to add a server profile
 *                            from a raw URL (channel 'phi:add-server').
 *   - postRenameProfile(id, name): tell the main process to rename a saved
 *                            profile (channel 'phi:rename-profile').
 *   - postRemoveProfile(id): tell the main process to remove a saved
 *                            profile (channel 'phi:remove-profile').
 *   - postReorderProfile(id, beforeId): tell the main process to move a
 *                            saved profile before another in rail order
 *                            (null moves it to the end) (channel
 *                            'phi:reorder-profile').
 *   - postWindowMinimize()/postWindowToggleMaximize()/postWindowClose():
 *                            main-view-page window controls (channels
 *                            'phi:window-minimize', 'phi:window-toggle-maximize',
 *                            'phi:window-close'; the main process rejects
 *                            any other sender).
 *   - onWindowState(cb):     subscribe to main-view-page window state
 *                            (channel 'phi:window-state' — isMaximized +
 *                            focused); returns an unsubscribe function.
 *   - onWindowTitle(cb):     subscribe to the observed remote title for
 *                            the main view page (channel 'phi:window-title');
 *                            returns an unsubscribe function.
 *   - fetchServerConfig():   resolve the ACTIVE server's /api/config JSON
 *                            through the main process (channel
 *                            'phi:server-config' — the main process
 *                            fetches the active profile origin, so the
 *                            file:// main view page never fetches a
 *                            remote origin directly).
 *   - postHeaderAction(action): relay a header interaction (action-cluster
 *                            click or project-selection change) to the
 *                            active body view (channel
 *                            'phi:header-action').
 *   - onActiveServer(cb):    subscribe to active-server changes (channel
 *                            'phi:active-server' — id + origin + observed
 *                            accent); returns an unsubscribe function.
 *
 * The bridge receives main→renderer pushes (deeplink, forward-payload,
 * rail-state, window-state, window-title) and sends renderer→main requests
 * (select-profile, open-server-sessions, open-picker, add-server,
 * rename-profile, remove-profile, reorder-profile, window-minimize,
 * window-toggle-maximize, window-close). The renderer→main 'phi:deeplink'
 * relay is wired in main.ts for later slices.
 *
 * Note: this file is emitted as CommonJS (tsconfig.preload.json) because
 * sandboxed preload scripts cannot be ESM. Channel strings are literal here
 * on purpose — the preload build must not pull in the ESM src modules.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DeepLink } from './deeplink.js';
import type { ForwardPayload } from './single-instance.js';
import type {
  ActiveServer,
  AddServerResult,
  AuthRequired,
  AuthUnlockResult,
  HeaderAction,
  HeaderState,
  RailState,
  WindowState,
} from './electron.js';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electron', {
  onDeeplink: (cb: (link: DeepLink) => void): (() => void) =>
    subscribe('phi:deeplink', cb),
  onForwardPayload: (cb: (payload: ForwardPayload) => void): (() => void) =>
    subscribe('phi:single-instance-forward', cb),
  onRailState: (cb: (state: RailState) => void): (() => void) =>
    subscribe('phi:rail-state', cb),
  onAddServerResult: (cb: (result: AddServerResult) => void): (() => void) =>
    subscribe('phi:add-server-result', cb),
  postSelectProfile: (id: string): void => {
    ipcRenderer.send('phi:select-profile', id);
  },
  postOpenServerSessions: (id: string): void => {
    ipcRenderer.send('phi:open-server-sessions', id);
  },
  postOpenPicker: (): void => {
    ipcRenderer.send('phi:open-picker');
  },
  postAddServer: (url: string): void => {
    ipcRenderer.send('phi:add-server', url);
  },
  postRenameProfile: (id: string, name: string): void => {
    ipcRenderer.send('phi:rename-profile', id, name);
  },
  postRemoveProfile: (id: string): void => {
    ipcRenderer.send('phi:remove-profile', id);
  },
  postReorderProfile: (id: string, beforeId: string | null): void => {
    ipcRenderer.send('phi:reorder-profile', id, beforeId);
  },
  postReloadServer: (id?: string): void => {
    ipcRenderer.send('phi:reload-profile', id);
  },
  postReloadAllServers: (): void => {
    ipcRenderer.send('phi:reload-all-servers');
  },
  // Main-view-page window controls: invoke channels handled in desktop.ts
  // (the main process rejects any other sender).
  postWindowMinimize: (): void => {
    void ipcRenderer.invoke('phi:window-minimize');
  },
  postWindowToggleMaximize: (): void => {
    void ipcRenderer.invoke('phi:window-toggle-maximize');
  },
  postWindowClose: (): void => {
    void ipcRenderer.invoke('phi:window-close');
  },
  onWindowState: (cb: (state: WindowState) => void): (() => void) =>
    subscribe('phi:window-state', cb),
  onWindowTitle: (cb: (title: string) => void): (() => void) =>
    subscribe('phi:window-title', cb),
  // The main view page resolves the active server's config through the
  // main process (no cross-origin fetch from a file:// page; the main
  // process validates the sender and pins the path to /api/config).
  fetchServerConfig: (): Promise<unknown> =>
    ipcRenderer.invoke('phi:server-config'),
  // Relay a header interaction to the active body view (the main process
  // validates the sender and the action id).
  postHeaderAction: (action: HeaderAction): void => {
    void ipcRenderer.invoke('phi:header-action', action);
  },
  // Read the active body view's own workspace selector. Each retained
  // server view has independent local state, so the main header must
  // not reuse the previous server's selection.
  fetchActiveWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke('phi:active-workspace'),
  onActiveServer: (cb: (info: ActiveServer) => void): (() => void) =>
    subscribe('phi:active-server', cb),
  // Dynamic brand-state push: the active server's CPU percent and
  // terminal-activity flag, polled by the host and forwarded to the
  // main view page. The renderer applies these via web/header-state.js
  // (same helpers the browser Phi page calls).
  onHeaderState: (cb: (state: HeaderState) => void): (() => void) =>
    subscribe('phi:header-state', cb),
  // Access-auth: the main process pairs an unlock prompt by requestId;
  // the renderer passes the password (or null to dismiss) through this
  // single invoke channel. The main process forgets the password string
  // the moment it finishes the handshake.
  onAuthRequired: (cb: (info: AuthRequired) => void): (() => void) =>
    subscribe('phi:auth-required', cb),
  onBodyObscuring: (cb: (obscured: boolean) => void): (() => void) =>
    subscribe('phi:body-obscuring', cb),
  submitAccessPassword: (
    requestId: string,
    password: string | null,
  ): Promise<AuthUnlockResult> =>
    ipcRenderer.invoke('phi:auth-unlock', { requestId, password }),
});
