import { createHash, createHmac, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { execFileSync, type ChildProcess } from 'node:child_process';
import {
    accessSync,
    constants as fsConstants,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron, expect, test, type Page } from '@playwright/test';
import {
    electronFixtureEnv,
    startPhi,
    type ElectronFixturePaths,
    type PhiServer,
} from './_server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronProject = join(repoRoot, 'desktop', 'electron');
const electronRequire = createRequire(join(electronProject, 'package.json'));
const v1Password = 'migration fixture pass';
const v1Salt = Buffer.alloc(16, 0x11);
const v1Verifier = pbkdf2Sync(v1Password, v1Salt, 600_000, 32, 'sha256');
const v1Entry = {
    version: 'v1',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
    saltBase64: b64url(v1Salt),
    verifierBase64: b64url(v1Verifier),
};
const v1PasswordHash = `v1.pbkdf2-sha256.600000.${b64url(v1Salt)}.${b64url(v1Verifier)}`;
const v2Password = 'electron v2 fixture password 1';

test.skip(
    process.platform === 'linux' &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY,
    'Real Electron requires DISPLAY or WAYLAND_DISPLAY on Linux.',
);
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

interface ElectronPaths extends ElectronFixturePaths {
    root: string;
    userData: string;
    launcher: string;
    hotkeyLog: string;
}

interface ElectronReceipt {
    pid: number;
    startTime: string;
    executable: string;
}

type ElectronApplication = Awaited<ReturnType<typeof _electron.launch>>;

interface OwnedElectron {
    application: ElectronApplication;
    child: ChildProcess;
    receipt: ElectronReceipt | null;
}

interface Diagnostics {
    markAuthenticated: () => void;
    assertClean: () => void;
}

let phi: PhiServer | null = null;
let electron: OwnedElectron | null = null;
let launchUncertain = false;

function b64url(value: Buffer): string {
    return value
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return (
        rel !== '' &&
        rel !== '..' &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel)
    );
}

function electronRuntime(): { executable: string; dist: string } {
    const packagePath = realpathSync(
        electronRequire.resolve('electron/package.json'),
    );
    const packageDir = dirname(packagePath);
    const dist = realpathSync(join(packageDir, 'dist'));
    const packageRelativePath = readFileSync(
        join(packageDir, 'path.txt'),
        'utf8',
    ).trim();
    if (!packageRelativePath || isAbsolute(packageRelativePath)) {
        throw new Error('Electron path.txt is empty or absolute');
    }
    const unresolved = resolve(dist, packageRelativePath);
    const executable = realpathSync(unresolved);
    if (!isInside(dist, executable)) {
        throw new Error('Electron runtime escapes its package dist directory');
    }
    const info = statSync(executable);
    if (!info.isFile())
        throw new Error('Electron runtime is not a regular file');
    accessSync(executable, fsConstants.X_OK);
    return { executable, dist };
}

function createPaths(server: PhiServer): ElectronPaths {
    const requestedRoot = join(server.dir, 'electron-run');
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(requestedRoot);
    if (!isInside(realpathSync(server.dir), root)) {
        throw new Error(`Electron run directory escapes its fixture: ${root}`);
    }
    const stagedDist = join(root, 'dist');
    cpSync(join(electronProject, 'dist'), stagedDist, { recursive: true });
    if (!isInside(root, realpathSync(stagedDist))) {
        throw new Error(
            `Electron asset directory escapes its run: ${stagedDist}`,
        );
    }
    const paths: ElectronPaths = {
        root,
        home: join(root, 'home'),
        appData: join(root, 'app-data'),
        userData: join(root, 'user-data'),
        config: join(root, 'xdg-config'),
        cache: join(root, 'xdg-cache'),
        data: join(root, 'xdg-data'),
        state: join(root, 'xdg-state'),
        temp: join(root, 'runtime-temp'),
        launcher: join(root, 'electron-launcher.mjs'),
        hotkeyLog: join(root, 'hotkey-register.log'),
    };
    for (const path of [
        paths.home,
        paths.appData,
        paths.userData,
        paths.config,
        paths.cache,
        paths.data,
        paths.state,
        paths.temp,
    ]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        if (!isInside(root, realpathSync(path))) {
            throw new Error(`Electron fixture path escapes its run: ${path}`);
        }
    }
    return paths;
}

function hotkeyAttempts(paths: ElectronPaths): string[] {
    if (!existsSync(paths.hotkeyLog)) return [];
    return readFileSync(paths.hotkeyLog, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
            const record = JSON.parse(line) as { accelerator?: unknown };
            if (typeof record.accelerator !== 'string') {
                throw new Error('Electron test hotkey log is malformed');
            }
            return record.accelerator;
        });
}

