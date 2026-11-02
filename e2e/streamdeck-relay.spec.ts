import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, sep } from 'node:path';
import { once } from 'node:events';
import {
    _electron,
    expect,
    request as playwrightRequest,
    test,
    type APIRequestContext,
    type ElectronApplication,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

interface RelayDescriptor {
    version: number;
    socketPath: string;
    instance: string;
    capability: string;
}

interface RelayFrame {
    v?: number;
    kind?: string;
    id?: string;
    ok?: boolean;
    result?: unknown;
}

interface RelayState {
    status: string;
    profileId?: string;
    epoch?: string;
    activePaneId?: string | null;
    tabs?: Array<{ paneId: string; label: string }>;
}

const desktopPackage = join(process.cwd(), 'desktop', 'electron');
const requireElectron = createRequire(join(desktopPackage, 'package.json'));
const electronBinary = requireElectron('electron') as string;
const desktopEntry = join(desktopPackage, 'dist', 'main.js');
const desktopLauncher = join(desktopPackage, 'streamdeck-e2e-launcher.mjs');

function desktopEnv(root: string, origins: string[]): Record<string, string> {
    const home = join(root, 'home');
    const runTmp = join(root, 'tmp');
    const env: Record<string, string> = {};
    for (const key of [
        'PATH',
        'PATHEXT',
        'SYSTEMROOT',
        'COMSPEC',
        'WINDIR',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'LC_MESSAGES',
        'LANGUAGE',
    ]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        TMPDIR: runTmp,
        TMP: runTmp,
        TEMP: runTmp,
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        XDG_CACHE_HOME: join(root, 'xdg-cache'),
        XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_STATE_HOME: join(root, 'xdg-state'),
        PHI_E2E_DESKTOP_ROOT: root,
        PHI_E2E_DESKTOP_MAIN: desktopEntry,
        PHI_E2E_ALLOWED_ORIGINS: JSON.stringify(origins),
    });
    return env;
}

async function configureFixture(
    request: APIRequestContext,
    phi: PhiServer,
): Promise<string> {
    const response = await request.post(
        `${phi.url}/api/config/sync-coordinator`,
        { data: { sync_coordinator: phi.url } },
    );
    if (!response.ok()) {
        throw new Error(
            `fixture coordinator returned HTTP ${response.status()}`,
        );
    }
    const cwd = join(phi.dir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    return cwd;
}

async function createPane(
    request: APIRequestContext,
    phi: PhiServer,
    cwd: string,
    title: string,
): Promise<string> {
    const response = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd, title },
    });
    if (!response.ok()) {
        throw new Error(
            `fixture pane creation returned HTTP ${response.status()}`,
        );
    }
    const body = (await response.json()) as { pane_id?: unknown };
    if (typeof body.pane_id !== 'string' || body.pane_id === '') {
        throw new Error('fixture did not return a pane id');
    }
    return body.pane_id;
}

async function addProfileState(
    userData: string,
    profiles: Array<{
        id: string;
        name: string;
        origin: string;
        lastUsed: string;
    }>,
): Promise<void> {
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    const store = {
        profiles,
        closeToTray: false,
        syncAlerts: false,
        lowMemoryMode: false,
        lowPowerMode: false,
        petEnabled: false,
        streamDeckEnabled: true,
        petZoomPercent: 100,
        contentZoomPercent: 100,
        petIdleDwellSeconds: 120,
    };
    const file = join(userData, 'profiles.json');
    writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
}

function readDescriptor(path: string, root: string): RelayDescriptor {
    const descriptor = JSON.parse(
        readFileSync(path, 'utf8'),
    ) as RelayDescriptor;
    if (
        descriptor.version !== 1 ||
        typeof descriptor.socketPath !== 'string' ||
        typeof descriptor.instance !== 'string' ||
        typeof descriptor.capability !== 'string' ||
        !descriptor.socketPath.startsWith(`${root}${sep}`)
    ) {
        throw new Error('relay published an invalid or uncontained descriptor');
    }
    return descriptor;
}

