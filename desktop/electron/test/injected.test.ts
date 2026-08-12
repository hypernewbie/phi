/**
 * Unit tests for the desktop-local file-action page scripts + validators
 * (src/injected.ts). The install/read scripts are fixed constants — they
 * are never interpolated with page data; page values cross the boundary
 * as JSON results (window.__phiFileAction) or JSON.stringify literals
 * (toastErrorScript). jsdom exercises the scripts against a fixture of
 * the page's file-tree DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../src/injected.js';

/** The injected scripts' recording surface (window.__phiFileAction / guard). */
function windowField(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

describe('parseFileAction (the main-process validator)', () => {
  it('accepts a well-formed open gesture', () => {
    expect(parseFileAction({ kind: 'open', rel: 'docs/plan.md', cwd: 'C:\\work' })).toEqual({
      kind: 'open',
      rel: 'docs/plan.md',
      cwd: 'C:\\work',
    });
  });

  it('accepts a well-formed folder gesture', () => {
    expect(parseFileAction({ kind: 'folder', rel: 'a/b.txt', cwd: '/srv/work' })).toEqual({
      kind: 'folder',
      rel: 'a/b.txt',
      cwd: '/srv/work',
    });
  });

  it('rejects non-objects and unknown kinds', () => {
    expect(parseFileAction(null)).toBeNull();
    expect(parseFileAction(undefined)).toBeNull();
    expect(parseFileAction('open')).toBeNull();
    expect(parseFileAction({ kind: 'delete', rel: 'x', cwd: 'y' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: 'x', cwd: 'y', extra: 1 })).toEqual({
      kind: 'open',
      rel: 'x',
      cwd: 'y',
    });
  });

  it('rejects missing or empty rel/cwd', () => {
    expect(parseFileAction({ kind: 'open', cwd: 'y' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: '', cwd: 'y' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: 5, cwd: 'y' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: 'x' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: 'x', cwd: '' })).toBeNull();
    expect(parseFileAction({ kind: 'open', rel: 'x', cwd: null })).toBeNull();
  });
});

describe('the injected script constants', () => {
  it('are fixed constants with no template interpolation (never page-data interpolated)', () => {
    expect(INSTALL_FILE_ACTION_SCRIPT).not.toContain('${');
    expect(READ_FILE_ACTION_SCRIPT).not.toContain('${');
  });

  it('install the listeners on the documented fixed selectors', () => {
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("getElementById('file-tree-list')");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'.md-file-row'");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'.md-file-item'");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'.md-file-icon-doc'");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'.worktree-section.active[data-worktree-path]'");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'open'");
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain("'folder'");
  });

  it('guard the listener install with a window flag (idempotent injection)', () => {
    expect(INSTALL_FILE_ACTION_SCRIPT).toContain('window.__phiFileActionInstalled');
  });

  it('read-and-clear the recorded gesture field', () => {
    expect(READ_FILE_ACTION_SCRIPT).toContain('delete window.__phiFileAction');
  });
});