function seedSingleTab(paths: ElectronPaths, origin?: string): void {
    const profiles = origin
        ? [
              {
                  id: 'auth-fixture',
                  name: 'Auth fixture',
                  origin: new URL(origin).href,
              },
          ]
        : [];
    writeFileSync(
        join(paths.userData, 'profiles.json'),
        JSON.stringify({ profiles, lowMemoryMode: true }),
        { mode: 0o600 },
    );
}

function launcherSource(paths: ElectronPaths): string {
    const desktopPath = realpathSync(
        join(electronProject, 'dist', 'desktop.js'),
    );
    const mainPath = realpathSync(join(electronProject, 'dist', 'main.js'));
    const statePaths = {
        appData: paths.appData,
        userData: paths.userData,
        home: paths.home,
        temp: paths.temp,
        sessionData: join(paths.userData, 'session-data'),
        logs: join(paths.userData, 'logs'),
        crashDumps: join(paths.userData, 'crash-dumps'),
    };
    return `import { app } from 'electron';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

const exitOnLauncherError = (error) => {
  console.error('Electron fixture launcher failed:', error);
  app.exit(1);
};
process.on('uncaughtException', exitOnLauncherError);
process.on('unhandledRejection', exitOnLauncherError);

const root = ${JSON.stringify(paths.root)};
const shortcutLog = ${JSON.stringify(paths.hotkeyLog)};
const statePaths = ${JSON.stringify(statePaths)};
for (const value of Object.values(statePaths)) {
  mkdirSync(value, { recursive: true, mode: 0o700 });
}
app.setPath('appData', statePaths.appData);
app.setPath('userData', statePaths.userData);
app.setPath('home', statePaths.home);
app.setPath('temp', statePaths.temp);
app.setPath('sessionData', statePaths.sessionData);
app.setPath('crashDumps', statePaths.crashDumps);
app.setAppLogsPath(statePaths.logs);
// Keep Node-home consumers (including desktop hooks) synthetic without
// changing native HOME, which macOS needs to find the default Keychain.
os.homedir = () => statePaths.home;
syncBuiltinESMExports();
if (os.homedir() !== app.getPath('home')) {
  throw new Error('Node home isolation was not installed');
}
for (const name of Object.keys(statePaths)) {
  const actual = realpathSync(app.getPath(name));
  const rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Electron path escapes the owned run: ' + name);
  }
}
const { DesktopHost, setTestHotkeyShortcut } = await import(${JSON.stringify(pathToFileURL(desktopPath).href)});
if (typeof DesktopHost.prototype.startTray !== 'function') {
  throw new Error('DesktopHost startTray guard is unavailable');
}
const trayCalls = [];
const guardedStartTray = function () {
  const handle = {
    setActiveProfile: (profile) => trayCalls.push(['active', profile?.id]),
    setUnread: (id, count) => trayCalls.push(['unread', id, count]),
    rebuildMenu: () => trayCalls.push(['rebuild']),
    close: () => trayCalls.push(['close']),
  };
  this.trayHandle = handle;
  return handle;
};
DesktopHost.prototype.startTray = guardedStartTray;
if (DesktopHost.prototype.startTray !== guardedStartTray) {
  throw new Error('DesktopHost startTray guard was not installed');
}
const testShortcut = {
  register(accelerator) {
    appendFileSync(
      shortcutLog,
      JSON.stringify({ accelerator }) + '\\n',
      { mode: 0o600 },
    );
    return false;
  },
  unregister() {},
};
setTestHotkeyShortcut(testShortcut);
if (app.isReady()) {
  throw new Error('Electron became ready before embedded scheme registration');
}
await import(${JSON.stringify(pathToFileURL(mainPath).href)});
`;
}

function verifyElectronProcess(
    child: ChildProcess,
    expectedExecutable: string,
): ElectronReceipt {
    const pid = child.pid;
    if (!pid)
        throw new Error('Playwright returned an Electron child without a PID');
    const startTime = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        cwd: repoRoot,
        encoding: 'utf8',
    }).trim();
    if (!startTime)
        throw new Error(`Cannot read start time for Electron PID ${pid}`);
    const textFiles = execFileSync(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
        { cwd: repoRoot, encoding: 'utf8' },
    )
        .split(/\r?\n/)
        .filter((line) => line.startsWith('n'))
        .map((line) => line.slice(1));
    if (!textFiles.includes(expectedExecutable)) {
        throw new Error(
            `Electron PID ${pid} does not own the expected executable`,
        );
    }
    return { pid, startTime, executable: expectedExecutable };
}

