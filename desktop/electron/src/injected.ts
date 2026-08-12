/**
 * Fixed page scripts + validators for desktop-local file actions,
 * divider-width sync, and the Sync Board alarm chime. These run only
 * through main-process executeJavaScript on the retained desktop views
 * (never shipped in web/); the constants are never interpolated with
 * page data. Page values cross the boundary as JSON results
 * (window.__phiFileAction) or as JSON.stringify literals
 * (toastErrorScript, applyDividersScript, PLAY_ALARM_CHIME_SCRIPT).
 */

/** One desktop file-tree gesture recorded by the injected page listener. */
export interface FileAction {
  /** 'open': double-click a file — open with the local default handler; 'folder': right-click — reveal in Explorer. */
  kind: 'open' | 'folder';
  /** CWD-relative path from the file row's title. */
  rel: string;
  /** The active worktree path (the session's CWD). */
  cwd: string;
}

/**
 * Installs delegated dblclick/contextmenu listeners on the file-tree list
 * (idempotent via a window guard) that record the gesture on
 * window.__phiFileAction. Only FILE rows (rows carrying
 * .md-file-icon-doc) record — directory rows and the ⋯ action button are
 * left to the page. Capture phase wins over the page's own row handlers;
 * click-to-insert behavior is untouched.
 */
export const INSTALL_FILE_ACTION_SCRIPT = `(() => {
  if (window.__phiFileActionInstalled) return;
  window.__phiFileActionInstalled = true;
  const list = document.getElementById('file-tree-list');
  if (!list) return;
  const record = (kind, rel, cwd) => {
    window.__phiFileAction = { kind, rel, cwd };
  };
  const activeCwd = () => {
    const section = document.querySelector('.worktree-section.active[data-worktree-path]');
    return section ? (section.getAttribute('data-worktree-path') || '') : '';
  };
  const fileRel = (target) => {
    if (!(target instanceof Element)) return null;
    if (target.closest('.md-file-action-btn')) return null;
    const row = target.closest('.md-file-row');
    if (!row || !row.querySelector('.md-file-icon-doc')) return null;
    const item = row.querySelector('.md-file-item');
    const rel = item ? (item.getAttribute('title') || '') : '';
    return rel === '' ? null : rel;
  };
  list.addEventListener('dblclick', (e) => {
    const rel = fileRel(e.target);
    if (!rel) return;
    e.preventDefault();
    e.stopPropagation();
    record('open', rel, activeCwd());
  }, true);
  list.addEventListener('contextmenu', (e) => {
    const rel = fileRel(e.target);
    if (!rel) return;
    e.preventDefault();
    e.stopPropagation();
    record('folder', rel, activeCwd());
  }, true);
})()`;

/** Reads-and-clears the recorded gesture; null when none is pending. */
export const READ_FILE_ACTION_SCRIPT = `(() => {
  const action = window.__phiFileAction;
  delete window.__phiFileAction;
  return action || null;
})()`;

/**
 * Builds a toast script for a file-action failure. The message is
 * embedded as a JSON.stringify literal (never raw text) and rendered
 * with textContent only. Mirrors the page's own toast DOM
 * (.toast-container > .toast.toast-error, close button, 6s auto-dismiss).
 */
export function toastErrorScript(message: string): string {
  return `(() => {
    const message = ${JSON.stringify(message)};
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast toast-error';
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = '⚠';
    const body = document.createElement('div');
    body.className = 'toast-body';
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = "Couldn't open";
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    body.appendChild(title);
    body.appendChild(msg);
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '×';
    const dismiss = () => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    };
    close.addEventListener('click', dismiss);
    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(close);
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(dismiss, 6000);
  })()`;
}

/** Validates an executeJavaScript result as a FileAction; null when malformed. */
export function parseFileAction(raw: unknown): FileAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.kind !== 'open' && a.kind !== 'folder') return null;
  if (typeof a.rel !== 'string' || a.rel === '') return null;
  if (typeof a.cwd !== 'string' || a.cwd === '') return null;
  return { kind: a.kind, rel: a.rel, cwd: a.cwd };
}

/** One divider-width snapshot read from a retained Phi page. */
export interface Dividers {
  /** Left sidebar width in px (page range 60–450), null when never set. */
  left: number | null;
  /** Right diff-panel width in px (page range 200–600), null when never set. */
  right: number | null;
}

