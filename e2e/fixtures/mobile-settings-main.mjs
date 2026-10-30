/**
 * Test-only Electron entry for mobile-settings native ownership acceptance.
 *
 * Replaces production boot wiring only: it sets owned Electron paths,
 * registers the production embedded scheme, uses the production
 * single-instance gate, and calls the real DesktopHost.start(). It never
 * runs user-data migration or OS protocol-registration code, never sets
 * PHI_DESKTOP_SMOKE, and adds no production test API. The host reference
 * is exposed on globalThis for Playwright main-process evaluation.
 */
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
    console.error(`phi-ms-fixture: ${message}`);
    process.exit(1);
}

// PHI_MS_FIXTURE_DIR is owned by the spec (mkdtemp). All Electron paths
// live inside it. The spec also sets HOME/USERPROFILE/APPDATA/TMPDIR to
// owned locations in the child env, but this entry re-asserts them.
const fixtureDir = process.env.PHI_MS_FIXTURE_DIR;
if (!fixtureDir) fail('PHI_MS_FIXTURE_DIR is not set');
if (process.env.PHI_DESKTOP_SMOKE === '1')
    fail('PHI_DESKTOP_SMOKE must not be set for native acceptance');

const homeDir = path.join(fixtureDir, 'home');
const appDataDir = path.join(fixtureDir, 'appData');
const userDataDir = path.join(fixtureDir, 'userData');
const sessionDataDir = path.join(fixtureDir, 'sessionData');
const tempDir = path.join(fixtureDir, 'temp');
for (const dir of [homeDir, appDataDir, userDataDir, sessionDataDir, tempDir]) {
    mkdirSync(dir, { recursive: true });
}

// Minimal owned environment. The spec launches Electron with a minimal
// env; re-assert here so os.homedir() cannot escape the fixture.
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.APPDATA = homeDir;
process.env.TMPDIR = tempDir;
process.env.TMP = tempDir;
process.env.TEMP = tempDir;

let homedir = '';
try {
    homedir = os.homedir();
} catch (err) {
    fail(`os.homedir() threw: ${String(err)}`);
}
if (!homedir.startsWith(fixtureDir)) {
    fail(`os.homedir() escaped fixture: ${homedir} not inside ${fixtureDir}`);
}

// Hooks run only against the empty fixture HOME. Fail when the hooks
// directory contains an executable (an external hook would run).
const hooksDir = path.join(homeDir, '.phi', 'hooks');
if (existsSync(hooksDir)) {
    const entries = readdirSync(hooksDir);
    for (const entry of entries) {
        const full = path.join(hooksDir, entry);
        try {
            const st = statSync(full);
            if (st.isFile() && st.mode & 0o111) {
                fail(`external hook executable in fixture: ${full}`);
            }
        } catch {
            // Unreadable entry: fail closed, an external hook may hide here.
            fail(`unreadable hooks entry: ${full}`);
        }
    }
}

// Import Electron before production modules so path overrides land first.
// The production dist is ESM (type: module); import via file URL.
const electron = await import('electron');
const { app, protocol, globalShortcut } = electron;

if (!app || !protocol || !globalShortcut) {
    fail('electron app/protocol/globalShortcut unavailable');
}

// Test-owned Electron paths. Must run before app.whenReady() and before
// the single-instance gate (which keys off userData).
try {
    app.setPath('home', homeDir);
    app.setPath('appData', appDataDir);
    app.setPath('userData', userDataDir);
    app.setPath('sessionData', sessionDataDir);
    app.setPath('temp', tempDir);
} catch (err) {
    fail(`app.setPath failed: ${String(err)}`);
}

// Treat fixture http origins as secure (mirrors production main.ts
// clipboard handling, without its migration/registration code).
try {
    const origins = new Set();
    for (const key of ['PHI_MS_A_URL', 'PHI_MS_B_URL']) {
        const raw = process.env[key];
        if (raw && raw.startsWith('http://')) {
            try {
                origins.add(new URL(raw).origin);
            } catch {}
        }
    }
    if (origins.size > 0) {
        app.commandLine.appendSwitch(
            'unsafely-treat-insecure-origin-as-secure',
            [...origins].join(','),
        );
    }
} catch {
    // Non-fatal: clipboard may degrade, ownership checks do not depend on it.
}

// Resolve production dist. The fixture lives at e2e/fixtures/, dist at
// desktop/electron/dist/. PHI_MS_DESKTOP_DIST overrides for debugging.
const distDir =
    process.env.PHI_MS_DESKTOP_DIST ||
    path.resolve(here, '..', '..', 'desktop', 'electron', 'dist');
