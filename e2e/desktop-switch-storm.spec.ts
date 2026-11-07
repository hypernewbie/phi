import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { _electron, expect, test } from '@playwright/test';
import {
    startPhi,
    type ElectronFixturePaths,
    type PhiServer,
} from './_server.js';

// FUNDAMENTAL CONTRACT — the single-tab (low-power) desktop switch storm.
//
// One BrowserView shows every server. A rail click must never let the
// new server answer the old page's headerless requests, and after any
// storm of rapid clicks the page must be exactly one server: the one
// clicked last. "It thinks one server is another server" is a defect,
// never a trade-off.
//
// KNOWN RACE, exposed by R-e2e-window: the main-process routing pointer
// flips synchronously on the rail click, before the compat probe of the
// new server answers. Inside the probe window the page still renders the
// old server while its headerless requests are answered by the new one
// (shown=A, routed=B). This is the desktop-level twin of the transport
// races R-window/R-fallback/R-active in desktop/electron/test/
// switch-race.test.ts. The test is marked failing until the transport
// serializes routing with the probe.

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..', 'desktop', 'electron');
const appDir = join(here, 'fixtures', 'mobile-settings-app');

test.skip(
    process.platform === 'linux' &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY,
    'Real Electron requires DISPLAY or WAYLAND_DISPLAY on Linux.',
);
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const HOST_A = 'storm-alpha-7f3a';
const HOST_B = 'storm-beta-c29e';
/** How long server B's compat probe is held open, in ms. */
const PROBE_DELAY_MS = 500;

function electronBinary(): string {
    const pathTxt = join(electronDir, 'node_modules', 'electron', 'path.txt');
    if (!existsSync(pathTxt)) throw new Error('electron path.txt missing');
    const relative = readFileSync(pathTxt, 'utf8').trim();
    const full = join(
        electronDir,
        'node_modules',
        'electron',
        'dist',
        relative,
    );
    if (!existsSync(full)) throw new Error(`electron binary missing: ${full}`);
    return full;
}

interface OwnedPaths extends ElectronFixturePaths {
    userData: string;
}

function ownedPaths(root: string): OwnedPaths {
    const paths: OwnedPaths = {
        home: join(root, 'home'),
        appData: join(root, 'appdata'),
        userData: join(root, 'userdata'),
        config: join(root, 'config'),
        cache: join(root, 'cache'),
        data: join(root, 'data'),
        state: join(root, 'state'),
        temp: join(root, 'tmp'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
    return paths;
}

/** A reverse proxy that holds server B's /api/version answer, so the
 *  compat probe — and with it today's routing race — has a measurable
 *  window. Every other row forwards immediately. */
function slowVersionProxy(
    target: string,
): Promise<{ server: http.Server; origin: string }> {
    const server = http.createServer((req, res) => {
        const target_ = new URL(req.url || '/', target);
        const finish = () => {
            const upstream = http.request(
                target_,
                { method: req.method, headers: req.headers },
                (up) => {
                    res.writeHead(up.statusCode ?? 502, up.headers);
                    up.pipe(res);
                },
            );
            upstream.on('error', () => {
                if (!res.headersSent) res.writeHead(502);
                res.end();
            });
            req.pipe(upstream);
        };
        if ((req.url || '').startsWith('/api/version')) {
            setTimeout(finish, PROBE_DELAY_MS);
        } else {
            finish();
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            resolve({ server, origin: `http://127.0.0.1:${port}` });
        });
    });
}

interface HostHandle {
    controller: {
        state: () => {
            profiles: Array<{ id: string; origin: string }>;
            activeId: string;
        };
        setActive: (id: string) => void;
    };
    profileViews: {
        getView: (id: string) => {
            webContents: {
                getURL: () => string;
                executeJavaScript: (code: string) => Promise<unknown>;
            };
        } | null;
        getActive: () => string | null;
    } | null;
    activateServerUrl: (url: string) => void;
}

/** A page read must never wedge the poll: a navigating frame can hold
 *  executeJavaScript forever, so every read races a deadline. */
function withDeadline<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

interface PageMarker {
    hostname: string;
    headerlessHostname: string;
    activePointer: string | null;
}

/** Reads the page's server identity three ways: what it renders, what
 *  a headerless fetch returns (routed by the main-process pointer), and
 *  what the pointer itself says. */
async function readPageMarker(
    app: Awaited<ReturnType<typeof _electron.launch>>,
): Promise<PageMarker> {
    return app.evaluate(async (electronApi: unknown) => {
        const g = globalThis as unknown as { __phiMsHost: HostHandle };
        const views = g.__phiMsHost.profileViews;
        const active = views?.getActive();
        const view = active ? views?.getView(active) : null;
        if (!view) throw new Error('no active profile view');
        return (await Promise.race([
            view.webContents.executeJavaScript(
                `(async () => {
                const host = document.getElementById('hostname-display');
                let viaHeaderless = '';
                try {
                    viaHeaderless = ((await (await fetch('/api/config')).json()).hostname) || '';
                } catch {}
                let pointer = null;
                try {
                    pointer = ((await (await fetch('/__phi/active')).json()).profileId) || null;
                } catch {}
                return {
                    hostname: (host ? host.textContent || '' : '').toUpperCase(),
                    headerlessHostname: viaHeaderless.toUpperCase(),
                    activePointer: pointer,
                };
            })()`,
            ),
            new Promise((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            hostname: 'HUNG',
                            headerlessHostname: 'HUNG',
                            activePointer: null,
                        }),
                    5_000,
                ),
            ),
        ])) as PageMarker;
    });
}

