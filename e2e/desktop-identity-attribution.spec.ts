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

// FUNDAMENTAL CONTRACT — one server is never another server.
//
// The rail, the taskbar and the window title attribute hostname, accent
// and CPU to a profile. That attribution follows the PAGE, never the
// click: a reading belongs to a profile only when the page it came from
// reports that profile (committed after the switch paint). Naming
// jupiter's load or hostname under venus's profile — or leaving venus
// blank while her page paints — is a defect, never a trade-off.
//
// R-e2e-window pins the single-entry switch window: while the page
// still shows A, nothing may be recorded under B. R-e2e-storm pins the
// convergence after rapid switching: the identity map is exactly
// {A: alpha, B: beta}, never crossed at any sampled moment. These are
// the real-Electron twins of the transport contracts in
// desktop/electron/test/desktop-lifecycle.test.ts (TBAR attribution).

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

const HOST_A = 'ident-alpha-a41c';
const HOST_B = 'ident-beta-b72d';
const HOST_A_LABEL = HOST_A.toUpperCase();
const HOST_B_LABEL = HOST_B.toUpperCase();
const AUTH_PASSWORD = 'identity-switch-password-42';
/** How long server B's compat probe is held open, in ms — the width of
 *  the single-entry switch window (page shows A, click says B). */
const PROBE_DELAY_MS = 2_000;

function electronBinary(): string {
    const pathTxt = join(electronDir, 'node_modules', 'electron', 'path.txt');
    if (!existsSync(pathTxt)) throw new Error('electron path.txt missing');
    const relative = readFileSync(pathTxt, 'utf-8').trim();
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

/** Holds server B's /api/version answer so the compat probe — and with
 *  it the switch window — has a measurable width. Every other request
 *  forwards immediately. */
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
                executeJavaScript: (code: string) => Promise<unknown>;
                reload?: () => void;
                session?: {
                    clearStorageData: (options: {
                        origin: string;
                        storages: string[];
                    }) => Promise<void>;
                    cookies: {
                        get: (filter: {
                            url: string;
                        }) => Promise<Array<{ name: string }>>;
                    };
                };
            };
        } | null;
        getActive: () => string | null;
    } | null;
    activateServerUrl: (url: string) => void;
    /** The attribution surfaces under test (never persisted). */
    observedIdentity: Map<
        string,
        { hostname: string; accent: string; themeColor?: string }
    >;
    observedCpu: Map<string, number>;
    observedActivity: Map<string, boolean>;
    embeddedTransport: {
        forgetCompatibility: (id: string) => void;
    } | null;
    observeProfileIdentity: (
        view: {
            webContents: {
                executeJavaScript: (code: string) => Promise<unknown>;
                isDestroyed?: () => boolean;
            };
        },
        origin: string,
    ) => Promise<{ hostname: string; accent: string } | null>;
    /** Production poll trigger; the test fires it deterministically
     *  inside the switch window instead of waiting for the 10s tick. */
    pollCpu: () => void;
}

/** One attribution sample: what the active page paints, what the page
 *  itself claims to be, and what the host has recorded per profile. */
interface AttributionSample {
    pageHost: string;
    embed: string | null;
    activeId: string | null;
    aHost: string | null;
    bHost: string | null;
    cpuKeys: string[];
    activityKeys: string[];
}

