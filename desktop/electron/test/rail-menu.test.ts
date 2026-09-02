// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailMenuState } from '../src/electron.js';
import { boot, renderState } from '../src/rail-menu.js';

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
    close: ReturnType<typeof vi.fn>;
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
    close: vi.fn(),
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
    postCloseRailMenu: calls.close,
  };
  boot();
  renderState(MENU_STATE);
  return { stateCb, calls };
}

beforeEach(() => {
  delete (window as { electron?: unknown }).electron;
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
      '✎Rename',
      '×Remove server',
    ]);
    expect(root.querySelector('.rail-menu-panel')).not.toBeNull();
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
});