async function launchElectron(
    paths: ElectronPaths,
    serverUrl?: string,
): Promise<OwnedElectron> {
    const { executable } = electronRuntime();
    const source = launcherSource(paths);
    writeFileSync(paths.launcher, source, { mode: 0o600 });
    if (readFileSync(paths.launcher, 'utf8') !== source) {
        throw new Error('Could not verify the isolated Electron launcher');
    }
    const env = electronFixtureEnv(paths);
    for (const key of [
        'HOME',
        'USERPROFILE',
        'APPDATA',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
    ]) {
        const value = env[key];
        if (!value || !isInside(paths.root, resolve(value))) {
            throw new Error(`Electron environment path is not owned: ${key}`);
        }
    }
    // Explicit, macOS-only exception for real Keychain-backed encryption.
    // Every app path and Node's home lookup remain inside the owned run.
    if (process.env.PHI_ELECTRON_NATIVE_KEYCHAIN === '1') {
        if (process.platform !== 'darwin') {
            throw new Error('Native Keychain HOME is a macOS-only exception');
        }
        env.HOME = realpathSync(userInfo().homedir);
    }
    const args = [paths.launcher];
    if (serverUrl) args.push('--server', serverUrl);
    launchUncertain = true;
    const application = await _electron.launch({
        executablePath: executable,
        args,
        cwd: paths.root,
        env,
        timeout: 30_000,
    });
    const owned: OwnedElectron = {
        application,
        child: application.process(),
        receipt: null,
    };
    electron = owned;
    launchUncertain = false;
    owned.receipt = verifyElectronProcess(owned.child, executable);
    console.log(
        `Electron PID ${owned.receipt.pid}; start ${owned.receipt.startTime}; executable ${owned.receipt.executable}`,
    );
    return owned;
}

async function closeElectron(): Promise<void> {
    if (!electron) return;
    const owned = electron;
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
        electron = null;
        return;
    }
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.resolve()
            .then(() => owned.application.close())
            .catch(() => undefined),
        new Promise<void>((resolveClose) => {
            closeTimer = setTimeout(resolveClose, 5_000);
        }),
    ]);
    if (closeTimer) clearTimeout(closeTimer);
    try {
        await waitForChildExit(owned.child, 5_000);
    } catch {
        await terminateOwnedElectron(owned);
    }
    electron = null;
}

async function waitForChildExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit);
            rejectExit(new Error(`Electron PID ${child.pid} did not exit`));
        }, timeoutMs);
        const onExit = () => {
            clearTimeout(timer);
            resolveExit();
        };
        child.once('exit', onExit);
        if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
}

async function terminateOwnedElectron(owned: OwnedElectron): Promise<void> {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null)
        return;
    const receipt = owned.receipt;
    if (!receipt) throw new Error('Electron process ownership is unverified');
    const current = verifyElectronProcess(owned.child, receipt.executable);
    if (current.startTime !== receipt.startTime) {
        throw new Error(`Electron PID ${receipt.pid} was reused`);
    }
    if (
        !owned.child.kill('SIGTERM') &&
        owned.child.exitCode === null &&
        owned.child.signalCode === null
    ) {
        throw new Error(`Could not stop owned Electron PID ${receipt.pid}`);
    }
    try {
        await waitForChildExit(owned.child, 2_000);
        return;
    } catch {
        if (owned.child.exitCode !== null || owned.child.signalCode !== null)
            return;
        const afterTerm = verifyElectronProcess(
            owned.child,
            receipt.executable,
        );
        if (afterTerm.startTime !== receipt.startTime) {
            throw new Error(`Electron PID ${receipt.pid} was reused`);
        }
        if (
            !owned.child.kill('SIGKILL') &&
            owned.child.exitCode === null &&
            owned.child.signalCode === null
        ) {
            throw new Error(
                `Could not force-stop owned Electron PID ${receipt.pid}`,
            );
        }
    }
    await waitForChildExit(owned.child, 10_000);
}