const desktopUrl = new URL('desktop.js', `file://${distDir}/`).href;
const embeddedUrl = new URL('embedded-transport.js', `file://${distDir}/`).href;
const singleInstanceUrl = new URL('single-instance.js', `file://${distDir}/`).href;

let DesktopHost, registerEmbeddedScheme, setupSingleInstance, FORWARD_CHANNEL;
try {
    ({ DesktopHost } = await import(desktopUrl));
    ({ registerEmbeddedScheme } = await import(embeddedUrl));
    ({ setupSingleInstance, FORWARD_CHANNEL } = await import(singleInstanceUrl));
} catch (err) {
    fail(`production desktop import failed: ${String(err)}`);
}
if (!DesktopHost || !registerEmbeddedScheme || !setupSingleInstance) {
    fail('production desktop exports missing');
}

// Production scheme registration before ready. No migration, no protocol
// install/uninstall, no smoke path.
registerEmbeddedScheme(protocol);

// Recording tray + shortcut surfaces. Real BrowserWindow,
// WebContentsView, EmbeddedTransport, controller, sessions, auth, popup
// handlers, and network requests stay intact.
const recording = {
    tray: { setActiveProfile: 0, setUnread: 0, rebuildMenu: 0, close: 0 },
    shortcut: { register: [], unregister: [] },
};

const host = new DesktopHost();

// Replace only this instance's startTray. Fail before startup when the
// replacement cannot be installed.
const recordingTray = {
    setActiveProfile() {
        recording.tray.setActiveProfile++;
    },
    setUnread() {
        recording.tray.setUnread++;
    },
    rebuildMenu() {
        recording.tray.rebuildMenu++;
    },
    close() {
        recording.tray.close++;
    },
};
try {
    host.startTray = () => {
        host.trayHandle = recordingTray;
        return recordingTray;
    };
} catch (err) {
    fail(`startTray replacement failed: ${String(err)}`);
}
if (host.startTray.length !== 0) {
    // startTray() takes no arguments; a signature change is a fixture bug.
    fail('startTray replacement has unexpected signature');
}

// Replace the test process's globalShortcut methods. Never call the real
// methods. Fail before startup when patching is impossible.
const originalRegister = globalShortcut.register;
const originalUnregister = globalShortcut.unregister;
if (
    typeof originalRegister !== 'function' ||
    typeof originalUnregister !== 'function'
) {
    fail('globalShortcut.register/unregister unavailable');
}
try {
    globalShortcut.register = (accelerator, callback) => {
        recording.shortcut.register.push(String(accelerator));
        // Return true so the host records a 'registered' hotkey without
        // touching the OS. The callback is never invoked.
        void callback;
        return true;
    };
    globalShortcut.unregister = (accelerator) => {
        recording.shortcut.unregister.push(String(accelerator));
    };
} catch (err) {
    fail(`globalShortcut replacement failed: ${String(err)}`);
}
if (
    globalShortcut.register === originalRegister ||
    globalShortcut.unregister === originalUnregister
) {
    fail('globalShortcut replacement did not stick');
}

// Production single-instance gate after owned userData is set.
const singleInstance = setupSingleInstance(
    () => host.window(),
    FORWARD_CHANNEL,
    undefined,
    (payloads) => host.handleLaunch(payloads),
);
if (!singleInstance.primary) {
    fail('fixture lost single-instance lock; another Electron owns the fixture userData');
}

// Expose for Playwright main-process evaluation. No production test API.
globalThis.__phiMsHost = host;
globalThis.__phiMsRecording = recording;
globalThis.__phiMsReady = false;
globalThis.__phiMsStartError = null;

app.whenReady().then(() => {
    void host
        .start(singleInstance)
        .then(() => {
            // Pet must stay disabled on the fresh store; assert no pet
            // handle was created. discoverPetRoot may find the dev
            // desktop/pet source tree, but the controller default is
            // disabled and startPet is never called by the fixture.
            try {
                const enabled = host.controller?.getPetEnabled?.() ?? false;
                if (enabled) {
                    globalThis.__phiMsStartError =
                        'pet unexpectedly enabled on fresh store';
                    return;
                }
                if (host.petHandle !== null) {
                    globalThis.__phiMsStartError =
                        'pet handle unexpectedly created';
                    return;
                }
            } catch (err) {
                globalThis.__phiMsStartError = `pet check failed: ${String(err)}`;
                return;
            }
            globalThis.__phiMsReady = true;
        })
        .catch((err) => {
            globalThis.__phiMsStartError = String(err?.stack || err);
        });
});
