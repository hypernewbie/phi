/**
 * phi-desktop electron boot/wiring.
 *
 * This file owns only the boot surface: the protocol-registration CLI
 * flags, the single-instance gate (closing over the host's lazy
 * window() and activateServerUrl), and the deeplink IPC relay. The
 * desktop orchestration itself lives in DesktopHost (src/desktop.ts),
 * which the ready callback hands control to via `host.start()`.
 *
 * Security defaults (non-negotiable, enforced in DesktopHost):
 *   - nodeIntegration: false
 *   - contextIsolation: true
 *   - sandbox: true
 *   - webSecurity: true
 *   - local pages load via `loadFile`; remote profile origins are
 *     sandboxed WebContentsView children with no preload bridge.
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopHost } from './desktop.js';
import { setupSingleInstance, FORWARD_CHANNEL } from './single-instance.js';
import { parseDeepLink, dispatchDeepLink, DEEPLINK_CHANNEL } from './deeplink.js';
import { installProtocol, uninstallProtocol, realPlatform } from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- CLI one-shot flags: --register-protocol / --unregister-protocol ---
// Both are parsed before the single-instance gate and exit 0 (1 on
// failure) without opening a window or acquiring the lock. They win over
// --server, PHI_DESKTOP_SERVER_URL, the gate, deep-link argv routing and
// smoke mode. When both are given, --register-protocol runs and
// --unregister-protocol is ignored. classifyArgv drops every flag, so a
// second launch carrying these flags is never forwarded.
if (process.argv.slice(1).includes('--register-protocol')) {
  try {
    const reg = await installProtocol(realPlatform, [path.join(here, 'main.js'), '--']);
    console.log(`installed at ${reg.path}, exe ${reg.exe}`);
    app.exit(0);
  } catch (err) {
    console.error(`phi-desktop: protocol registration failed: ${String(err)}`);
    app.exit(1);
  }
} else if (process.argv.slice(1).includes('--unregister-protocol')) {
  try {
    const unreg = await uninstallProtocol(realPlatform);
    console.log(`uninstalled at ${unreg.path}, exe ${unreg.exe}`);
    app.exit(0);
  } catch (err) {
    console.error(`phi-desktop: protocol unregistration failed: ${String(err)}`);
    app.exit(1);
  }
}

const host = new DesktopHost();

// --- Single-instance gate ---
// A second launch must hand its positional phi:// and http(s):// args to
// the running instance (Electron delivers them via the second-instance
// event) and exit before any window or IPC exists. The second-instance
// listener itself is installed later from host.start(), after the window
// and the tray exist. Server payloads are routed to the host's
// activateServerUrl; deep links keep the forward channel.
const singleInstance = setupSingleInstance(
  () => host.window(),
  FORWARD_CHANNEL,
  (url) => host.activateServerUrl(url),
);
if (!singleInstance.primary) {
  // Losing side: classify this launch's args and quit; app.quit()
  // happens inside acquire().
  singleInstance.acquire(process.argv.slice(1));
}

// Renderer-encountered phi:// strings come back to the main process on
// 'phi:deeplink'; they are parsed and dispatched to every window on the
// same channel.
ipcMain.on(DEEPLINK_CHANNEL, (_event, raw: unknown) => {
  if (typeof raw !== 'string') return;
  const parsed = parseDeepLink(raw);
  if (parsed.ok) dispatchDeepLink(host.window(), parsed);
});

app.whenReady().then(() => {
  void host.start(singleInstance);
});