async function sampleAttribution(
    app: Awaited<ReturnType<typeof _electron.launch>>,
    aId: string,
    bId: string,
): Promise<AttributionSample> {
    return app.evaluate(
        async (electronApi: unknown, args: { a: string; b: string }) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const host = g.__phiMsHost;
            const active = host.profileViews?.getActive() ?? null;
            const view = active ? host.profileViews?.getView(active) : null;
            let pageHost = 'NO-VIEW';
            let embed: string | null = null;
            if (view) {
                const read = (await Promise.race([
                    view.webContents.executeJavaScript(`(async () => {
                        const el = document.getElementById('hostname-display');
                        let embed = null;
                        try { embed = window.__phiEmbed?.current?.() ?? null; } catch {}
                        return {
                            host: (el ? el.textContent || '' : '').trim().toUpperCase(),
                            embed,
                        };
                    })()`),
                    new Promise((resolve) =>
                        setTimeout(
                            () => resolve({ host: 'HUNG', embed: null }),
                            4_000,
                        ),
                    ),
                ])) as { host: string; embed: string | null };
                pageHost = read.host;
                embed = read.embed;
            }
            return {
                pageHost,
                embed,
                activeId: host.controller.state().activeId,
                aHost: host.observedIdentity.get(args.a)?.hostname ?? null,
                bHost: host.observedIdentity.get(args.b)?.hostname ?? null,
                cpuKeys: [...host.observedCpu.keys()],
                activityKeys: [...host.observedActivity.keys()],
            };
        },
        { a: aId, b: bId },
    );
}