function diagnostics(application: ElectronApplication): Diagnostics {
    let authenticated = false;
    const result = {
        mainConsoleErrors: [] as string[],
        pageConsoleErrors: [] as string[],
        pageErrors: [] as string[],
        requestFailures: [] as string[],
        unexpectedResponses: [] as string[],
        expectedPreAuth401: 0,
    };
    const tracked = new WeakSet<Page>();
    const trackPage = (page: Page) => {
        if (tracked.has(page)) return;
        tracked.add(page);
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const source = message.location();
            const status =
                /status of ([0-9]{3})\b/.exec(message.text())?.[1] ?? 'console';
            result.pageConsoleErrors.push(
                `${status} ${safePath(source.url || page.url())}`,
            );
        });
        page.on('pageerror', () =>
            result.pageErrors.push(safePath(page.url())),
        );
        page.on('requestfailed', (request) => {
            result.requestFailures.push(safePath(request.url()));
        });
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const path = safePath(response.url());
            if (
                !authenticated &&
                response.status() === 401 &&
                path.startsWith('/api/')
            ) {
                result.expectedPreAuth401++;
            } else {
                result.unexpectedResponses.push(`${response.status()} ${path}`);
            }
        });
    };
    const context = application.context();
    context.pages().forEach(trackPage);
    context.on('page', trackPage);
    application.on('console', (message) => {
        if (message.type() !== 'error') return;
        const source = message.location();
        const text = message.text();
        const kind =
            /\b(DeprecationWarning|ExperimentalWarning)\b/.exec(text)?.[1] ??
            'console';
        const code = /\bDEP[0-9]{4}\b/.exec(text)?.[0] ?? '';
        result.mainConsoleErrors.push(
            `${kind} ${code} ${safePath(source.url)}:${source.lineNumber + 1}`,
        );
    });
    return {
        markAuthenticated: () => {
            authenticated = true;
        },
        assertClean: () => {
            expect(result).toEqual({
                mainConsoleErrors: [],
                pageConsoleErrors: [],
                pageErrors: [],
                requestFailures: [],
                unexpectedResponses: [],
                expectedPreAuth401: expect.any(Number),
            });
        },
    };
}

function safePath(value: string): string {
    try {
        return new URL(value).pathname;
    } catch {
        return '<invalid-url>';
    }
}

async function mainPage(application: ElectronApplication): Promise<Page> {
    const context = application.context();
    const url = pathToFileURL(join(electronProject, 'web', 'index.html')).href;
    await expect
        .poll(() => context.pages().some((page) => page.url() === url), {
            timeout: 30_000,
        })
        .toBe(true);
    const page = context.pages().find((candidate) => candidate.url() === url);
    if (!page) throw new Error('Electron shell page did not appear');
    await expect(page.locator('#desktop-auth-modal')).toBeAttached();
    return page;
}

async function bodyPage(application: ElectronApplication): Promise<Page> {
    const context = application.context();
    await expect
        .poll(
            () =>
                context
                    .pages()
                    .some((page) => page.url().startsWith('phi-app://app/')),
            { timeout: 60_000, intervals: [100, 250, 500, 1_000] },
        )
        .toBe(true);
    const page = context
        .pages()
        .find((candidate) => candidate.url().startsWith('phi-app://app/'));
    if (!page) throw new Error('Embedded Phi body page did not appear');
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    return page;
}

async function unlockV2(
    main: Page,
    body: Page,
    password: string,
    diagnostics: Diagnostics,
): Promise<void> {
    const modal = main.locator('#desktop-auth-modal');
    await expect(modal).toBeVisible({ timeout: 60_000 });
    await main.locator('#desktop-auth-input').fill(password);
    await main.locator('#desktop-auth-submit').click();
    await expect(modal).toBeHidden({ timeout: 60_000 });
    await expectProtectedAPI(body);
    await expect(body.locator('.access-auth-overlay')).toBeHidden();
    diagnostics.markAuthenticated();
}

async function expectProtectedAPI(body: Page): Promise<void> {
    await expect
        .poll(
            () =>
                body.evaluate(async () => {
                    try {
                        return (
                            await fetch('/api/coders', { cache: 'no-store' })
                        ).status;
                    } catch {
                        return 0;
                    }
                }),
            { timeout: 60_000, intervals: [250, 500, 1_000] },
        )
        .toBe(200);
}

async function assertEmbeddedCredentialBoundary(
    application: ElectronApplication,
    body: Page,
): Promise<void> {
    const renderer = await body.evaluate(() => {
        const auth = window.phiAccessAuth;
        const localKeys = Object.keys(localStorage);
        let cookie = '';
        try {
            cookie = document.cookie;
        } catch {
            // A custom secure scheme may not expose document.cookie.
        }
        return {
            accessTokenInMemory:
                typeof auth?.getAccessToken === 'function' &&
                Boolean(auth.getAccessToken()),
            jwtKeyCount: localKeys.filter((key) =>
                /jwt|bearer|access.?token/i.test(key),
            ).length,
            refreshHandleKeyCount: localKeys.filter((key) =>
                /refresh.?handle/i.test(key),
            ).length,
            refreshCookieCount: cookie
                .split(';')
                .filter((part) => /^\s*phi_access_refresh=/.test(part)).length,
        };
    });
    expect(renderer.accessTokenInMemory).toBe(false);
    expect(renderer.jwtKeyCount).toBe(0);
    expect(renderer.refreshHandleKeyCount).toBe(0);
    expect(renderer.refreshCookieCount).toBe(0);

    const hostCookies = await application.evaluate(async ({ session }) => {
        const cookies = await session
            .fromPartition('persist:phi-embedded')
            .cookies.get({});
        return cookies.filter(
            (cookie) =>
                cookie.name === 'phi_access_refresh' ||
                cookie.name === 'phi_access_asset',
        ).length;
    });
    expect(hostCookies).toBe(0);
}