/**
 * Reads the page's persisted divider widths from its own localStorage,
 * clamped to the page's drag ranges (null when a key was never set).
 */
export const READ_DIVIDERS_SCRIPT = `(() => {
  const read = (key, min, max) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  return {
    left: read('phi_panel_left_width', 60, 450),
    right: read('phi_panel_right_width', 200, 600),
  };
})()`;

/** Builds a same-origin, one-time body-login script. Only the public
 *  challenge and its single-use HMAC proof cross into the remote renderer;
 *  the raw password, verifier, and native-fetch cookie never do. A successful
 *  response lets Chromium store a separate HttpOnly cookie for that body
 *  view's shared Electron session. */
export function bodyAuthLoginScript(challenge: string, proof: string): string {
  return `(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge: ${JSON.stringify(challenge)},
        proof: ${JSON.stringify(proof)},
      }),
    });
    return response.status;
  })()`;
}

/**
 * Builds the fixed script that applies a divider snapshot to the page:
 * persists each set key in the view's own localStorage, sets the panel
 * widths inline, toggles .sidebar-narrow for a narrow left panel, and
 * dispatches a window resize so the page's own refit runs. The widths
 * are embedded as JSON.stringify literals (never raw text); a null side
 * leaves that panel untouched.
 */
export function applyDividersScript(left: number | null, right: number | null): string {
  return `(() => {
    const left = ${JSON.stringify(left)};
    const right = ${JSON.stringify(right)};
    if (left !== null) {
      localStorage.setItem('phi_panel_left_width', String(left));
      const sidebar = document.getElementById('sidebar-panel');
      if (sidebar) {
        sidebar.style.width = left + 'px';
        sidebar.classList.toggle('sidebar-narrow', left < 120);
      }
    }
    if (right !== null) {
      localStorage.setItem('phi_panel_right_width', String(right));
      const diff = document.getElementById('diff-panel');
      if (diff) diff.style.width = right + 'px';
    }
    window.dispatchEvent(new Event('resize'));
  })()`;
}

/** Validates an executeJavaScript result as a Dividers snapshot; null when malformed. */
export function parseDividers(raw: unknown): Dividers | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.left !== null && typeof d.left !== 'number') return null;
  if (d.right !== null && typeof d.right !== 'number') return null;
  return { left: d.left as number | null, right: d.right as number | null };
}

/**
 * Builds the fixed Sync Board alarm-chime script: reuses a page-level
 * Audio element for the bell asset URL (embedded as a JSON.stringify
 * literal) and plays a bounded burst of up to 3 rings ~1s apart. Never
 * touches window focus.
 */
export function PLAY_ALARM_CHIME_SCRIPT(assetUrl: string): string {
  return `(() => {
    const url = ${JSON.stringify(assetUrl)};
    const maxPlays = ${JSON.stringify(3)};
    const gapMs = ${JSON.stringify(1000)};
    let audio = window.__phiAlarmChimeAudio;
    if (!audio) {
      audio = new Audio(url);
      window.__phiAlarmChimeAudio = audio;
    }
    let plays = 0;
    const ring = () => {
      if (plays >= maxPlays) return;
      plays += 1;
      audio.currentTime = 0;
      void audio.play().catch(() => {});
      window.setTimeout(ring, gapMs);
    };
    ring();
  })()
`;
}

/**
 * Fixed click-dispatch script for a BODY header element id (the caller
 * whitelists the id; the id is embedded as a JSON.stringify literal, never
 * interpolated raw). The body's own listeners then fire the same /api
 * calls the browser page's header fires.
 */
export function headerActionClickScript(id: string): string {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return false;
    el.click();
    return true;
  })()
`;
}

/**
 * Fixed script that sets the BODY's project selector to a workspace value
 * and dispatches its native change event, so the page's own
 * workspace-change handling (worktree reload, diff refresh, its local
 * persisted choice) runs. The value is embedded as a JSON.stringify
 * literal; the option must exist or the script is a no-op.
 */
export function setWorkspaceScript(value: string): string {
  return `(() => {
    const select = document.getElementById('workspace-select');
    if (!select) return false;
    if (![...select.options].some((o) => o.value === ${JSON.stringify(value)})) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`;
}
