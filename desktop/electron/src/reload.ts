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

/** Installs the F5 reload shortcut on one webContents. */
export function installReloadShortcut(
  contents: WebContents,
  targetGetter?: () => WebContents | null,
): void {
  contents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.key === 'F5' &&
      !input.alt &&
      !input.meta
    ) {
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
