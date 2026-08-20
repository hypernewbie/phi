/**
 * Unit tests for the global hotkey (src/hotkeys.ts) — parity with the
 * Wails desktop/internal/hotkeys package, implemented with the public
 * Electron globalShortcut API.
 *
 * Test isolation (documented convention, same as the other electron
 * slices): NO real globalShortcut.register is ever called. The
 * 'electron' module is stubbed with a recording fake globalShortcut
 * (register/unregister record their calls and return scripted results);
 * the module under test only touches Electron inside registerHotkey
 * (never at module load), so importing it is inert outside a real
 * Electron runtime. The e2e smoke harness never registers the real
 * hotkey either (the smoke path returns before the registration line,
 * gated by PHI_DESKTOP_SMOKE — asserted in smoke.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeGlobalShortcut } = vi.hoisted(() => ({
  fakeGlobalShortcut: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));

vi.mock('electron', () => ({ globalShortcut: fakeGlobalShortcut }));

import {
  DEFAULT_HOTKEY_ACCELERATOR,
  HOTKEY_ENV_VAR,
  registerHotkey,
  resolveAccelerator,
} from '../src/hotkeys.js';

beforeEach(() => {
  vi.clearAllMocks();
  fakeGlobalShortcut.register.mockReturnValue(true);
});

describe('registerHotkey (recording fake globalShortcut)', () => {
  it("returns status 'registered' and an unregister that removes the accelerator", () => {
    const action = vi.fn();
    const reg = registerHotkey('CommandOrControl+Shift+L', action);
    expect(reg.status).toBe('registered');
    expect(fakeGlobalShortcut.register).toHaveBeenCalledWith(
      'CommandOrControl+Shift+L',
      action,
    );
    reg.unregister();
    expect(fakeGlobalShortcut.unregister).toHaveBeenCalledWith(
      'CommandOrControl+Shift+L',
    );
  });

  it('invokes the action when the registered callback fires', () => {
    const action = vi.fn();
    registerHotkey('CommandOrControl+Shift+L', action);
    const callback = fakeGlobalShortcut.register.mock.calls[0][1] as () => void;
    callback();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("returns status 'busy' and logs when the accelerator is already taken (never a MessageBox)", () => {
    fakeGlobalShortcut.register.mockReturnValue(false);
    const log = vi.fn();
    const reg = registerHotkey('CommandOrControl+Shift+L', () => {}, { log });
    expect(reg.status).toBe('busy');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already taken'));
    // A busy registration must never unregister the other app's shortcut.
    reg.unregister();
    expect(fakeGlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  it("returns status 'error' and logs when registration throws", () => {
    fakeGlobalShortcut.register.mockImplementation(() => {
      throw new Error('invalid accelerator');
    });
    const log = vi.fn();
    const reg = registerHotkey('Bogus', () => {}, { log });
    expect(reg.status).toBe('error');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'));
    reg.unregister();
    expect(fakeGlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  it('is idempotent to unregister a registered hotkey twice', () => {
    const reg = registerHotkey('CommandOrControl+Shift+L', () => {});
    reg.unregister();
    reg.unregister();
    expect(fakeGlobalShortcut.unregister).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAccelerator (PHI_DESKTOP_HOTKEY override)', () => {
  it('defaults to CommandOrControl+Shift+L (the Wails L VK)', () => {
    expect(DEFAULT_HOTKEY_ACCELERATOR).toBe('CommandOrControl+Shift+L');
    expect(resolveAccelerator({})).toBe('CommandOrControl+Shift+L');
  });

  it('honors the PHI_DESKTOP_HOTKEY environment override', () => {
    expect(resolveAccelerator({ [HOTKEY_ENV_VAR]: 'Alt+Shift+P' })).toBe(
      'Alt+Shift+P',
    );
  });

  it('falls back to the default for a blank override', () => {
    expect(resolveAccelerator({ [HOTKEY_ENV_VAR]: '   ' })).toBe(
      DEFAULT_HOTKEY_ACCELERATOR,
    );
  });
});