async function lockV2Server(url: string, password: string): Promise<void> {
    const response = await fetch(`${url}/api/auth/v2/password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Phi-Auth': 'v2',
        },
        body: JSON.stringify({ password }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as { enabled?: boolean };
    expect(body.enabled).toBe(true);
}

async function desktopShellPage(
    app: Awaited<ReturnType<typeof _electron.launch>>,
) {
    const page = app
        .context()
        .pages()
        .find((candidate) =>
            candidate.url().includes('/desktop/electron/web/index.html'),
        );
    if (!page) throw new Error('desktop shell page did not appear');
    await expect(page.locator('#desktop-auth-modal')).toBeAttached();
    return page;
}

async function protectedConfigStatus(
    app: Awaited<ReturnType<typeof _electron.launch>>,
): Promise<number> {
    return app.evaluate(async (electronApi: unknown) => {
        const g = globalThis as unknown as { __phiMsHost: HostHandle };
        const active = g.__phiMsHost.profileViews?.getActive();
        const view = active
            ? g.__phiMsHost.profileViews?.getView(active)
            : null;
        if (!view) return 0;
        return (await view.webContents.executeJavaScript(
            `fetch('/api/config', { cache: 'no-store' }).then(r => r.status).catch(() => 0)`,
        )) as number;
    });
}

async function forgetCompatibility(
    app: Awaited<ReturnType<typeof _electron.launch>>,
    id: string,
): Promise<void> {
    await app.evaluate(async (electronApi: unknown, want: string) => {
        const g = globalThis as unknown as { __phiMsHost: HostHandle };
        g.__phiMsHost.embeddedTransport?.forgetCompatibility(want);
    }, id);
}

async function probeIdentityForActiveProfile(
    app: Awaited<ReturnType<typeof _electron.launch>>,
    id: string,
): Promise<{ hostname: string; accent: string } | null> {
    return app.evaluate(async (electronApi: unknown, want: string) => {
        const g = globalThis as unknown as { __phiMsHost: HostHandle };
        const host = g.__phiMsHost;
        const profile = host.controller
            .state()
            .profiles.find((p) => p.id === want);
        const view = host.profileViews?.getView(want);
        if (!profile || !view)
            throw new Error(`profile/view missing for ${want}`);
        return host.observeProfileIdentity(view, profile.origin);
    }, id);
}

async function profileIdFor(
    app: Awaited<ReturnType<typeof _electron.launch>>,
    origin: string,
): Promise<string> {
    const id = await app.evaluate(
        async (electronApi: unknown, want: string) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const st = g.__phiMsHost.controller.state();
            return (
                st.profiles.find((p) => p.origin.replace(/\/$/, '') === want)
                    ?.id ?? null
            );
        },
        new URL(origin).origin,
    );
    if (!id) throw new Error(`profile missing for ${origin}`);
    return id;
}

async function activateProfile(
    app: Awaited<ReturnType<typeof _electron.launch>>,
    id: string,
): Promise<void> {
    await app.evaluate(async (electronApi: unknown, want: string) => {
        const g = globalThis as unknown as { __phiMsHost: HostHandle };
        g.__phiMsHost.controller.setActive(want);
    }, id);
}

/** A read must never wedge the sampler: a navigating frame can hold
 *  executeJavaScript forever, so every page read races a deadline
 *  (built into sampleAttribution) and the settle polls use generous
 *  intervals — a tight cadence floods the Electron main-process
 *  roundtrip queue and starves the very call it waits for. */
test.describe('desktop identity attribution', () => {
    let phiA: PhiServer | null = null;
    let phiB: PhiServer | null = null;
    let proxy: http.Server | null = null;
    let app: Awaited<ReturnType<typeof _electron.launch>> | null = null;
    let root = '';
    let aId = '';
    let bId = '';

    test.beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'phi-identity-attr-'));
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
        const proxyOrigin = slow.origin;

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

        await app.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            g.__phiMsHost.activateServerUrl(process.env.PHI_MS_A_URL!);
            g.__phiMsHost.activateServerUrl(process.env.PHI_MS_B_URL!);
        });
        aId = await profileIdFor(app, phiA.url);
        bId = await profileIdFor(app, proxyOrigin);

        // Land on A and wait for its paint: page hostname, page-claimed
        // profile, and the host's identity record for A.
        await activateProfile(app, aId);
        await expect
            .poll(
                async () => {
                    const s = await sampleAttribution(app!, aId, bId);
                    return (
                        s.pageHost === HOST_A_LABEL &&
                        s.embed === aId &&
                        s.aHost === HOST_A_LABEL
                    );
                },
                { timeout: 60_000, intervals: [2_500] },
            )
            .toBe(true);
    });

    test.afterAll(async () => {
        await app?.close().catch(() => {});
        proxy?.close();
        await phiA?.stop();
        await phiB?.stop();
        if (root) rmSync(root, { recursive: true, force: true });
    });

    test('R-e2e-window: while the page still shows A, nothing is recorded under B', async () => {
        // Baseline: settled on A, identity known for A only.
        const base = await sampleAttribution(app!, aId, bId);
        expect(base.pageHost).toBe(HOST_A_LABEL);
        expect(base.embed).toBe(aId);
        expect(base.aHost).toBe(HOST_A_LABEL);
        expect(base.bHost).toBeNull();

        // Make B's compat probe cold: activation must walk the delaying
        // proxy, not consume the cached version and erase the window.
        await forgetCompatibility(app!, bId);
        await activateProfile(app!, bId);
        const windowDeadline = Date.now() + PROBE_DELAY_MS + 250;
        const samples: AttributionSample[] = [];
        let pageStillA = 0;
        while (Date.now() < windowDeadline && pageStillA < 4) {
            const s = await sampleAttribution(app!, aId, bId);
            samples.push(s);
            expect(s.activeId).toBe(bId);
            if (s.embed === bId) {
                expect(s.pageHost).toBe(HOST_B_LABEL);
                break;
            }
            expect(
                {
                    pageHost: s.pageHost,
                    embed: s.embed,
                    bHost: s.bHost,
                },
                `window sample crossed: ${JSON.stringify(s)}`,
            ).toEqual({ pageHost: HOST_A_LABEL, embed: aId, bHost: null });
            pageStillA++;

            // Exercise both production readers deterministically while
            // activeId is B but __phiEmbed still reports painted profile A.
            const identity = await probeIdentityForActiveProfile(app!, bId);
            expect(
                identity,
                'identity read for B must reject the page still painting A',
            ).toBeNull();
            await app!.evaluate(async (electronApi: unknown) => {
                const g = globalThis as unknown as { __phiMsHost: HostHandle };
                g.__phiMsHost.pollCpu();
            });
            await new Promise((r) => setTimeout(r, 150));
            const afterPoll = await sampleAttribution(app!, aId, bId);
            expect(afterPoll.embed).toBe(aId);
            expect(afterPoll.bHost).toBeNull();
            expect(afterPoll.cpuKeys).not.toContain(bId);
            expect(afterPoll.activityKeys).not.toContain(bId);
        }
        expect(pageStillA).toBeGreaterThan(0);
        expect(samples.length).toBeGreaterThan(0);

        // After the window, B paints and IS recorded — once, correctly.
        await expect
            .poll(
                async () => {
                    const s = await sampleAttribution(app!, aId, bId);
                    return (
                        s.pageHost === HOST_B_LABEL &&
                        s.embed === bId &&
                        s.bHost === HOST_B_LABEL
                    );
                },
                { timeout: 60_000, intervals: [2_500] },
            )
            .toBe(true);
        // The switch to B never rewrote A's record.
        const settled = await sampleAttribution(app!, aId, bId);
        expect(settled.aHost).toBe(HOST_A_LABEL);
    });

    test('R-e2e-auth: one successful unlock survives server switches without another prompt', async () => {
        await activateProfile(app!, aId);
        await expect
            .poll(
                async () => {
                    const s = await sampleAttribution(app!, aId, bId);
                    return s.pageHost === HOST_A_LABEL && s.embed === aId;
                },
                { timeout: 30_000, intervals: [1_000] },
            )
            .toBe(true);
        const shell = await desktopShellPage(app!);
        const modal = shell.locator('#desktop-auth-modal');
        await shell.evaluate(() => {
            const w = window as unknown as {
                phiAuthPromptCount: number;
                phiAuthPromptObserver: MutationObserver;
            };
            const target = document.getElementById('desktop-auth-modal');
            if (!target) throw new Error('auth modal missing');
            w.phiAuthPromptCount = 0;
            w.phiAuthPromptObserver = new MutationObserver(() => {
                if (!target.hidden) w.phiAuthPromptCount++;
            });
            w.phiAuthPromptObserver.observe(target, {
                attributes: true,
                attributeFilter: ['hidden'],
            });
        });

        // Lock the already-loaded A server, then reload its single view to
        // force a real 401 through the host-owned auth path.
        await lockV2Server(phiA!.url, AUTH_PASSWORD);
        await app!.evaluate(async (electronApi: unknown, id: string) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            const view = g.__phiMsHost.profileViews?.getView(id);
            if (!view?.webContents.reload)
                throw new Error('view cannot reload');
            view.webContents.reload();
        }, aId);
        await expect(modal).toBeVisible({ timeout: 30_000 });
        await shell.locator('#desktop-auth-input').fill(AUTH_PASSWORD);
        await shell.locator('#desktop-auth-submit').click();
        await expect(modal).toBeHidden({ timeout: 30_000 });
        await expect
            .poll(() => protectedConfigStatus(app!), { timeout: 30_000 })
            .toBe(200);
        const promptCount = () =>
            shell.evaluate(
                () =>
                    (window as unknown as { phiAuthPromptCount: number })
                        .phiAuthPromptCount,
            );
        await expect.poll(promptCount).toBe(1);

        // Remove A's session cookies before switching. The return to A
        // must re-authenticate from the desktop's saved credential, not
        // accidentally pass because a BrowserView cookie survived.
        const remainingAuthCookies = await app!.evaluate(
            async (
                electronApi: unknown,
                args: { id: string; origin: string },
            ) => {
                const g = globalThis as unknown as { __phiMsHost: HostHandle };
                const view = g.__phiMsHost.profileViews?.getView(args.id);
                const session = view?.webContents.session;
                if (!session)
                    throw new Error('embedded session is unavailable');
                await session.clearStorageData({
                    origin: args.origin,
                    storages: ['cookies'],
                });
                const cookies = await session.cookies.get({ url: args.origin });
                return cookies.filter(
                    (cookie) => cookie.name === 'phi_access_session',
                ).length;
            },
            { id: aId, origin: new URL(phiA!.url).origin },
        );
        expect(remainingAuthCookies).toBe(0);

        // B is unauthenticated. Switch away and back to A: the credential
        // proved once must be reused silently, not prompt again or surface
        // an aborted scope's internal "Owner changed" reason.
        await activateProfile(app!, bId);
        await expect
            .poll(
                async () => {
                    const s = await sampleAttribution(app!, aId, bId);
                    return s.pageHost === HOST_B_LABEL && s.embed === bId;
                },
                { timeout: 30_000, intervals: [1_000] },
            )
            .toBe(true);
        await expect
            .poll(() => protectedConfigStatus(app!), { timeout: 15_000 })
            .toBe(200);
        await expect(modal).toBeHidden();
        await expect.poll(promptCount).toBe(1);

        await activateProfile(app!, aId);
        await expect
            .poll(
                async () => {
                    const s = await sampleAttribution(app!, aId, bId);
                    return s.pageHost === HOST_A_LABEL && s.embed === aId;
                },
                { timeout: 30_000, intervals: [1_000] },
            )
            .toBe(true);
        await expect
            .poll(() => protectedConfigStatus(app!), { timeout: 15_000 })
            .toBe(200);
        await expect(modal).toBeHidden();
        await expect.poll(promptCount).toBe(1);
        await shell.evaluate(() => {
            const w = window as unknown as {
                phiAuthPromptObserver: MutationObserver;
            };
            w.phiAuthPromptObserver.disconnect();
        });
    });

    test('R-e2e-storm: rapid A/B clicks never cross attribution, and the map ends exact', async () => {
        // Storm of clicks without settle waits; the last one wins.
        const order = [aId, bId, aId, bId, aId];
        for (const id of order) {
            await activateProfile(app!, id);
            await new Promise((r) => setTimeout(r, 60));
        }

        // Sample through the churn and the final convergence window.
        const samples: AttributionSample[] = [];
        const deadline = Date.now() + 20_000;
        let converged = false;
        while (Date.now() < deadline) {
            const s = await sampleAttribution(app!, aId, bId);
            samples.push(s);
            // No sampled moment ever shows crossed attribution. Each
            // record is either absent or its OWN hostname.
            expect(
                s.aHost === null || s.aHost === HOST_A_LABEL,
                `A's record crossed to ${s.aHost}`,
            ).toBe(true);
            expect(
                s.bHost === null || s.bHost === HOST_B_LABEL,
                `B's record crossed to ${s.bHost}`,
            ).toBe(true);
            // No phantom profiles in the observation maps.
            for (const key of [...s.cpuKeys, ...s.activityKeys])
                expect([aId, bId]).toContain(key);
            if (
                s.pageHost === HOST_A_LABEL &&
                s.embed === aId &&
                s.activeId === aId &&
                s.aHost === HOST_A_LABEL &&
                s.bHost === HOST_B_LABEL
            ) {
                converged = true;
                break;
            }
        }
        expect(
            converged,
            `storm never converged; last=${JSON.stringify(samples.at(-1))}`,
        ).toBe(true);

        // The identity map is EXACTLY the two servers, never crossed.
        const final = await app!.evaluate(async (electronApi: unknown) => {
            const g = globalThis as unknown as { __phiMsHost: HostHandle };
            return [...g.__phiMsHost.observedIdentity.entries()].map(
                ([id, v]) => ({ id, hostname: v.hostname }),
            );
        });
        expect(final).toHaveLength(2);
        const byId = new Map(final.map((e) => [e.id, e.hostname]));
        expect(byId.get(aId)).toBe(HOST_A_LABEL);
        expect(byId.get(bId)).toBe(HOST_B_LABEL);
    });
});
