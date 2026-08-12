/* ----- THIS CODE IS GENERATED DO NOT EDIT ------- */
/* ----- THIS CODE IS GENERATED DO NOT EDIT ------- */
/* ----- THIS CODE IS GENERATED DO NOT EDIT ------- */
/* ----- THIS CODE IS GENERATED DO NOT EDIT ------- */
/* ----- THIS CODE IS GENERATED DO NOT EDIT ------- */

/* Desktop main view page — header wiring.

   The header DOM is the vendored `.app-header` from the browser Phi page
   and its behavior runs the browser Phi code: this module imports the
   vendored sources (web/app.js, web/util.js, web/sessions.js) and drives
   the header with their exported helpers — displayHostname, the
   workspace-label helpers, the ACCENT_COLORS palette and the theme
   application method — instead of reimplementing them. Only the
   desktop-local parts live here: the caption controls (preload bridge),
   the action-cluster relay to the active body view, and the config
   refresh triggered by active-server pushes. */
import { ACCENT_COLORS, App } from './vendor/app.js';
import { displayHostname, formatWorkspaceLabel } from './vendor/util.js';
import { SessionsManager } from './vendor/sessions.js';
import { applyBrandCpuTier, applyTerminalActivityIndicator } from './vendor/header-state.js';

(() => {
  'use strict';

  const header = document.querySelector('.app-header');
  if (!header) return;

  const hostnameDisplay = document.getElementById('hostname-display');
  const workspaceSelect = document.getElementById('workspace-select');
  const addWorkspaceBtn = document.getElementById('add-workspace-btn');
  const removeWorkspaceBtn = document.getElementById('remove-workspace-btn');

  /** Workspace label: the canonical browser formatting (web/util.js). */
  function workspaceLabel(ws, all) {
    return formatWorkspaceLabel(ws, all);
  }

  /** Auto-width the project selector via the browser's own method
   *  (web/sessions.js SessionsManager.updateWorkspaceSelectWidth),
   *  invoked on a minimal receiver that only carries the two fields the
   *  method reads. */
  function updateWorkspaceSelectWidth() {
    if (!workspaceSelect) return;
    SessionsManager.prototype.updateWorkspaceSelectWidth.call({
      workspaceSelect,
      _measureSpan: null,
    });
  }

  /** Apply the active server's theme via the browser's own method
   *  (web/app.js App.applyAccentTheme): it sets --accent/--accent-glow/
   *  --accent-dim/--accent-bright from the vendored ACCENT_COLORS map
   *  (all 22 themes), marks data-theme-color, and persists the choice.
   *  The shim carries no TabManager (the header has no terminals) and
   *  stubs updateFavicon (the window icon is host-owned). */
  function applyAccentTheme(colorKey) {
    const shim = Object.create(App.prototype);
    shim.updateFavicon = () => {};
    App.prototype.applyAccentTheme.call(shim, colorKey);
  }

  /** Populate the header from the ACTIVE server's /api/config. */
  async function refreshConfig() {
    let config;
    try {
      config = await window.electron.fetchServerConfig();
    } catch {
      return; // server unreachable; keep the last rendered state
    }
    if (!config || typeof config !== 'object') return;
    if (hostnameDisplay) {
      hostnameDisplay.innerText = displayHostname(config.hostname);
    }
    if (workspaceSelect && Array.isArray(config.workspaces)) {
      const previous = workspaceSelect.value;
      workspaceSelect.textContent = '';
      for (const ws of config.workspaces) {
        const opt = document.createElement('option');
        opt.value = ws;
        opt.textContent = workspaceLabel(ws, config.workspaces);
        opt.title = ws;
        workspaceSelect.appendChild(opt);
      }
      const active = typeof config.active_cwd === 'string' ? config.active_cwd : '';
      workspaceSelect.value =
        active !== '' && config.workspaces.includes(active)
          ? active
          : previous !== '' && config.workspaces.includes(previous)
            ? previous
            : config.workspaces[0] ?? '';
      updateWorkspaceSelectWidth();
    }
    if (typeof config.theme_color === 'string') applyAccentTheme(config.theme_color);
  }

  // --- Window controls (local; the main process validates the sender) ---
  const minimizeBtn = document.getElementById('caption-minimize');
  const maximizeBtn = document.getElementById('caption-maximize');
  const closeBtn = document.getElementById('caption-close');
  if (minimizeBtn) minimizeBtn.addEventListener('click', () => window.electron.postWindowMinimize());
  if (maximizeBtn) maximizeBtn.addEventListener('click', () => window.electron.postWindowToggleMaximize());
  if (closeBtn) closeBtn.addEventListener('click', () => window.electron.postWindowClose());
  window.electron.onWindowState((state) => {
    if (maximizeBtn) {
      maximizeBtn.textContent = state.isMaximized ? '❐' : '□';
      maximizeBtn.setAttribute('aria-label', state.isMaximized ? 'Restore' : 'Maximize');
      maximizeBtn.title = state.isMaximized ? 'Restore' : 'Maximize';
    }
    document.body.classList.toggle('focused', state.focused);
  });
  window.electron.onWindowTitle((title) => {
    document.title = title === '' ? 'Phi' : title;
  });

  // --- Project selector: the server is the channel (the body's native
  // --- workspace-change handler re-renders the body's sessions) ---
  if (workspaceSelect) {
    workspaceSelect.addEventListener('change', () => {
      updateWorkspaceSelectWidth();
      window.electron.postHeaderAction({ kind: 'workspace', value: workspaceSelect.value });
    });
  }
  if (addWorkspaceBtn) {
    addWorkspaceBtn.addEventListener('click', () =>
      window.electron.postHeaderAction({ kind: 'click', id: 'add-workspace-btn' }),
    );
  }
  if (removeWorkspaceBtn) {
    removeWorkspaceBtn.addEventListener('click', () =>
      window.electron.postHeaderAction({ kind: 'click', id: 'remove-workspace-btn' }),
    );
  }

  // --- Action cluster: relay to the body's own header (the body's
  // --- listeners fire the same /api calls the browser page fires) ---
  const ACTION_BUTTONS = [
    'header-clipboard-btn',
    'header-ntfy-btn',
    'header-btop-btn',
    'header-kanban-btn',
    'header-diff-toggle-btn',
  ];
  for (const id of ACTION_BUTTONS) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => window.electron.postHeaderAction({ kind: 'click', id }));
    }
  }
  const configPill = document.getElementById('header-config-pill');
  if (configPill) {
    configPill.addEventListener('click', () =>
      window.electron.postHeaderAction({ kind: 'click', id: 'header-config-pill' }),
    );
  }

  // --- Server sync: refresh on profile activation and on a light cadence
  // --- (the server exposes no push channel for config) ---
  window.electron.onActiveServer(() => {
    void refreshConfig();
  });
  void refreshConfig();
  setInterval(() => void refreshConfig(), 10_000);

  // --- Access-auth modal: shown when the main process pushes
  // 'phi:auth-required' (the active server requires a password). The
  // main view page cannot paint over a child WebContentsView, so we
  // also listen for 'phi:body-obscuring' and toggle a class that the
  // CSS uses to dim the workspace / action cluster (the body region is
  // already hidden by the main process via ProfileViewManager). ---
  const authModal = document.getElementById('desktop-auth-modal');
  const authOriginEl = document.getElementById('desktop-auth-origin');
  const authInputEl = document.getElementById('desktop-auth-input');
  const authErrorEl = document.getElementById('desktop-auth-error');
  const authCancelBtn = document.getElementById('desktop-auth-cancel');
  const authSubmitBtn = document.getElementById('desktop-auth-submit');
  const authCard = authModal?.querySelector('.desktop-auth-card');
  let authRequestId = null;
  let authProfileId = null; // first push after launch initializes this; we accept any first push

  const closeAuthModal = () => {
    if (authModal) authModal.hidden = true;
    if (authInputEl) authInputEl.value = '';
    if (authErrorEl) authErrorEl.textContent = '';
    authRequestId = null;
    authProfileId = null;
  };
  const openAuthModal = (info) => {
    if (!authModal || !authOriginEl || !authInputEl || !authErrorEl || !authSubmitBtn || !authCancelBtn) return;
    authRequestId = info.requestId;
    authProfileId = info.profileId;
    authOriginEl.textContent = info.label ?? info.origin;
    authErrorEl.textContent = '';
    authInputEl.value = '';
    authSubmitBtn.disabled = false;
    authCancelBtn.disabled = false;
    authModal.hidden = false;
    requestAnimationFrame(() => authInputEl.focus());
  };
  const acceptAuthPrompt = (info) => {
    // Accept the prompt if we have no current request, OR if the
    // request id matches a stale one we already opened (so a re-push
    // for the same pending unlock refreshes the modal). Reject only if
    // a different pending unlock is already open.
    if (authRequestId === null) return true;
    return authRequestId === info.requestId;
  };

  const submitAuth = async () => {
    if (authRequestId === null) return;
    const password = authInputEl?.value ?? '';
    if (password.length < 8) {
      if (authErrorEl) authErrorEl.textContent = 'Password is at least 8 characters.';
      return;
    }
    if (authSubmitBtn) authSubmitBtn.disabled = true;
    if (authCancelBtn) authCancelBtn.disabled = true;
    const result = await window.electron.submitAccessPassword(authRequestId, password);
    if (authSubmitBtn) authSubmitBtn.disabled = false;
    if (authCancelBtn) authCancelBtn.disabled = false;
    if (!result || result.ok === undefined) {
      closeAuthModal();
      return;
    }
    if (result.ok) {
      closeAuthModal();
      // Re-pull /api/config with the captured cookie.
      void refreshConfig();
      return;
    }
    // Failures keep the modal open with an inline error and clear the input.
    const code = result.code ?? 'unavailable';
    const msg = (result.message ?? '').slice(0, 200);
    if (authErrorEl) authErrorEl.textContent = msg !== '' ? msg : codeErrorText(code);
    if (authInputEl) {
      authInputEl.value = '';
      authInputEl.focus();
    }
  };

  const dismissAuth = async () => {
    if (authRequestId === null) return;
    const id = authRequestId;
    closeAuthModal();
    await window.electron.submitAccessPassword(id, null);
  };

  if (authSubmitBtn) authSubmitBtn.addEventListener('click', () => void submitAuth());
  if (authCancelBtn) authCancelBtn.addEventListener('click', () => void dismissAuth());
  if (authCard) authCard.addEventListener('submit', (e) => { e.preventDefault(); void submitAuth(); });
  if (authInputEl) authInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      void dismissAuth();
    }
  });

  window.electron.onAuthRequired((info) => {
    if (!acceptAuthPrompt(info)) {
      // A different unlock prompt is already in flight; ignore the new
      // one (the main process suppresses pushes for that reason).
      return;
    }
    openAuthModal(info);
  });
  // Cancel an open modal if the active server switches to a profile
  // OTHER than the one this modal is for. The controller fires
  // 'active-changed' for the persisted MRU on launch; if the active id
  // happens to match the modal's profile id, leave the modal alone
  // (otherwise the initial MRU event would close the modal that the
  // 401-triggered prompt just opened).
  window.electron.onActiveServer((info) => {
    if (info && typeof info.id === 'string' && info.id === authProfileId) return;
    closeAuthModal();
  });

  // Toggle the visual dim of the TBAR chrome while a modal is open.
  // (The body view is hidden by the main process; the dim is purely for
  //  the TBAR, which is on the main view's webContents.)
  window.electron.onBodyObscuring((obscured) => {
    document.body.classList.toggle('desktop-body-obscured', obscured);
  });

  // Dynamic brand-state push from the host. The active server's CPU
  // percent and terminal-activity flag are polled by the host (every
  // ~2s via `pollCpu`) and forwarded here. The main view's brand
  // cluster runs the same `web/header-state.js` helpers the browser
  // Phi page calls from `web/terminal.js` — same code path, same
  // DOM mutations, PLAN5 single source of truth. The `hostnameKnown`
  // argument is `true` on the desktop because the active server's
  // hostname is always known by the time the main view is up (the
  // unlock modal flow uses it).
  window.electron.onHeaderState((state) => {
    if (!state) return;
    applyBrandCpuTier(state.cpuPercent ?? 0);
    applyTerminalActivityIndicator(Boolean(state.terminalActivity), true);
  });
})();

function codeErrorText(code) {
  if (code === 'invalid-password') return 'Password not accepted.';
  if (code === 'rate-limited') return 'Too many attempts. Try again later.';
  if (code === 'stale') return 'Prompt expired. Re-open the server.';
  return 'Unable to reach the server.';
}
