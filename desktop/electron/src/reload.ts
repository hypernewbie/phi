/**
 * F5 / Ctrl+F5 / Shift+F5 page reload shortcut for the phi-desktop shell.
 *
 * Pure TypeScript: only 'electron' type imports (erased at runtime), so
 * vitest runs it directly and every Electron surface arrives
 * injected — matching the convention in fullscreen.ts and views.ts.
 *
 * before-input-event fires per webContents, so the helper is installed
 * on every desktop-owned surface: the retained remote body views (via
 * ProfileViewManager), the main window's page, and child popups/picker.
 * Plain F5 calls reload(); Ctrl+F5 or Shift+F5 calls reloadIgnoringCache().
 * Modified chords with Alt/Meta are left untouched.
 */
import type { WebContents } from 'electron';

/**
 * Installs reload shortcuts on one webContents.
 * - Plain F5 / Cmd+R / Ctrl+R: reload active view
 * - Shift+F5 / Ctrl+F5 / Cmd+Shift+R / Ctrl+Shift+R: reload active view ignoring cache
 * - Alt+F5 / Cmd+Alt+R / Ctrl+Alt+R: reload all servers (Idea E)
 */
export function installReloadShortcut(
  contents: WebContents,
  targetGetter?: () => WebContents | null,
  reloadAllServers?: (ignoringCache: boolean) => void,
): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Alt+F5 or Ctrl+Alt+R / Cmd+Alt+R: reload all servers (Idea E)
    const isAltReload =
      (input.key === 'F5' && input.alt && !input.meta) ||
      ((input.control || input.meta) && input.alt && (input.key === 'r' || input.key === 'R'));

    if (isAltReload) {
      if (typeof reloadAllServers === 'function') {
        event.preventDefault();
        reloadAllServers(Boolean(input.control || input.shift));
        return;
      }
    }

    // F5 or Ctrl+R / Cmd+R: reload active target view
    const isReloadKey =
      (input.key === 'F5' && !input.alt && !input.meta) ||
      ((input.control || input.meta) && !input.alt && (input.key === 'r' || input.key === 'R'));

    if (isReloadKey) {
      event.preventDefault();
      const target = targetGetter ? targetGetter() ?? contents : contents;
      if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return;
      if (input.control || input.shift) {
        target.reloadIgnoringCache();
      } else {
        target.reload();
      }
    }
  });
}