async function remoteActivePane(
    desktop: ElectronApplication,
    origin: string,
): Promise<string | null> {
    return desktop.evaluate(async ({ webContents }, expectedOrigin) => {
        const contents = webContents.getAllWebContents().find((item) => {
            try {
                return new URL(item.getURL()).origin === expectedOrigin;
            } catch {
                return false;
            }
        });
        if (!contents || contents.isDestroyed()) return null;
        try {
            return await contents.executeJavaScript(
                "document.querySelector('.tab.active')?.getAttribute('data-pane-id') ?? null",
            );
        } catch {
            return null;
        }
    }, new URL(origin).origin);
}

class RelayClient {
    private readonly socket: Socket;
    private readonly lines: ReturnType<typeof createInterface>;
    private readonly frames: AsyncIterator<string>;
    private nextId = 0;

    private constructor(socket: Socket) {
        this.socket = socket;
        socket.on('error', () => {});
        this.lines = createInterface({ input: socket });
        this.frames = this.lines[Symbol.asyncIterator]();
    }

    static async connect(descriptor: RelayDescriptor): Promise<RelayClient> {
        const socket = net.createConnection({ path: descriptor.socketPath });
        await once(socket, 'connect');
        const client = new RelayClient(socket);
        socket.write(
            `${JSON.stringify({
                v: descriptor.version,
                kind: 'auth',
                instance: descriptor.instance,
                capability: descriptor.capability,
            })}\n`,
        );
        const ready = await client.nextFrame();
        if (ready.v !== 1 || ready.kind !== 'ready') {
            client.close();
            throw new Error(
                'relay did not complete its authenticated handshake',
            );
        }
        return client;
    }

    async request(
        op: string,
        fields: Record<string, string> = {},
    ): Promise<RelayFrame> {
        const id = `e2e-${++this.nextId}`;
        this.socket.write(`${JSON.stringify({ v: 1, id, op, ...fields })}\n`);
        for (;;) {
            const frame = await this.nextFrame();
            if (frame.id === id) return frame;
        }
    }

    close(): void {
        this.lines.close();
        this.socket.destroy();
    }

    private async nextFrame(): Promise<RelayFrame> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const frame = await Promise.race([
                this.frames.next(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'relay did not reply within 10 seconds',
                                ),
                            ),
                        10_000,
                    );
                }),
            ]);
            if (frame.done) throw new Error('relay closed before replying');
            return JSON.parse(frame.value) as RelayFrame;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

async function waitForState(
    client: RelayClient,
    profileId: string,
): Promise<RelayState> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const frame = await client.request('getState');
        if (
            frame.ok === true &&
            typeof frame.result === 'object' &&
            frame.result !== null
        ) {
            const state = frame.result as RelayState;
            if (state.status === 'available' && state.profileId === profileId)
                return state;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Desktop did not publish an available active-tab state');
}