async function openSocket(
    body: Page,
    socketPath: string,
    subprotocol: string,
): Promise<void> {
    const outcome = await body.evaluate(
        ({ socketPath, subprotocol }) =>
            new Promise<string>((resolveSocket, rejectSocket) => {
                const origin = new URLSearchParams(location.search).get(
                    'origin',
                );
                if (!origin) {
                    rejectSocket(
                        new Error('Embedded backend origin is missing'),
                    );
                    return;
                }
                const target = new URL(socketPath, origin);
                target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
                const socket = new WebSocket(target.href, subprotocol);
                let settled = false;
                const timer = window.setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    socket.close();
                    rejectSocket(new Error('WebSocket open timed out'));
                }, 15_000);
                socket.onopen = () => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    socket.close(1000);
                    resolveSocket('open');
                };
                socket.onerror = () => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    rejectSocket(new Error('WebSocket failed'));
                };
                socket.onclose = () => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    rejectSocket(new Error('WebSocket closed before opening'));
                };
            }),
        { socketPath, subprotocol },
    );
    expect(outcome).toBe('open');
}

async function assertOwnedAppPaths(
    application: ElectronApplication,
    paths: ElectronPaths,
): Promise<void> {
    const evidence = await application.evaluate(({ app }, root) => {
        const fs = process.getBuiltinModule(
            'node:fs',
        ) as typeof import('node:fs');
        const path = process.getBuiltinModule(
            'node:path',
        ) as typeof import('node:path');
        const os = process.getBuiltinModule(
            'node:os',
        ) as typeof import('node:os');
        const owned = [
            'appData',
            'userData',
            'home',
            'temp',
            'sessionData',
            'logs',
            'crashDumps',
        ].every((name) => {
            const actual = fs.realpathSync(
                app.getPath(name as Parameters<typeof app.getPath>[0]),
            );
            const rel = path.relative(root, actual);
            return (
                rel !== '' &&
                rel !== '..' &&
                !rel.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(rel)
            );
        });
        const home = app.getPath('home');
        const localPhi = path.join(home, '.phi');
        const forbiddenFiles = [
            'config.toml',
            'config.json',
            'auth.db',
            'auth-v2-state.json',
        ];
        const localPhiFileCount = forbiddenFiles.filter((name) =>
            fs.existsSync(path.join(localPhi, name)),
        ).length;
        const legacyAppDataCount = ['phi-desktop-electron', 'Phi'].filter(
            (name) => fs.existsSync(path.join(app.getPath('appData'), name)),
        ).length;
        return {
            owned,
            nodeHomeMatches: os.homedir() === home,
            localPhiFileCount,
            legacyAppDataCount,
        };
    }, paths.root);
    expect(evidence.owned).toBe(true);
    expect(evidence.nodeHomeMatches).toBe(true);
    expect(evidence.localPhiFileCount).toBe(0);
    expect(evidence.legacyAppDataCount).toBe(0);
}

async function seedV1Store(
    application: ElectronApplication,
    origin: string,
): Promise<void> {
    const result = await application.evaluate(
        ({ app, safeStorage }, fixture) => {
            const fs = process.getBuiltinModule(
                'node:fs',
            ) as typeof import('node:fs');
            const path = process.getBuiltinModule(
                'node:path',
            ) as typeof import('node:path');
            const available = safeStorage.isEncryptionAvailable();
            const secureBackend =
                process.platform !== 'linux' ||
                safeStorage.getSelectedStorageBackend() !== 'basic_text';
            if (!available || !secureBackend) {
                return {
                    available,
                    secureBackend: false,
                    fileExists: false,
                    validEntry: false,
                };
            }
            const file = path.join(
                app.getPath('userData'),
                'access-credentials.bin',
            );
            const encrypted = safeStorage.encryptString(
                JSON.stringify({
                    origins: { [fixture.origin]: fixture.entry },
                }),
            );
            fs.writeFileSync(file, encrypted, { mode: 0o600 });
            const ciphertext = fs.readFileSync(file);
            const decrypted = JSON.parse(safeStorage.decryptString(ciphertext));
            const origins = decrypted?.origins ?? {};
            const entry = origins[fixture.origin];
            return {
                available,
                secureBackend: true,
                fileExists: fs.statSync(file).isFile(),
                privateMode: (fs.statSync(file).mode & 0o077) === 0,
                originCount: Object.keys(origins).length,
                validEntry:
                    entry?.version === 'v1' &&
                    entry?.algorithm === 'pbkdf2-sha256' &&
                    entry?.iterations === fixture.entry.iterations &&
                    entry?.saltBase64 === fixture.entry.saltBase64 &&
                    entry?.verifierBase64 === fixture.entry.verifierBase64,
                ciphertextHidesVerifier: !ciphertext
                    .toString('utf8')
                    .includes(fixture.entry.verifierBase64),
            };
        },
        { origin, entry: v1Entry },
    );
    expect(result.available).toBe(true);
    expect(result.secureBackend).toBe(true);
    expect(result.fileExists).toBe(true);
    expect(result.privateMode).toBe(true);
    expect(result.originCount).toBe(1);
    expect(result.validEntry).toBe(true);
    expect(result.ciphertextHidesVerifier).toBe(true);
}

