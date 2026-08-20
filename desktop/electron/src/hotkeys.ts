/**
 * Global hotkey for the Electron main process — parity with the Wails
 * `desktop/internal/hotkeys` package. The default accelerator is
 * Ctrl+Shift+L (CommandOrControl+Shift+L: 'L' is the virtual key that
 * stands in for the Phi glyph — the same VK the Wails slice chose;
 * CommandOrControl maps to Cmd on macOS and Ctrl elsewhere), overridable
 * via the PHI_DESKTOP_HOTKEY environment variable.
 *
 * Implemented with the public Electron `globalShortcut` API only (no
 * RegisterHotKeyW, no native calls). Registration failure semantics
 * (Wails parity): when the OS already has the accelerator taken the
 * registration is logged and the app continues without the hotkey —
 * never a MessageBox. Any other failure (for example an invalid
 * accelerator string) surfaces as status 'error' and is logged.
 *
 * Platform availability: Electron's globalShortcut cannot register the
 * macOS system media keys (they are reserved for the system), but
 * arbitrary accelerators such as CommandOrControl+Shift+L are available
 * on macOS.
 *
 * Lifecycle: main.ts registers the hotkey after the tray is built and
 * unregisters every active registration on app.before-quit.
 *
 * Test isolation (documented convention, same as the other electron
 * slices): the 'electron' module is only touched inside registerHotkey
 * (never at module load), so tests stub it with a recording fake
 * globalShortcut and NO real globalShortcut.register is ever called in
 * tests. The e2e smoke harness never registers the real hotkey either
 * (the smoke path returns before the registration line, gated by
 * PHI_DESKTOP_SMOKE).
 */
import { globalShortcut } from 'electron';

/** The default accelerator (Ctrl on Windows/Linux, Cmd on macOS). */
export const DEFAULT_HOTKEY_ACCELERATOR = 'CommandOrControl+Shift+L';

/** Environment variable overriding the accelerator. */
export const HOTKEY_ENV_VAR = 'PHI_DESKTOP_HOTKEY';

/** Registration outcome. */
export type HotkeyStatus = 'registered' | 'busy' | 'error';

/** A registered global hotkey; unregister() removes it (idempotent). */
export interface HotkeyRegistration {
  unregister(): void;
  status: HotkeyStatus;
}

/** The minimal globalShortcut surface (Electron's globalShortcut satisfies it). */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** registerHotkey dependencies (both optional; tests inject fakes). */
export interface RegisterHotkeyDeps {
  /** Override for tests (defaults to Electron's globalShortcut). */
  shortcut?: GlobalShortcutLike;
  /** Diagnostics logger (defaults to console.log). */
  log?: (msg: string) => void;
}

/**
 * Resolves the accelerator: the PHI_DESKTOP_HOTKEY environment variable
 * when set (non-blank), otherwise the default CommandOrControl+Shift+L.
 */
export function resolveAccelerator(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[HOTKEY_ENV_VAR]?.trim();
  return raw && raw !== '' ? raw : DEFAULT_HOTKEY_ACCELERATOR;
}

/**
 * Registers one global hotkey and returns the registration plus its
 * status:
 *   - 'registered' — the accelerator was registered; unregister() removes
 *     it;
 *   - 'busy' — the OS already has the accelerator taken (logged, the app
 *     continues without the hotkey — the Wails "log and continue, never a
 *     MessageBox" rule); unregister() is a safe no-op;
 *   - 'error' — any other failure, e.g. an invalid accelerator (logged);
 *     unregister() is a safe no-op.
 */
export function registerHotkey(
  accelerator: string,
  action: () => void,
  deps: RegisterHotkeyDeps = {},
): HotkeyRegistration {
  const shortcut = deps.shortcut ?? globalShortcut;
  const log = deps.log ?? ((msg: string): void => console.log(msg));
  try {
    const ok = shortcut.register(accelerator, action);
    if (!ok) {
      log(
        `phi-desktop: hotkey ${accelerator} is already taken by another app; continuing without it`,
      );
      return { status: 'busy', unregister: () => {} };
    }
    return {
      status: 'registered',
      unregister: () => {
        try {
          shortcut.unregister(accelerator);
        } catch (err) {
          log(`phi-desktop: hotkey ${accelerator} unregister: ${String(err)}`);
        }
      },
    };
  } catch (err) {
    log(
      `phi-desktop: hotkey ${accelerator} registration failed: ${String(err)}`,
    );
    return { status: 'error', unregister: () => {} };
  }
}