test('the authenticated Desktop relay selects only an existing tab on the active Phi profile', async ({
    request,
}) => {
    test.skip(
        process.platform !== 'darwin',
        'the Stream Deck relay is macOS-only',
    );
    test.setTimeout(240_000);
    expect(
        existsSync(desktopEntry),
        'build the Electron app before this E2E',
    ).toBe(true);
    expect(
        existsSync(electronBinary),
        'Electron must be installed in its workspace',
    ).toBe(true);

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sd-')));
    chmodSync(root, 0o700);
    const rootStat = statSync(root);
    expect(rootStat.isDirectory()).toBe(true);
    expect(rootStat.mode & 0o777).toBe(0o700);
    const currentUid = process.getuid?.();
    if (currentUid !== undefined) expect(rootStat.uid).toBe(currentUid);

    let phiA: PhiServer | null = null;
    let phiB: PhiServer | null = null;
    let desktop: ElectronApplication | null = null;
    let desktopProcess: ChildProcess | null = null;
    let client: RelayClient | null = null;
    let safeToRemoveRoot = true;
    const home = join(root, 'home');
    const userData = join(root, 'user-data');
    const descriptorPath = join(home, '.phi', 'streamdeck', 'relay.json');
    const socketPath = join(home, '.phi', 'streamdeck', 'relay.sock');

    try {
        phiA = await startPhi();
        phiB = await startPhi();
        const cwdA = await configureFixture(request, phiA);
        const cwdB = await configureFixture(request, phiB);
        const paneA1 = await createPane(request, phiA, cwdA, 'Relay A one');
        const paneA2 = await createPane(request, phiA, cwdA, 'Relay A two');
        const paneB = await createPane(request, phiB, cwdB, 'Relay B only');
        const originA = new URL('/', phiA.url).toString();
        const originB = new URL('/', phiB.url).toString();

        await addProfileState(userData, [
            {
                id: 'relay-fixture-a',
                name: 'Relay fixture A',
                origin: originA,
                lastUsed: '2026-01-02T00:00:00.000Z',
            },
            {
                id: 'relay-fixture-b',
                name: 'Relay fixture B',
                origin: originB,
                lastUsed: '2026-01-01T00:00:00.000Z',
            },
        ]);
        const relayPathBytes = Buffer.byteLength(socketPath, 'utf8');
        expect(relayPathBytes).toBeLessThanOrEqual(100);

        const launchedDesktop = await _electron.launch({
            executablePath: electronBinary,
            args: [desktopLauncher],
            cwd: desktopPackage,
            env: desktopEnv(root, [
                new URL(originA).origin,
                new URL(originB).origin,
            ]),
            timeout: 45_000,
        });
        desktop = launchedDesktop;
        desktopProcess = launchedDesktop.process();
        const shell = await launchedDesktop.firstWindow({ timeout: 30_000 });
        await expect(shell).toHaveTitle('Phi');
        await expect
            .poll(() => existsSync(descriptorPath), { timeout: 20_000 })
            .toBe(true);

        const descriptorStat = statSync(descriptorPath);
        const socketStat = statSync(socketPath);
        expect(descriptorStat.mode & 0o777).toBe(0o600);
        expect(socketStat.isSocket()).toBe(true);
        expect(socketStat.mode & 0o777).toBe(0o600);
        const descriptor = readDescriptor(descriptorPath, root);
        expect(descriptor.socketPath).toBe(socketPath);
        if (currentUid !== undefined) {
            expect(descriptorStat.uid).toBe(currentUid);
            expect(socketStat.uid).toBe(currentUid);
        }

        client = await RelayClient.connect(descriptor);
        const initial = await waitForState(client, 'relay-fixture-a');
        expect(initial.tabs?.map((tab) => tab.paneId)).toEqual(
            expect.arrayContaining([paneA1, paneA2]),
        );
        const targetPane = initial.tabs?.find(
            (tab) => tab.paneId !== initial.activePaneId,
        )?.paneId;
        expect(targetPane).toBeTruthy();

        const binding = await client.request('bindCurrent');
        expect(binding.ok).toBe(true);
        expect(binding.result).toMatchObject({
            status: 'bound',
            target: {
                profileId: 'relay-fixture-a',
                paneId: initial.activePaneId,
            },
        });

        const epoch = initial.epoch;
        const profileId = initial.profileId;
        if (!epoch || !profileId || !targetPane) {
            throw new Error('relay state omitted its selection identity');
        }
        const selection = await client.request('selectTab', {
            epoch,
            profileId,
            paneId: targetPane,
        });
        expect(selection.ok).toBe(true);
        expect(selection.result).toMatchObject({
            status: 'selected',
            state: { profileId: 'relay-fixture-a', activePaneId: targetPane },
        });
        await expect
            .poll(() => remoteActivePane(launchedDesktop, originA), {
                timeout: 10_000,
            })
            .toBe(targetPane);

        const foreignSelection = await client.request('selectTab', {
            epoch,
            profileId: 'relay-fixture-b',
            paneId: paneB,
        });
        expect(foreignSelection.ok).toBe(true);
        expect(foreignSelection.result).toEqual({ status: 'unavailable' });
        const afterForeignRequest = await client.request('getState');
        expect(afterForeignRequest.result).toMatchObject({
            status: 'available',
            profileId: 'relay-fixture-a',
            activePaneId: targetPane,
        });
        await expect
            .poll(() => remoteActivePane(launchedDesktop, originA), {
                timeout: 5_000,
            })
            .toBe(targetPane);

        const diagnostics = await launchedDesktop.evaluate(() => {
            const value = (
                globalThis as typeof globalThis & {
                    __phiStreamDeckE2EDiagnostics?: {
                        consoleErrors: string[];
                        failedLoads: unknown[];
                        failedRequests: Array<{
                            url: string;
                            error: string;
                            resourceType: string;
                        }>;
                        blockedOrigins: string[];
                    };
                }
            ).__phiStreamDeckE2EDiagnostics;
            return value ?? null;
        });
        expect(diagnostics).not.toBeNull();
        expect(diagnostics?.consoleErrors).toEqual([]);
        expect(diagnostics?.failedLoads).toEqual([]);
        expect(diagnostics?.blockedOrigins).toEqual([]);
        // Electron can report ERR_CACHE_MISS for a font even when the
        // fixture serves the WOFF2 successfully; retain each error and
        // verify the exact allowlisted local asset rather than hiding it.
        const failedRequests = diagnostics?.failedRequests ?? [];
        const fontCacheMisses = failedRequests.filter(
            (failure) =>
                failure.error === 'net::ERR_CACHE_MISS' &&
                failure.resourceType === 'font',
        );
        expect(fontCacheMisses).toHaveLength(failedRequests.length);
        if (fontCacheMisses.length > 0) {
            const fontRequests = await Promise.all(
                [originA, originB].map((baseURL) =>
                    playwrightRequest.newContext({ baseURL }),
                ),
            );
            try {
                for (const failure of fontCacheMisses) {
                    const failedUrl = new URL(failure.url);
                    const origins = [
                        new URL(originA).origin,
                        new URL(originB).origin,
                    ];
                    const originIndex = origins.indexOf(failedUrl.origin);
                    expect(originIndex).toBeGreaterThanOrEqual(0);
                    expect(failedUrl.pathname).toMatch(
                        /^\/vendor\/fonts\/[^/]+\.woff2$/,
                    );
                    const fontRequest = fontRequests[originIndex];
                    if (!fontRequest) {
                        throw new Error(
                            'failed font was not from a fixture origin',
                        );
                    }
                    const response = await fontRequest.get(failedUrl.pathname);
                    expect(response.status()).toBe(200);
                    expect((await response.body()).byteLength).toBeGreaterThan(
                        0,
                    );
                }
            } finally {
                await Promise.all(
                    fontRequests.map((context) => context.dispose()),
                );
            }
        }
        await test.info().attach('electron-diagnostics.json', {
            body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
            contentType: 'application/json',
        });

        client.close();
        client = null;
        const closed = launchedDesktop.waitForEvent('close', {
            timeout: 20_000,
        });
        await launchedDesktop.evaluate(({ app }) => app.quit());
        await closed;
        expect(desktopProcess?.exitCode).toBe(0);
        expect(existsSync(descriptorPath)).toBe(false);
        expect(existsSync(socketPath)).toBe(false);
    } finally {
        client?.close();
        if (desktop) {
            if (
                desktopProcess?.exitCode === null &&
                desktopProcess.signalCode === null
            ) {
                try {
                    const closed = desktop.waitForEvent('close', {
                        timeout: 15_000,
                    });
                    await desktop.evaluate(({ app }) => app.quit());
                    await closed;
                } catch {
                    try {
                        await desktop.close();
                    } catch {
                        // Retain the private root below if process exit is still unknown.
                    }
                }
            }
            safeToRemoveRoot =
                !desktopProcess ||
                desktopProcess.exitCode !== null ||
                desktopProcess.signalCode !== null;
            if (!safeToRemoveRoot) {
                console.error(
                    `Stream Deck E2E retained private root; Electron exit unconfirmed: ${root}`,
                );
            }
        }
        await phiB?.stop();
        await phiA?.stop();
        if (safeToRemoveRoot) rmSync(root, { recursive: true, force: true });
    }
});