async function inspectCredentialStore(
    application: ElectronApplication,
    origin: string,
): Promise<{
    available: boolean;
    secureBackend: boolean;
    fileExists: boolean;
    privateMode: boolean;
    originCount: number;
    expectedOrigin: boolean;
    version: string;
    jwtChars: number;
    refreshHandleChars: number;
    verifierChars: number;
    ciphertextHidesCredentials: boolean;
}> {
    return application.evaluate(({ app, safeStorage }, expectedOrigin) => {
        const fs = process.getBuiltinModule(
            'node:fs',
        ) as typeof import('node:fs');
        const path = process.getBuiltinModule(
            'node:path',
        ) as typeof import('node:path');
        const available = safeStorage.isEncryptionAvailable();
        const secureBackend =
            process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text';
        const file = path.join(
            app.getPath('userData'),
            'access-credentials.bin',
        );
        if (!available || !secureBackend || !fs.existsSync(file)) {
            return {
                available,
                secureBackend,
                fileExists: fs.existsSync(file),
                privateMode: false,
                originCount: 0,
                expectedOrigin: false,
                version: '',
                jwtChars: 0,
                refreshHandleChars: 0,
                verifierChars: 0,
                ciphertextHidesCredentials: false,
            };
        }
        const stats = fs.statSync(file);
        const ciphertext = fs.readFileSync(file);
        const parsed = JSON.parse(safeStorage.decryptString(ciphertext));
        const origins = parsed?.origins ?? {};
        const entry = origins[expectedOrigin];
        const jwt = typeof entry?.jwt === 'string' ? entry.jwt : '';
        const refreshHandle =
            typeof entry?.refreshHandle === 'string' ? entry.refreshHandle : '';
        const salt =
            typeof entry?.saltBase64 === 'string' ? entry.saltBase64 : '';
        const verifier =
            typeof entry?.verifierBase64 === 'string'
                ? entry.verifierBase64
                : '';
        const credentialFields = [jwt, refreshHandle, salt, verifier].filter(
            (field) => field.length > 0,
        );
        const raw = ciphertext.toString('utf8');
        return {
            available,
            secureBackend: true,
            fileExists: stats.isFile(),
            privateMode: (stats.mode & 0o077) === 0,
            originCount: Object.keys(origins).length,
            expectedOrigin:
                Object.keys(origins).length === 1 &&
                Object.hasOwn(origins, expectedOrigin),
            version: typeof entry?.version === 'string' ? entry.version : '',
            jwtChars: jwt.length,
            refreshHandleChars: refreshHandle.length,
            verifierChars: verifier.length,
            ciphertextHidesCredentials:
                credentialFields.length > 0 &&
                credentialFields.every((field) => !raw.includes(field)),
        };
    }, origin);
}

function v2DatabaseState(server: PhiServer): {
    maxGeneration: bigint;
    consumedHandles: number;
} {
    const database = join(server.dir, 'home', '.phi', 'auth.db');
    const rows = execFileSync(
        'sqlite3',
        ['-readonly', database, 'SELECT hex(generation) FROM auth_families;'],
        { cwd: repoRoot, encoding: 'utf8' },
    )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    const maxGeneration = rows.reduce((max, hex) => {
        const generation = BigInt(`0x${hex}`);
        return generation > max ? generation : max;
    }, 0n);
    const consumedHandles = Number(
        execFileSync(
            'sqlite3',
            [
                '-readonly',
                database,
                'SELECT COUNT(*) FROM auth_consumed_handles;',
            ],
            { cwd: repoRoot, encoding: 'utf8' },
        ).trim(),
    );
    return { maxGeneration, consumedHandles };
}

async function assertLegacyServer(server: PhiServer): Promise<void> {
    const response = await fetch(`${server.url}/api/auth/status`);
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
        enabled?: boolean;
        version?: string;
        iterations?: number;
        salt?: string;
        protocols?: string[];
    };
    expect(status.enabled).toBe(true);
    expect(status.version).toBe('v1');
    expect(status.iterations).toBe(600_000);
    expect(status.salt).toBe(b64url(v1Salt));
    expect(status.protocols).toContain('v1');
    expect(status.protocols).toContain('v2');
}

