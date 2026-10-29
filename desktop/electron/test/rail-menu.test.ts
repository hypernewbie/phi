// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailMenuState } from '../src/electron.js';
import { boot, measureRailMenuHeight, renderState } from '../src/rail-menu.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlSource = readFileSync(
  path.join(here, '..', 'src', 'rail-menu.html'),
  'utf8',
);
const cssSource = readFileSync(
  path.join(here, '..', 'src', 'rail-menu.css'),
  'utf8',
);

const MENU_STATE: RailMenuState = {
  profile: {
    id: 'a',
    name: 'Alpha Phi',
    origin: 'http://127.0.0.1:7070/',
    hostname: 'charon.local',
    accent: '#e76f51',
    cpu: 62,
  },
  health: 'up',
  unread: 3,
};

function actionButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`missing menu action: ${label}`);
  return button;
}

function setup(): {
  stateCb: (state: RailMenuState) => void;
  calls: {
    sessions: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    reloadServer: ReturnType<typeof vi.fn>;
    reloadAll: ReturnType<typeof vi.fn>;
    copyUrl: ReturnType<typeof vi.fn>;
    copyAll: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    size: ReturnType<typeof vi.fn>;
  };
} {
  document.body.innerHTML = htmlSource.slice(
    htmlSource.indexOf('<main'),
    htmlSource.indexOf('</body>'),
  );
  window.history.replaceState({}, '', '?profile=a');
  let stateCb = (_state: RailMenuState): void => {};
  const calls = {
    sessions: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    reloadServer: vi.fn(),
    reloadAll: vi.fn(),
    copyUrl: vi.fn(),
    copyAll: vi.fn(),
    close: vi.fn(),
    size: vi.fn(),
  };
  (window as { electron?: unknown }).electron = {
    onRailMenuState: (cb: (state: RailMenuState) => void) => {
      stateCb = cb;
      return () => {};
    },
    postOpenServerSessions: calls.sessions,
    postRenameProfile: calls.rename,
    postRemoveProfile: calls.remove,
    postReloadServer: calls.reloadServer,
    postReloadAllServers: calls.reloadAll,
    postCopyServerUrl: calls.copyUrl,
    postCopyAllServers: calls.copyAll,
    postCloseRailMenu: calls.close,
    postRailMenuSize: calls.size,
  };
  boot();
  renderState(MENU_STATE);
  return { stateCb, calls };
}

beforeEach(() => {
  delete (window as { electron?: unknown }).electron;
});