describe('the install script against the file-tree DOM (jsdom)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="worktree-section active" data-worktree-path="C:\\work"></div>
      <div id="file-tree-list">
        <div class="md-file-row">
          <button class="md-file-item" title="docs/plan.md">
            <svg class="md-file-icon md-file-icon-doc"></svg><span class="md-file-name">plan.md</span>
          </button>
          <button class="md-file-action-btn">⋯</button>
        </div>
        <div class="md-file-row">
          <button class="md-file-item" title="src">
            <span class="ft-chevron">▸</span><span class="md-file-name">src</span>
          </button>
        </div>
      </div>`;
    window.eval(INSTALL_FILE_ACTION_SCRIPT);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete windowField().__phiFileAction;
    delete windowField().__phiFileActionInstalled;
  });

  it('records an open gesture on double-click of a file row', () => {
    const item = document.querySelector<HTMLElement>('.md-file-item')!;
    const ev = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    item.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(windowField().__phiFileAction).toEqual({
      kind: 'open',
      rel: 'docs/plan.md',
      cwd: 'C:\\work',
    });
  });

  it('records a folder gesture on right-click of a file row and suppresses the page handlers', () => {
    let pageHandlerRan = false;
    document.querySelector<HTMLElement>('.md-file-item')!.addEventListener('contextmenu', () => {
      pageHandlerRan = true;
    });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector<HTMLElement>('.md-file-item')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pageHandlerRan).toBe(false);
    expect(windowField().__phiFileAction).toEqual({
      kind: 'folder',
      rel: 'docs/plan.md',
      cwd: 'C:\\work',
    });
  });

  it('ignores directory rows and the action button', () => {
    const dirItem = document.querySelectorAll<HTMLElement>('.md-file-item')[1];
    dirItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const btn = document.querySelector<HTMLElement>('.md-file-action-btn')!;
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(windowField().__phiFileAction).toBeUndefined();
  });

  it('is idempotent: a second install does not break recording', () => {
    window.eval(INSTALL_FILE_ACTION_SCRIPT);
    const item = document.querySelector<HTMLElement>('.md-file-item')!;
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(windowField().__phiFileAction).toEqual({
      kind: 'open',
      rel: 'docs/plan.md',
      cwd: 'C:\\work',
    });
  });

  it('read-and-clears the recorded gesture once', () => {
    const item = document.querySelector<HTMLElement>('.md-file-item')!;
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const first = window.eval(READ_FILE_ACTION_SCRIPT);
    const second = window.eval(READ_FILE_ACTION_SCRIPT);
    expect(first).toEqual({ kind: 'open', rel: 'docs/plan.md', cwd: 'C:\\work' });
    expect(second).toBeNull();
  });
});

describe('toastErrorScript', () => {
  it('embeds the message as a JSON.stringify literal, never raw text', () => {
    const script = toastErrorScript('a"b\\c');
    expect(script).toContain('"a\\"b\\\\c"');
    expect(script).not.toContain('a"b\\c');
  });

  it('builds Phi toast DOM with textContent only', () => {
    const script = toastErrorScript('boom');
    expect(script).toContain("'toast-container'");
    expect(script).toContain("'toast toast-error'");
    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
  });

  it('renders a dismissible error toast in the page (jsdom)', () => {
    window.eval(toastErrorScript('"plan.md" — not found on this machine'));
    const toast = document.querySelector<HTMLElement>('.toast-container .toast.toast-error')!;
    expect(toast).not.toBeNull();
    expect(toast.querySelector<HTMLElement>('.toast-message')!.textContent).toBe(
      '"plan.md" — not found on this machine',
    );
    expect(toast.querySelector<HTMLElement>('.toast-title')!.textContent).toBe("Couldn't open");
    expect(toast.querySelector<HTMLElement>('.toast-close')).not.toBeNull();
  });
});

describe('the divider-width page scripts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('is a fixed constant with no template interpolation (never page-data interpolated)', () => {
    expect(READ_DIVIDERS_SCRIPT).not.toContain('${');
  });

  it('reads the documented localStorage keys with the page drag ranges', () => {
    expect(READ_DIVIDERS_SCRIPT).toContain("'phi_panel_left_width'");
    expect(READ_DIVIDERS_SCRIPT).toContain("'phi_panel_right_width'");
    expect(READ_DIVIDERS_SCRIPT).toContain('60');
    expect(READ_DIVIDERS_SCRIPT).toContain('450');
    expect(READ_DIVIDERS_SCRIPT).toContain('200');
    expect(READ_DIVIDERS_SCRIPT).toContain('600');
  });

  it('returns null for never-set keys and clamped values for set ones (jsdom)', () => {
    expect(window.eval(READ_DIVIDERS_SCRIPT)).toEqual({ left: null, right: null });
    window.localStorage.setItem('phi_panel_left_width', '300');
    window.localStorage.setItem('phi_panel_right_width', '999');
    expect(window.eval(READ_DIVIDERS_SCRIPT)).toEqual({ left: 300, right: 600 });
    window.localStorage.setItem('phi_panel_left_width', '10');
    expect(window.eval(READ_DIVIDERS_SCRIPT)).toEqual({ left: 60, right: 600 });
    window.localStorage.setItem('phi_panel_right_width', 'not-a-number');
    expect(window.eval(READ_DIVIDERS_SCRIPT)).toEqual({ left: 60, right: null });
  });

  it('embeds apply values as JSON.stringify literals, never raw text', () => {
    const script = applyDividersScript(300, 420);
    expect(script).toContain("'phi_panel_left_width'");
    expect(script).toContain("'phi_panel_right_width'");
    expect(script).toContain('300');
    expect(script).toContain('420');
    expect(script).not.toContain('${');
  });

  it('applies widths inline, persists them, toggles .sidebar-narrow and dispatches a resize (jsdom)', () => {
    document.body.innerHTML = `
      <div id="sidebar-panel" style="width: 100px"></div>
      <div id="diff-panel" style="width: 100px"></div>`;
    let resizes = 0;
    window.addEventListener('resize', () => {
      resizes += 1;
    });
    window.eval(applyDividersScript(80, 500));
    const sidebar = document.getElementById('sidebar-panel')!;
    const diff = document.getElementById('diff-panel')!;
    expect(sidebar.style.width).toBe('80px');
    expect(sidebar.classList.contains('sidebar-narrow')).toBe(true);
    expect(diff.style.width).toBe('500px');
    expect(window.localStorage.getItem('phi_panel_left_width')).toBe('80');
    expect(window.localStorage.getItem('phi_panel_right_width')).toBe('500');
    expect(resizes).toBe(1);
    window.eval(applyDividersScript(200, 300));
    expect(sidebar.classList.contains('sidebar-narrow')).toBe(false);
  });

  it('leaves a null side untouched (per-divider sync)', () => {
    document.body.innerHTML = `
      <div id="sidebar-panel" style="width: 100px"></div>
      <div id="diff-panel" style="width: 999px"></div>`;
    window.eval(applyDividersScript(300, null));
    expect(document.getElementById('sidebar-panel')!.style.width).toBe('300px');
    expect(document.getElementById('diff-panel')!.style.width).toBe('999px');
    expect(window.localStorage.getItem('phi_panel_left_width')).toBe('300');
    expect(window.localStorage.getItem('phi_panel_right_width')).toBeNull();
  });

  it('parseDividers accepts well-formed snapshots and rejects malformed ones', () => {
    expect(parseDividers({ left: 300, right: 420 })).toEqual({ left: 300, right: 420 });
    expect(parseDividers({ left: null, right: null })).toEqual({ left: null, right: null });
    expect(parseDividers({ left: 300, right: null })).toEqual({ left: 300, right: null });
    expect(parseDividers({ left: 300 })).toBeNull();
    expect(parseDividers(null)).toBeNull();
    expect(parseDividers('x')).toBeNull();
    expect(parseDividers({ left: '300', right: 420 })).toBeNull();
  });
});

describe('PLAY_ALARM_CHIME_SCRIPT (the Sync Board alarm chime)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete windowField().__phiAlarmChimeAudio;
  });

  it('builds a fixed script body with the asset URL embedded as a JSON.stringify literal', () => {
    const url = 'file:///C:/phi/assets/bell.wav';
    const script = PLAY_ALARM_CHIME_SCRIPT(url);
    expect(script).not.toContain('${');
    expect(script).toContain(`"${url}"`);
    expect(script).toContain('new Audio(url)');
  });

  it('embeds the bounded burst values as JSON.stringify literals (up to 3 plays ~1s apart)', () => {
    const script = PLAY_ALARM_CHIME_SCRIPT('file:///a.wav');
    expect(script).toContain('const maxPlays = 3;');
    expect(script).toContain('const gapMs = 1000;');
    expect(script).toContain('plays >= maxPlays');
    expect(script).toContain('window.setTimeout(ring, gapMs)');
  });

  it('never steals focus', () => {
    expect(PLAY_ALARM_CHIME_SCRIPT('file:///a.wav')).not.toMatch(/focus/);
  });

  it('rings up to 3 times ~1s apart then stops (bounded burst, jsdom)', async () => {
    vi.useFakeTimers();
    let rings = 0;
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => {
      rings += 1;
      return Promise.resolve();
    });
    window.eval(PLAY_ALARM_CHIME_SCRIPT('file:///a.wav'));
    expect(rings).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rings).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rings).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rings).toBe(3);
  });

  it('reuses one page-level Audio element across re-fires (jsdom)', () => {
    vi.useFakeTimers();
    const created: Array<{ src: string }> = [];
    const OrigAudio = window.Audio;
    window.Audio = class {
      src: string;
      currentTime = 0;
      constructor(src: string) {
        this.src = src;
        created.push(this);
      }
      play() {
        return Promise.resolve();
      }
    } as unknown as typeof Audio;
    try {
      window.eval(PLAY_ALARM_CHIME_SCRIPT('file:///a/bell.wav'));
      window.eval(PLAY_ALARM_CHIME_SCRIPT('file:///a/bell.wav'));
      expect(created).toHaveLength(1);
      expect(created[0].src).toBe('file:///a/bell.wav');
    } finally {
      window.Audio = OrigAudio;
    }
  });
});

describe('retained body state scripts', () => {
  it('reads the body workspace selector value', () => {
    document.body.innerHTML = '<select id="workspace-select"><option value="/a">a</option><option value="/b">b</option></select>';
    const select = document.getElementById('workspace-select') as HTMLSelectElement;
    select.value = '/b';
    expect(window.eval(READ_WORKSPACE_SCRIPT)).toBe('/b');
  });

  it('builds a same-origin body login with JSON-escaped one-time proof data', async () => {
    const fetchSpy = vi.fn(async () => ({ status: 200 }));
    Object.defineProperty(window, 'fetch', { value: fetchSpy, configurable: true });
    const challenge = 'challenge"</script>';
    const proof = 'proof\\value';
    await expect(window.eval(bodyAuthLoginScript(challenge, proof))).resolves.toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, proof }),
    });
  });
});

describe('headerActionClickScript + setWorkspaceScript (header->body relays)', () => {
  it('headerActionClickScript clicks the target element and reports whether it existed', () => {
    document.body.innerHTML = '<button id="header-kanban-btn"></button>';
    expect(window.eval(headerActionClickScript('header-kanban-btn'))).toBe(true);
    expect(window.eval(headerActionClickScript('missing-id'))).toBe(false);
  });

  it('headerActionClickScript embeds the id as a JSON.stringify literal, never raw text', () => {
    const script = headerActionClickScript('x" onmouseover="alert(1)');
    expect(script).toContain(JSON.stringify('x" onmouseover="alert(1)'));
    expect(script).not.toContain('onmouseover="alert(1)');
  });

  it('setWorkspaceScript sets the selector value and dispatches a native change', () => {
    document.body.innerHTML =
      '<select id="workspace-select"><option value="/a">a</option><option value="/b">b</option></select>';
    const select = document.getElementById('workspace-select') as HTMLSelectElement;
    let changes = 0;
    select.addEventListener('change', () => {
      changes += 1;
    });
    expect(window.eval(setWorkspaceScript('/b'))).toBe(true);
    expect(select.value).toBe('/b');
    expect(changes).toBe(1);
  });

  it('setWorkspaceScript is a no-op for a workspace value the page does not know', () => {
    document.body.innerHTML =
      '<select id="workspace-select"><option value="/a">a</option></select>';
    const select = document.getElementById('workspace-select') as HTMLSelectElement;
    expect(window.eval(setWorkspaceScript('/nope'))).toBe(false);
    expect(select.value).toBe('/a');
  });
});