function seedLegacyServer(dir: string): void {
    const configDir = join(dir, 'home', '.phi');
    mkdirSync(configDir, { recursive: true });
    if (existsSync(join(configDir, 'config.toml'))) {
        throw new Error('Legacy Electron fixture unexpectedly has config.toml');
    }
    writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
            access_password_hash: v1PasswordHash,
            theme_color: 'teal',
            quick_commands: [
                { name: 'auth fixture', command: 'printf auth-mvp' },
            ],
            sync_coordinator: '',
            peers: [],
        }),
        { mode: 0o600 },
    );

    const familyBytes = Buffer.alloc(32, 0x33);
    const generation = Buffer.alloc(8);
    const refreshKey = Buffer.from(
        hkdfSync('sha256', v1Verifier, v1Salt, 'phi/refresh-handle/v1', 32),
    );
    const handle = createHmac('sha256', refreshKey)
        .update('phi/refresh-handle/v1\0')
        .update(familyBytes)
        .update(generation)
        .digest();
    const now = Math.floor(Date.now() / 1000);
    const legacyState = {
        version: 1,
        active: {
            record_binding: createHash('sha256')
                .update(v1PasswordHash)
                .digest('hex'),
            record_id: b64url(Buffer.alloc(32, 0x22)),
            epoch: 1,
            refresh_key: b64url(refreshKey),
            families: [
                {
                    id: b64url(familyBytes),
                    generation: 0,
                    created_at: now - 30,
                    last_used_at: now - 10,
                    idle_expires_at: now + 3600,
                    absolute_expires_at: now + 7200,
                    active_digest: createHash('sha256')
                        .update(handle)
                        .digest('hex'),
                    current_access: {
                        iat: now - 30,
                        exp: now + 1800,
                        jti: b64url(Buffer.alloc(32, 0x44)),
                    },
                    consumed: [],
                },
            ],
        },
    };
    writeFileSync(
        join(configDir, 'auth-v2-state.json'),
        JSON.stringify(legacyState),
        { mode: 0o600 },
    );
}

test.beforeEach(() => {
    phi = null;
    electron = null;
    launchUncertain = false;
});

test.afterEach(async () => {
    if (electron) {
        try {
            await closeElectron();
        } catch (error) {
            throw new Error(
                `Electron cleanup is uncertain; retaining ${phi?.dir ?? 'fixture directory'}: ${String(error)}`,
            );
        }
    }
    if (launchUncertain) {
        throw new Error(
            `Electron launch ownership is uncertain; retaining ${phi?.dir ?? 'fixture directory'}`,
        );
    }
    if (phi) {
        await phi.stop();
        phi = null;
    }
});

