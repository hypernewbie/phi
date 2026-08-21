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
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopHost } from './desktop.js';
import { setupSingleInstance, FORWARD_CHANNEL } from './single-instance.js';
import { parseDeepLink, DEEPLINK_CHANNEL } from './deeplink.js';
import { parseMainArgs } from './argv.js';
import {
  installProtocol,
  uninstallProtocol,
  realPlatform,
} from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

app.name = 'phi-client';

/**
 * Migrates legacy userData settings (profiles.json, access-credentials.bin)
 * from previous directory names (phi-desktop-electron, Phi) if the current
 * userData directory does not have them.
 */
export function migrateUserData(targetDir: string, appDataDir: string): void {
  const legacyDirs = [
    path.join(appDataDir, 'phi-desktop-electron'),
    path.join(appDataDir, 'Phi'),
  ];
  const filesToMigrate = ['profiles.json', 'access-credentials.bin'];

  for (const legacyDir of legacyDirs) {
    if (legacyDir === targetDir || !existsSync(legacyDir)) continue;
    for (const file of filesToMigrate) {
      const src = path.join(legacyDir, file);
      const dst = path.join(targetDir, file);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          mkdirSync(targetDir, { recursive: true });
          copyFileSync(src, dst);
        } catch (err) {
          console.warn(
            `phi-desktop: failed to migrate ${file} from ${legacyDir}: ${String(err)}`,
          );
        }
      }
    }
  }
}

// --- CLI one-shot flags: --register-protocol / --unregister-protocol ---
// Both are parsed before the single-instance gate and exit 0 (1 on
// failure) without opening a window or acquiring the lock. They win over
// --server, PHI_DESKTOP_SERVER_URL, the gate, deep-link argv routing and
// smoke mode. When both are given, --register-protocol runs and
// --unregister-protocol is ignored. classifyArgv drops every flag, so a
// second launch carrying these flags is never forwarded.
const bootArgs = parseMainArgs(process.argv.slice(1));
if (bootArgs.registerProtocol) {
  try {
    const reg = await installProtocol(realPlatform, [
      path.join(here, 'main.js'),
      '--',
    ]);
    console.log(`installed at ${reg.path}, exe ${reg.exe}`);
    app.exit(0);
  } catch (err) {
    console.error(`phi-desktop: protocol registration failed: ${String(err)}`);
    app.exit(1);
  }
} else if (bootArgs.unregisterProtocol) {
  try {
    const unreg = await uninstallProtocol(realPlatform);
    console.log(`uninstalled at ${unreg.path}, exe ${unreg.exe}`);
    app.exit(0);
  } catch (err) {
    console.error(
      `phi-desktop: protocol unregistration failed: ${String(err)}`,
    );
    app.exit(1);
  }
}

if (process.env.PHI_DESKTOP_SMOKE === '1') {
  app.setPath(
    'userData',
    path.join(
      app.getPath('temp'),
      `phi-desktop-smoke-${Date.now()}-${process.pid}`,
    ),
  );
} else {
  try {
    migrateUserData(app.getPath('userData'), app.getPath('appData'));
  } catch {
    // Non-fatal
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
  undefined,
  (payloads) => host.handleLaunch(payloads),
);
if (!singleInstance.primary) {
  // Losing side: classify this launch's positional args and quit;
  // app.quit() happens inside acquire().
  singleInstance.acquire(bootArgs.positional);
}

// Renderer-encountered phi:// strings come back to the main process on
// 'phi:deeplink'; they are parsed and dispatched to every window on the
// same channel.
ipcMain.on(DEEPLINK_CHANNEL, (_event, raw: unknown) => {
  if (typeof raw !== 'string') return;
  const parsed = parseDeepLink(raw);
  if (parsed.ok) {
    host.handleLaunch([{ kind: 'deep-link', value: raw }]);
  }
});

app.whenReady().then(() => {
  void host.start(singleInstance);
});