test.describe('desktop single-tab switch storm', () => {
    let phiA: PhiServer | null = null;
    let phiB: PhiServer | null = null;
    let proxy: http.Server | null = null;
    let proxyOrigin = '';
    let app: Awaited<ReturnType<typeof _electron.launch>> | null = null;
    let root = '';

    test.beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'phi-switch-storm-'));
        phiA = await startPhi({
            config: { hostname_override: HOST_A },
            env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        });
        phiB = await startPhi({
            config: { hostname_override: HOST_B },
            env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        });
        const slow = await slowVersionProxy(phiB.url);
        proxy = slow.server;
        proxyOrigin = slow.origin;

        const paths = ownedPaths(join(root, 'run'));
        app = await _electron.launch({
            executablePath: electronBinary(),
            args: [appDir],
            timeout: 60_000,
            env: {
                PATH: process.env.PATH || '',
                HOME: paths.home,
                USERPROFILE: paths.home,
                APPDATA: paths.home,
                TMPDIR: paths.temp,
                TMP: paths.temp,
                TEMP: paths.temp,
                PHI_MS_FIXTURE_DIR: join(root, 'fixture'),
                PHI_MS_A_URL: phiA.url,
                PHI_MS_B_URL: proxyOrigin,
                PHI_DESKTOP_LOW_MEMORY: '1',
                ELECTRON_DISABLE_SANDBOX: '1',
            } as Record<string, string>,
        });
        await expect
            .poll(
                async () =>
                    app!.evaluate(async () => {
                        const g = globalThis as unknown as Record<
                            string,
                            unknown
                        >;
                        if (g.__phiMsStartError) {
                            throw new Error(
                                `fixture start failed: ${String(g.__phiMsStartError)}`,
                            );
                        }
                        return g.__phiMsReady === true;
                    }),
                { timeout: 60_000 },
            )
            .toBe(true);

        // Register both servers (B through the delaying proxy).
        await app.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            g.__phiMsHost.activateServerUrl(process.env.PHI_MS_A_URL!);
            g.__phiMsHost.activateServerUrl(process.env.PHI_MS_B_URL!);
        });

        // Land on A and wait for the single view to boot it.
        await app.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const st = g.__phiMsHost.controller.state();
            const aOrigin = new URL(process.env.PHI_MS_A_URL!).origin;
            const a = st.profiles.find(
                (p) => p.origin.replace(/\/$/, '') === aOrigin,
            );
            if (!a)
                throw new Error(
                    `profile A missing: ${JSON.stringify(st.profiles)}`,
                );
            g.__phiMsHost.controller.setActive(a.id);
        });
        await expect
            .poll(
                async () =>
                    withDeadline(
                        // The needle is passed as an argument: evaluate
                        // serializes the function only, so module-scope
                        // constants do not exist in the main process.
                        app!.evaluate(
                            async (electronApi: unknown, needle: string) => {
                                const g = globalThis as unknown as {
                                    __phiMsHost: HostHandle;
                                };
                                const views = g.__phiMsHost.profileViews;
                                const active = views?.getActive();
                                const view = active
                                    ? views?.getView(active)
                                    : null;
                                if (!view) return false;
                                try {
                                    return Boolean(
                                        await view.webContents.executeJavaScript(
                                            `(document.getElementById('hostname-display')?.textContent || '').toUpperCase().indexOf('${needle}') !== -1 && !!window.__phiEmbed`,
                                        ),
                                    );
                                } catch {
                                    return false;
                                }
                            },
                            HOST_A.slice(0, 10).toUpperCase(),
                        ),
                        3_000,
                        false,
                    ),
                // Gentle cadence: a tight poll floods the Electron main
                // process roundtrip queue and starves the very call it
                // is waiting for.
                { timeout: 60_000, intervals: [2_500] },
            )
            .toBe(true);
    });

    test.afterAll(async () => {
        await app?.close().catch(() => {});
        await new Promise<void>((resolve) => proxy?.close(() => resolve()));
        await phiA?.stop().catch(() => {});
        await phiB?.stop().catch(() => {});
        rmSync(root, { recursive: true, force: true });
    });

    function profileIds(): Promise<{ a: string; b: string }> {
        return app!.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const st = g.__phiMsHost.controller.state();
            const aOrigin = new URL(process.env.PHI_MS_A_URL!).origin;
            const bOrigin = new URL(process.env.PHI_MS_B_URL!).origin;
            const a = st.profiles.find(
                (p) => p.origin.replace(/\/$/, '') === aOrigin,
            );
            const b = st.profiles.find(
                (p) => p.origin.replace(/\/$/, '') === bOrigin,
            );
            if (!a || !b)
                throw new Error(`profiles: ${JSON.stringify(st.profiles)}`);
            return { a: a.id, b: b.id };
        });
    }

    // KNOWN RACE — flips to green when the transport serializes routing
    // with the compat probe. See the header comment.
    test('R-e2e-window: a slow probe must not let the new server answer the old page', async () => {
        // KNOWN RACE — expected to fail until the transport serializes
        // routing with the compat probe; then this flips green.
        test.fail();
        const ids = await profileIds();

        // First activation of B: its compat probe is cold and walks the
        // delaying proxy, so the window lasts ~PROBE_DELAY_MS. Sample the
        // page's headerless routing inside it.
        const samples: string[] = await app!.evaluate(
            async (
                electronApi: unknown,
                arg: { b: string; needle: string },
            ) => {
                const g = globalThis as unknown as { __phiMsHost: HostHandle };
                g.__phiMsHost.controller.setActive(arg.b);
                const views = g.__phiMsHost.profileViews;
                const active = views?.getActive();
                const view = active ? views?.getView(active) : null;
                if (!view) throw new Error('no view');
                const out: string[] = [];
                for (let i = 0; i < 5; i += 1) {
                    const read = Promise.race([
                        view.webContents.executeJavaScript(
                            `(async () => {
                                const shown = document.getElementById('hostname-display')?.textContent || '';
                                let routed = '';
                                try { routed = (await (await fetch('/api/config')).json()).hostname || ''; } catch { routed = 'ERR'; }
                                return shown + '|' + routed;
                            })()`,
                        ),
                        new Promise((r) => setTimeout(() => r('HUNG'), 400)),
                    ]) as Promise<string>;
                    out.push(String(await read));
                    await new Promise((r) => setTimeout(r, 90));
                }
                void arg.needle;
                return out;
            },
            { b: ids.b, needle: HOST_B },
        );

        // Every sample taken while B's probe was still in flight must be
        // server A: the page still shows A, so its headerless requests
        // must still be answered by A. KNOWN RACE at the desktop level —
        // today the router flips on the click, before the probe answers,
        // and B's hostname bleeds into the samples.
        const bled = samples.filter((s) =>
            s.toUpperCase().includes(HOST_B.toUpperCase()),
        );
        expect(bled, `samples: ${JSON.stringify(samples)}`).toEqual([]);
    });

    test('R-e2e-storm: after 14 rapid clicks the page is exactly the last-clicked server', async () => {
        const ids = await profileIds();

        // Warm B's compat cache (both directions once) so the storm is
        // pure switching, and land back on A.
        await app!.evaluate(
            async (electronApi: unknown, arg: { a: string; b: string }) => {
                const g = globalThis as unknown as { __phiMsHost: HostHandle };
                g.__phiMsHost.controller.setActive(arg.b);
                await new Promise((r) => setTimeout(r, 1500));
                g.__phiMsHost.controller.setActive(arg.a);
                await new Promise((r) => setTimeout(r, 1000));
            },
            ids,
        );

        // The monkey storm: rapid alternating clicks ending on B.
        await app!.evaluate(
            async (electronApi: unknown, arg: { a: string; b: string }) => {
                const g = globalThis as unknown as { __phiMsHost: HostHandle };
                const order = [
                    arg.b,
                    arg.a,
                    arg.b,
                    arg.a,
                    arg.b,
                    arg.b,
                    arg.a,
                    arg.a,
                    arg.b,
                    arg.a,
                    arg.b,
                    arg.a,
                    arg.b,
                    arg.b,
                ];
                for (const id of order) {
                    g.__phiMsHost.controller.setActive(id);
                    await new Promise((r) => setTimeout(r, 60));
                }
            },
            ids,
        );

        // Settle: pointer, rendered host, and headerless routing all
        // converge on B.
        await expect
            .poll(
                async () => {
                    const marker = await readPageMarker(app!);
                    return {
                        pointerOn: marker.activePointer !== null,
                        hostIsB: marker.hostname.includes(HOST_B.toUpperCase()),
                        routedIsB: marker.headerlessHostname.includes(
                            HOST_B.toUpperCase(),
                        ),
                    };
                },
                { timeout: 30_000, intervals: [1_000] },
            )
            .toEqual({ pointerOn: true, hostIsB: true, routedIsB: true });

        // And nothing of A survives anywhere in the page.
        const marker = await readPageMarker(app!);
        expect(marker.hostname).not.toContain(HOST_A.toUpperCase());
        expect(marker.headerlessHostname).not.toContain(HOST_A.toUpperCase());
        const text = await app!.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const views = g.__phiMsHost.profileViews;
            const active = views?.getActive();
            const view = active ? views?.getView(active) : null;
            if (!view) throw new Error('no view');
            return String(
                await view.webContents.executeJavaScript(
                    `document.body.textContent`,
                ),
            );
        });
        expect(text.toUpperCase()).not.toContain(HOST_A.toUpperCase());
    });
});