test('MVP Electron / v2 login and restart', async () => {
    phi = await startPhi();
    const server = phi;
    const passwordResponse = await fetch(`${server.url}/api/auth/v2/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Phi-Auth': 'v2' },
        body: JSON.stringify({ password: v2Password }),
    });
    expect(passwordResponse.status).toBe(200);
    await passwordResponse.body?.cancel();

    const paths = createPaths(server);
    seedSingleTab(paths);
    let owned = await launchElectron(paths, server.url);
    let appDiagnostics = diagnostics(owned.application);
    let main = await mainPage(owned.application);
    await main.waitForLoadState('domcontentloaded');
    let body = await bodyPage(owned.application);
    await expect(body.locator('#sidebar-panel')).toBeVisible();
    await unlockV2(main, body, v2Password, appDiagnostics);
    await assertOwnedAppPaths(owned.application, paths);
    await assertEmbeddedCredentialBoundary(owned.application, body);
    await openSocket(body, '/ws/md-events', 'phi.events.protobuf.v1');
    await openSocket(body, '/ws/control', 'phi.control.protobuf.v1');
    expect(hotkeyAttempts(paths)).toEqual(['CommandOrControl+Shift+L']);

    const firstStore = await inspectCredentialStore(
        owned.application,
        server.url,
    );
    expect(firstStore.available).toBe(true);
    expect(firstStore.secureBackend).toBe(true);
    expect(firstStore.fileExists).toBe(true);
    expect(firstStore.privateMode).toBe(true);
    expect(firstStore.originCount).toBe(1);
    expect(firstStore.expectedOrigin).toBe(true);
    expect(firstStore.version).toBe('v2');
    expect(firstStore.jwtChars).toBeGreaterThan(0);
    expect(firstStore.refreshHandleChars).toBeGreaterThan(0);
    expect(firstStore.ciphertextHidesCredentials).toBe(true);
    expect(v2DatabaseState(server).maxGeneration).toBe(0n);
    console.log('Electron auth checkpoint: v2 encrypted login passed');
    const initialDiagnostics = appDiagnostics;
    await closeElectron();

    owned = await launchElectron(paths, server.url);
    appDiagnostics = diagnostics(owned.application);
    main = await mainPage(owned.application);
    await main.waitForLoadState('domcontentloaded');
    body = await bodyPage(owned.application);
    await expect(body.locator('#sidebar-panel')).toBeVisible();
    await expectProtectedAPI(body);
    appDiagnostics.markAuthenticated();
    await expect(main.locator('#desktop-auth-modal')).toBeHidden();
    await assertOwnedAppPaths(owned.application, paths);
    await assertEmbeddedCredentialBoundary(owned.application, body);
    await openSocket(body, '/ws/md-events', 'phi.events.protobuf.v1');
    await openSocket(body, '/ws/control', 'phi.control.protobuf.v1');
    expect(hotkeyAttempts(paths)).toEqual([
        'CommandOrControl+Shift+L',
        'CommandOrControl+Shift+L',
    ]);

    const restartedStore = await inspectCredentialStore(
        owned.application,
        server.url,
    );
    expect(restartedStore.available).toBe(true);
    expect(restartedStore.secureBackend).toBe(true);
    expect(restartedStore.fileExists).toBe(true);
    expect(restartedStore.privateMode).toBe(true);
    expect(restartedStore.originCount).toBe(1);
    expect(restartedStore.expectedOrigin).toBe(true);
    expect(restartedStore.version).toBe('v2');
    expect(restartedStore.jwtChars).toBeGreaterThan(0);
    expect(restartedStore.refreshHandleChars).toBeGreaterThan(0);
    expect(restartedStore.ciphertextHidesCredentials).toBe(true);
    const afterRefresh = v2DatabaseState(server);
    expect(afterRefresh.maxGeneration).toBeGreaterThan(0n);
    expect(afterRefresh.consumedHandles).toBeGreaterThan(0);
    await expect(body.locator('.access-auth-overlay')).toBeHidden();
    console.log(
        'Electron auth checkpoint: v2 restart refreshed without a password',
    );
    // Preserve both hard diagnostic gates after exercising the auth path.
    initialDiagnostics.assertClean();
    appDiagnostics.assertClean();
    await closeElectron();
});

test('MVP Electron / saved v1', async () => {
    phi = await startPhi({ setup: seedLegacyServer });
    const server = phi;
    await assertLegacyServer(server);
    const paths = createPaths(server);
    seedSingleTab(paths);

    let owned = await launchElectron(paths);
    let appDiagnostics = diagnostics(owned.application);
    const blankMain = await mainPage(owned.application);
    await blankMain.waitForLoadState('domcontentloaded');
    await assertOwnedAppPaths(owned.application, paths);
    await seedV1Store(owned.application, server.url);
    expect(hotkeyAttempts(paths)).toEqual(['CommandOrControl+Shift+L']);
    appDiagnostics.assertClean();
    await closeElectron();

    // A returning user has both the saved credential and its saved server.
    seedSingleTab(paths, server.url);
    owned = await launchElectron(paths, server.url);
    appDiagnostics = diagnostics(owned.application);
    const main = await mainPage(owned.application);
    await main.waitForLoadState('domcontentloaded');
    const body = await bodyPage(owned.application);
    await expect(body.locator('#sidebar-panel')).toBeVisible();
    await expectProtectedAPI(body);
    appDiagnostics.markAuthenticated();
    await expect(main.locator('#desktop-auth-modal')).toBeHidden();
    await assertOwnedAppPaths(owned.application, paths);
    await assertEmbeddedCredentialBoundary(owned.application, body);
    await openSocket(body, '/ws/md-events', 'phi.events.protobuf.v1');
    await openSocket(body, '/ws/control', 'phi.control.protobuf.v1');
    expect(hotkeyAttempts(paths)).toEqual([
        'CommandOrControl+Shift+L',
        'CommandOrControl+Shift+L',
    ]);

    await expect(body.locator('.access-auth-overlay')).toBeHidden();
    const stored = await inspectCredentialStore(owned.application, server.url);
    expect(stored.available).toBe(true);
    expect(stored.secureBackend).toBe(true);
    expect(stored.fileExists).toBe(true);
    expect(stored.privateMode).toBe(true);
    expect(stored.originCount).toBe(1);
    expect(stored.expectedOrigin).toBe(true);
    expect(stored.version).toBe('v1');
    expect(stored.jwtChars).toBe(0);
    expect(stored.refreshHandleChars).toBe(0);
    expect(stored.verifierChars).toBeGreaterThan(0);
    expect(stored.ciphertextHidesCredentials).toBe(true);
    console.log(
        'Electron auth checkpoint: saved v1 restored without a password',
    );
    appDiagnostics.assertClean();
    await closeElectron();
});