afterEach(() => {
  if (typeof window.electron !== 'undefined') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.style.cssText = '';
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe('desktop rail context popup', () => {
  it('renders a roomy identity header, health state, and grouped actions', () => {
    setup();
    const root = document.getElementById('rail-menu-root');
    if (!root) throw new Error('rail menu root missing');
    expect(root.textContent).toContain('Alpha Phi');
    expect(root.textContent).toContain('CHARON');
    expect(root.textContent).toContain('Connected');
    expect(root.textContent).toContain('3 unread');
    expect(
      [...root.querySelectorAll('.rail-menu-action')].map(
        (button) => button.textContent,
      ),
    ).toEqual([
      '▣Open sessions',
      '↻Reload server',
      '⟳Reload all servers',
      '📋Copy server URL',
      '📋Copy all server URLs',
      '✎Rename',
      '×Remove server',
    ]);
    expect(root.querySelector('.rail-menu-panel')).not.toBeNull();
  });

  it('routes copy actions through the bridge and closes the popup', () => {
    const { calls } = setup();
    actionButton('Copy server URL').click();
    expect(calls.copyUrl).toHaveBeenCalledWith('a');
    expect(calls.close).toHaveBeenCalledTimes(1);

    actionButton('Copy all server URLs').click();
    expect(calls.copyAll).toHaveBeenCalledTimes(1);
    expect(calls.close).toHaveBeenCalledTimes(2);
  });

  it('routes server actions through the existing bridge and closes the popup', () => {
    const { calls } = setup();
    actionButton('Reload server').click();
    expect(calls.reloadServer).toHaveBeenCalledWith('a');
    expect(calls.close).toHaveBeenCalledTimes(1);
  });

  it('keeps rename editing inside the popup and submits the targeted profile', () => {
    const { calls } = setup();
    actionButton('Rename').click();
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Alpha Phi');
    input.value = 'Renamed';
    if (!input.form) throw new Error('rename form missing');
    input.form.requestSubmit();
    expect(calls.rename).toHaveBeenCalledWith('a', 'Renamed');
    expect(calls.close).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before removing a profile', () => {
    const { calls } = setup();
    actionButton('Remove server').click();
    expect(document.querySelector('.rail-menu-confirm')?.textContent).toContain(
      'CHARON',
    );
    expect(calls.remove).not.toHaveBeenCalled();
    actionButton('Remove server').click();
    expect(calls.remove).toHaveBeenCalledWith('a');
    expect(calls.close).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and suppresses a second browser context menu', () => {
    const { calls } = setup();
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escapeEvent);
    expect(calls.close).toHaveBeenCalledTimes(1);
    const context = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    expect(document.dispatchEvent(context)).toBe(false);
  });

  it('updates the popup when its profile health or unread count changes', () => {
    setup();
    renderState({
      ...MENU_STATE,
      health: 'down',
      unread: 0,
    });
    expect(document.querySelector('.rail-menu-status')?.textContent).toContain(
      'Offline',
    );
    expect(document.querySelector('.rail-menu-unread')).toBeNull();
  });

  it('uses the shell popup page instead of the clipped rail menu', () => {
    expect(htmlSource).toContain('rail-menu.js');
    expect(htmlSource).toContain('rail-menu.css');
    expect(cssSource).toMatch(
      /\.rail-menu-panel\s*\{[^}]*border-radius:\s*12px/s,
    );
    expect(cssSource).toMatch(
      /\.rail-menu-action\s*\{[^}]*min-height:\s*38px/s,
    );
  });

  it('applies the machine accent color and never falls back to purple', () => {
    setup();
    // In MENU_STATE, accent is '#e76f51'
    expect(
      document.documentElement.style.getPropertyValue('--menu-accent'),
    ).toBe('#e76f51');
    expect(
      document.documentElement.style.getPropertyValue('--menu-accent-soft'),
    ).toBe('color-mix(in srgb, #e76f51 14%, transparent)');

    // CSS file must NOT hardcode purple (#9b8cff or #7c6af7)
    expect(cssSource).not.toContain('#9b8cff');
    expect(cssSource).not.toContain('#7c6af7');
  });

  it('preserves the rename draft and focus when background state changes', async () => {
    setup();
    actionButton('Rename').click();
    const input = document.querySelector<HTMLInputElement>('.rail-menu-input')!;
    input.value = 'Unsaved server name';
    input.focus();
    input.setSelectionRange(3, 7);
    renderState({ ...MENU_STATE, health: 'down', unread: 4 });
    expect(document.querySelector('.rail-menu-input')).toBe(input);
    expect(input.value).toBe('Unsaved server name');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
    expect(document.querySelector('.rail-menu-status')?.textContent).toContain(
      'Offline',
    );
    expect(document.querySelectorAll('.rail-menu-header')).toHaveLength(1);
  });

  it('reports only after fonts finish loading', async () => {
    document.body.style.padding = '8px';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 304, 492),
    );
    let finish!: () => void;
    const fonts = {
      status: 'loading',
      ready: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts,
    });
    const { calls } = setup();
    expect(calls.size).not.toHaveBeenCalled();
    fonts.status = 'loaded';
    finish();
    await Promise.resolve();
    expect(calls.size).toHaveBeenLastCalledWith(508);
  });

  it('observes later panel changes and ignores a detached mode panel', () => {
    document.body.style.padding = '8px';
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    box.mockReturnValue(new DOMRect(0, 0, 304, 492));
    const callbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe(): void {}
        disconnect = disconnect;
      },
    );
    const { calls } = setup();
    const firstCallback = callbacks[0];
    box.mockReturnValue(new DOMRect(0, 0, 304, 530));
    firstCallback();
    expect(calls.size).toHaveBeenLastCalledWith(546);
    actionButton('Rename').click();
    expect(disconnect).toHaveBeenCalledTimes(1);
    calls.size.mockClear();
    firstCallback();
    expect(calls.size).not.toHaveBeenCalled();
    callbacks.at(-1)!();
    expect(calls.size).toHaveBeenLastCalledWith(546);
  });

  it('measures the panel box plus body padding, rounded upward', () => {
    document.body.style.padding = '8px';
    const panel = document.createElement('section');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 304, 492.25),
    );
    expect(measureRailMenuHeight(panel)).toBe(509);
  });

  it('reports content height for the actions and mode renders', () => {
    document.body.style.padding = '8px';
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    box.mockReturnValue(new DOMRect(0, 0, 304, 492));
    const { calls } = setup();
    expect(calls.size).toHaveBeenLastCalledWith(508);
    box.mockReturnValue(new DOMRect(0, 0, 304, 270));
    actionButton('Rename').click();
    expect(calls.size).toHaveBeenLastCalledWith(286);
    box.mockReturnValue(new DOMRect(0, 0, 304, 492));
    actionButton('Cancel').click();
    expect(calls.size).toHaveBeenLastCalledWith(508);
    box.mockReturnValue(new DOMRect(0, 0, 304, 235));
    actionButton('Remove server').click();
    expect(calls.size).toHaveBeenLastCalledWith(251);
  });
});
