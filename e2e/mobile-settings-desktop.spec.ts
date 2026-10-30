import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { _electron } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, 'fixtures', 'mobile-settings-app');

function electronBinary(): string {
    const pkgRoot = join(here, '..', 'desktop', 'electron');
    const pathTxt = join(pkgRoot, 'node_modules', 'electron', 'path.txt');
    if (!existsSync(pathTxt)) throw new Error('electron path.txt missing');
    const rel = readFileSync(pathTxt, 'utf8').trim();
    const full = join(pkgRoot, 'node_modules', 'electron', 'dist', rel);
    if (!existsSync(full)) throw new Error(`electron binary missing: ${full}`);
    return full;
}

async function waitFor(
    fn: () => Promise<boolean>,
    timeoutMs = 30_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await fn()) return;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((r) => setTimeout(r, 250));
    }
}

async function authStatus(url: string) {
    const res = await fetch(`${url}/api/auth/status`, { cache: 'no-store' });
    if (!res.ok) return { enabled: null, status: res.status };
    const body = (await res.json()) as { enabled?: boolean };
    return { enabled: body.enabled ?? null, status: res.status };
}

async function mobileState(url: string) {
    const res = await fetch(`${url}/api/config/mobile-appearance`, {
        cache: 'no-store',
    });
    if (!res.ok) {
        const auth = await authStatus(url);
        throw new Error(
            `GET mobile-appearance ${res.status} (auth enabled=${auth.enabled} status=${auth.status})`,
        );
    }
    return (await res.json()) as {
        revision: number;
        ui_font_size: number | null;
        terminal_font_size: number | null;
        ui_font_family: string | null;
        terminal_font_family: string | null;
    };
}

async function setupBackend(dir: string, label: string) {
    const { mkdirSync, realpathSync, writeFileSync } = await import('node:fs');
    const folder = join(dir, 'workspace');
    mkdirSync(folder, { recursive: true });
    const workspace = realpathSync(folder);
    const state = join(dir, 'home', '.phi');
    const backends = join(state, 'backends');
    mkdirSync(backends, { recursive: true });
    const command = join(dir, 'fixture-bash');
    writeFileSync(
        command,
        '#!/bin/sh\nprintf "fixture ready\\r\\n"\nexec cat\n',
        {
            mode: 0o755,
        },
    );
    writeFileSync(
        join(backends, 'bash.json'),
        JSON.stringify({ id: 'bash', command }),
    );
    writeFileSync(
        join(state, 'tabs.json'),
        JSON.stringify([
            {
                id: 't1',
                coder: 'bash',
                session_id: '',
                cwd: workspace,
                workspace,
                title: label,
            },
        ]),
    );
}

test.describe('native ownership', () => {
    for (const lowMemory of ['0', '1']) {
        test(`two backends stay owned across switch, reload and removal (lowMemory=${lowMemory})`, async () => {
            test.setTimeout(120_000);
            let phiA: PhiServer | null = null;
            let phiB: PhiServer | null = null;
            let electronApp: Awaited<
                ReturnType<typeof _electron.launch>
            > | null = null;
            const fixtureDir = mkdtempSync(join(tmpdir(), 'phi-ms-native-'));
            try {
                phiA = await startPhi({
                    config: { hostname_override: 'backend A' },
                    env: {
                        PHI_SHUTDOWN_PTY_GRACE: '150ms',
                        PHI_SHUTDOWN_GRACE: '1s',
                    },
                    setup: (dir) => setupBackend(dir, 'Backend A'),
                });
                phiB = await startPhi({
                    config: { hostname_override: 'backend B' },
                    env: {
                        PHI_SHUTDOWN_PTY_GRACE: '150ms',
                        PHI_SHUTDOWN_GRACE: '1s',
                    },
                    setup: (dir) => setupBackend(dir, 'Backend B'),
                });

                const exe = electronBinary();
                electronApp = await _electron.launch({
                    executablePath: exe,
                    args: [appDir],
                    timeout: 60_000,
                    env: {
                        PATH: process.env.PATH || '',
                        HOME: join(fixtureDir, 'home'),
                        USERPROFILE: join(fixtureDir, 'home'),
                        APPDATA: join(fixtureDir, 'home'),
                        TMPDIR: join(fixtureDir, 'temp'),
                        TMP: join(fixtureDir, 'temp'),
                        TEMP: join(fixtureDir, 'temp'),
                        PHI_MS_FIXTURE_DIR: fixtureDir,
                        PHI_MS_A_URL: phiA.url,
                        PHI_MS_B_URL: phiB.url,
                        PHI_DESKTOP_LOW_MEMORY: lowMemory,
                        ELECTRON_DISABLE_SANDBOX: '1',
                    } as Record<string, string>,
                });

                // Wait for fixture readiness in the main process.
                await waitFor(async () => {
                    const ready = await electronApp!.evaluate(async () => {
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
                    });
                    return ready;
                }, 60_000);

                // Assert owned paths, no tray/shortcut/pet/hook side effects.
                const boot = await electronApp.evaluate(
                    async (electronApi: any) => {
                        const { app } = electronApi as {
                            app: { getPath: (name: string) => string };
                        };
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                controller: {
                                    state: () => {
                                        profiles: Array<{
                                            id: string;
                                            origin: string;
                                        }>;
                                        activeId: string;
                                    };
                                    getPetEnabled: () => boolean;
                                } | null;
                                petHandle: unknown;
                                profileViews: {
                                    viewsCreated: () => number;
                                } | null;
                            };
                            __phiMsRecording: {
                                tray: Record<string, number>;
                                shortcut: {
                                    register: string[];
                                    unregister: string[];
                                };
                            };
                        };
                        return {
                            homedir: app.getPath('home'),
                            userData: app.getPath('userData'),
                            sessionData: app.getPath('sessionData'),
                            petEnabled:
                                g.__phiMsHost.controller?.getPetEnabled?.() ??
                                null,
                            petHandle: g.__phiMsHost.petHandle !== null,
                            tray: g.__phiMsRecording.tray,
                            shortcuts: g.__phiMsRecording.shortcut,
                        };
                    },
                );
                expect(boot.homedir.startsWith(fixtureDir)).toBe(true);
                expect(boot.userData.startsWith(fixtureDir)).toBe(true);
                expect(boot.sessionData.startsWith(fixtureDir)).toBe(true);
                expect(boot.petEnabled).toBe(false);
                expect(boot.petHandle).toBe(false);
                // Tray/shortcut recording asserts: the fixture replaces the
                // surfaces, so the counts reflect recording calls, not OS
                // objects. No real Tray or globalShortcut exists.
                expect(boot.shortcuts.register).toEqual([
                    'CommandOrControl+Shift+L',
                ]);

                // Add both backends via the real activation path.
                const ids = await electronApp.evaluate(
                    async (
                        _electronApi: unknown,
                        arg: { a: string; b: string },
                    ) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                activateServerUrl: (url: string) => void;
                                controller: {
                                    state: () => {
                                        profiles: Array<{
                                            id: string;
                                            origin: string;
                                        }>;
                                        activeId: string;
                                    };
                                    setActive: (id: string) => void;
                                };
                                profileViews: {
                                    getActive: () => string | null;
                                } | null;
                            };
                        };
                        g.__phiMsHost.activateServerUrl(arg.a);
                        g.__phiMsHost.activateServerUrl(arg.b);
                        const st = g.__phiMsHost.controller.state();
                        const a =
                            st.profiles.find(
                                (p) =>
                                    p.origin === new URL(arg.a).origin ||
                                    p.origin === arg.a + '/',
                            ) || st.profiles[0];
                        const b =
                            st.profiles.find((p) => p.id !== a.id) ||
                            st.profiles[1];
                        g.__phiMsHost.controller.setActive(a.id);
                        return {
                            aId: a.id,
                            bId: b.id,
                            aOrigin: a.origin,
                            bOrigin: b.origin,
                        };
                    },
                    { a: phiA.url, b: phiB.url },
                );
                expect(ids.aId).not.toBe(ids.bId);

                // Wait for the active view to exist and finish loading its
                // desktop page (drawer or Config pill present).
                await waitFor(async () => {
                    return electronApp!.evaluate(
                        async (_electronApi: unknown, aId: string) => {
                            const g = globalThis as unknown as {
                                __phiMsHost: {
                                    profileViews: {
                                        getView: (id: string) => {
                                            webContents: {
                                                executeJavaScript: (
                                                    code: string,
                                                ) => Promise<unknown>;
                                                getURL: () => string;
                                            };
                                        } | null;
                                    };
                                };
                            };
                            const view =
                                g.__phiMsHost.profileViews?.getView(aId);
                            if (!view) return false;
                            const url = view.webContents.getURL();
                            if (!url.includes('desktop=1')) return false;
                            try {
                                return (await view.webContents.executeJavaScript(
                                    `!!(document.getElementById('drawer-settings-btn') || document.querySelector('#header-config-pill .pill-label'))`,
                                )) as boolean;
                            } catch {
                                return false;
                            }
                        },
                        ids.aId,
                    );
                }, 30_000);

                // Collect popup windows before triggering them. firstWindow
                // is the main shell; popups arrive as new windows.
                const windows: Page[] = [];
                electronApp.on('window', (page) => {
                    windows.push(page);
                });

                // Open A's native Settings via its retained view. The view
                // is a WebContentsView (not a Playwright window), so drive
                // it through main-process executeJavaScript.
                const popupOpened = await electronApp.evaluate(
                    async (_electronApi: unknown, arg: { id: string }) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                profileViews: {
                                    getView: (id: string) => {
                                        webContents: {
                                            executeJavaScript: (
                                                code: string,
                                            ) => Promise<unknown>;
                                            getURL: () => string;
                                        };
                                    } | null;
                                };
                            };
                        };
                        const view = g.__phiMsHost.profileViews.getView(arg.id);
                        if (!view) return { ok: false, url: '' };
                        const url = view.webContents.getURL();
                        // Click the drawer Settings entry when present; fall
                        // back to the header Config pill. Both call
                        // openSettingsModal -> tryNative('config') in desktop.
                        const clicked =
                            await view.webContents.executeJavaScript(
                                `(() => {
                            const drawer = document.getElementById('drawer-settings-btn');
                            if (drawer) { drawer.click(); return 'drawer'; }
                            const pill = document.querySelector('#header-config-pill .pill-label');
                            if (pill) { pill.click(); return 'pill'; }
                            return '';
                        })()`,
                            );
                        return { ok: clicked !== '', how: clicked, url };
                    },
                    { id: ids.aId },
                );
                expect(popupOpened.ok).toBe(true);

                // firstWindow is the main shell; popups arrive after.
                const main = await electronApp.firstWindow({ timeout: 30_000 });
                expect(main).toBeTruthy();
                await waitFor(async () => windows.length >= 1, 30_000);
                // Find A's popup by URL (config.html). Main window URL is
                // a local file; popups are http(s) or phi-app config.html.
                let popupA: Page | null = null;
                for (let i = 0; i < 40 && !popupA; i++) {
                    for (const w of windows) {
                        try {
                            const url = w.url();
                            if (url.includes('/config.html')) {
                                popupA = w;
                                break;
                            }
                        } catch {}
                    }
                    if (!popupA) await new Promise((r) => setTimeout(r, 500));
                }
                expect(popupA).not.toBeNull();
                const pageA = popupA!;
                await expect(
                    pageA.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });

                // Native desktop forces desktop rendering, even with a
                // stored mobile override. The profile selector is disabled.
                const nativeProfile = await pageA.evaluate(() => {
                    return {
                        profile:
                            document.documentElement.dataset
                                .appearanceProfile || '',
                        selector:
                            (
                                document.getElementById(
                                    'settings-appearance-profile',
                                ) as HTMLSelectElement | null
                            )?.disabled ?? null,
                        bodySize: getComputedStyle(document.body).fontSize,
                    };
                });
                expect(nativeProfile.profile).toBe('desktop');
                expect(nativeProfile.selector).toBe(true);

                // Switch to Mobile Settings view inside the popup, set
                // mobile UI size to 21, and wait for save.
                await pageA.locator('#settings-mobile-view').click();
                await expect(
                    pageA.locator('#settings-mobile-appearance'),
                ).toBeVisible();
                await pageA.locator('#settings-mobile-ui-font-size').fill('21');
                await expect(
                    pageA.locator('#settings-mobile-status'),
                ).toHaveText('Saved', { timeout: 30_000 });
                await expect
                    .poll(
                        async () => (await mobileState(phiA!.url)).ui_font_size,
                        { timeout: 15_000 },
                    )
                    .toBe(21);
                expect((await mobileState(phiB.url)).ui_font_size).toBeNull();

                // Switch the shell to B while A's popup remains open. Save
                // in A's window and assert only A changes.
                await electronApp.evaluate(
                    async (_electronApi: unknown, bId: string) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                controller: { setActive: (id: string) => void };
                            };
                        };
                        g.__phiMsHost.controller.setActive(bId);
                    },
                    ids.bId,
                );
                // A's popup must still be alive and still target A.
                await pageA.locator('#settings-mobile-ui-font-size').fill('22');
                await expect(
                    pageA.locator('#settings-mobile-status'),
                ).toHaveText('Saved', { timeout: 30_000 });
                await expect
                    .poll(
                        async () => (await mobileState(phiA!.url)).ui_font_size,
                        { timeout: 15_000 },
                    )
                    .toBe(22);
                expect((await mobileState(phiB.url)).ui_font_size).toBeNull();

                // Open B's Settings and assert it is a separate owner/window.
                await waitFor(async () => {
                    return electronApp!.evaluate(
                        async (_electronApi: unknown, bId: string) => {
                            const g = globalThis as unknown as {
                                __phiMsHost: {
                                    profileViews: {
                                        getView: (id: string) => {
                                            webContents: {
                                                executeJavaScript: (
                                                    code: string,
                                                ) => Promise<unknown>;
                                                getURL: () => string;
                                            };
                                        } | null;
                                    };
                                };
                            };
                            const view =
                                g.__phiMsHost.profileViews?.getView(bId);
                            if (!view) return false;
                            if (
                                !view.webContents.getURL().includes('desktop=1')
                            )
                                return false;
                            try {
                                return (await view.webContents.executeJavaScript(
                                    `!!(document.getElementById('drawer-settings-btn') || document.querySelector('#header-config-pill .pill-label'))`,
                                )) as boolean;
                            } catch {
                                return false;
                            }
                        },
                        ids.bId,
                    );
                }, 30_000);
                await electronApp.evaluate(
                    async (_electronApi: unknown, arg: { id: string }) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                profileViews: {
                                    getView: (id: string) => {
                                        webContents: {
                                            executeJavaScript: (
                                                code: string,
                                            ) => Promise<unknown>;
                                        };
                                    } | null;
                                };
                            };
                        };
                        const view = g.__phiMsHost.profileViews.getView(arg.id);
                        if (!view) return false;
                        await view.webContents.executeJavaScript(
                            `(() => {
                            const drawer = document.getElementById('drawer-settings-btn');
                            if (drawer) { drawer.click(); return true; }
                            const pill = document.querySelector('#header-config-pill .pill-label');
                            if (pill) { pill.click(); return true; }
                            return false;
                        })()`,
                        );
                        return true;
                    },
                    { id: ids.bId },
                );
                await waitFor(async () => {
                    let count = 0;
                    for (const w of windows) {
                        try {
                            if (w.url().includes('/config.html')) count++;
                        } catch {}
                    }
                    return count >= 2;
                }, 30_000);
                // Identify B's popup as the config window that is not pageA.
                let popupB: Page | null = null;
                for (const w of windows) {
                    if (w === pageA) continue;
                    try {
                        if (w.url().includes('/config.html')) {
                            popupB = w;
                            break;
                        }
                    } catch {}
                }
                expect(popupB).not.toBeNull();
                const pageB = popupB!;
                await expect(
                    pageB.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                // Distinct window objects and distinct owner URLs.
                expect(pageB).not.toBe(pageA);
                expect(pageB.url()).not.toBe(pageA.url());

                // Reload both popouts and repeat the read/write ownership check.
                await pageA.reload();
                await pageB.reload();
                await expect(
                    pageA.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                await expect(
                    pageB.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                await pageA.locator('#settings-mobile-view').click();
                await pageB.locator('#settings-mobile-view').click();
                await expect(
                    pageA.locator('#settings-mobile-appearance'),
                ).toBeVisible();
                await expect(
                    pageB.locator('#settings-mobile-appearance'),
                ).toBeVisible();
                // A still reads 22; B still reads null (default).
                await expect(
                    pageA.locator('#settings-mobile-ui-font-size'),
                ).toHaveValue('22', { timeout: 15_000 });
                await expect(
                    pageB.locator('#settings-mobile-ui-font-size'),
                ).toHaveValue('17', { timeout: 15_000 });
                // Write in B, assert only B changes.
                await pageB.locator('#settings-mobile-ui-font-size').fill('20');
                await expect(
                    pageB.locator('#settings-mobile-status'),
                ).toHaveText('Saved', { timeout: 30_000 });
                await expect
                    .poll(
                        async () => (await mobileState(phiB!.url)).ui_font_size,
                        { timeout: 15_000 },
                    )
                    .toBe(20);
                expect((await mobileState(phiA.url)).ui_font_size).toBe(22);

                // Delayed-save ownership: hold A's save response, switch to
                // B, then release. B must stay unchanged; A retains its
                // attempt/draft until the reply lands.
                await electronApp.evaluate(
                    async (_api: unknown, id: string) => {
                        (globalThis as any).__phiMsHost.controller.setActive(
                            id,
                        );
                    },
                    ids.aId,
                );
                let heldSave = false;
                let releaseA: (() => void) | null = null;
                const gate = new Promise<void>((resolve) => {
                    releaseA = resolve;
                });
                await pageA.route(
                    '**/api/config/mobile-appearance',
                    async (route) => {
                        if (route.request().method() === 'POST') {
                            heldSave = true;
                            await gate;
                        }
                        await route.continue();
                    },
                );
                // phi-app requests are proxied in the main process, outside
                // Playwright routing. Hold that transport's real fetch too.
                await electronApp.evaluate((_api: unknown, origin: string) => {
                    const g = globalThis as any;
                    const transport = g.__phiMsHost.embeddedTransport;
                    const original = transport.fetchImpl;
                    let release!: () => void;
                    const gate = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    g.__phiMsHeldSave = false;
                    transport.fetchImpl = async (
                        url: string,
                        init: RequestInit,
                    ) => {
                        if (
                            url === origin + '/api/config/mobile-appearance' &&
                            init?.method === 'POST'
                        ) {
                            g.__phiMsHeldSave = true;
                            await gate;
                        }
                        return original(url, init);
                    };
                    g.__phiMsReleaseSave = () => {
                        release();
                        transport.fetchImpl = original;
                    };
                }, phiA.url);
                await pageA.locator('#settings-mobile-ui-font-size').fill('24');
                // Require a dispatched POST, not merely the debounce's Pending state.
                await expect
                    .poll(
                        async () =>
                            heldSave ||
                            (await electronApp!.evaluate(
                                () =>
                                    (globalThis as any).__phiMsHeldSave ===
                                    true,
                            )),
                        { timeout: 15_000 },
                    )
                    .toBe(true);
                // Switch shell to B while A's save is in flight.
                await electronApp.evaluate(
                    async (_electronApi: unknown, bId: string) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                controller: { setActive: (id: string) => void };
                            };
                        };
                        g.__phiMsHost.controller.setActive(bId);
                    },
                    ids.bId,
                );
                // B stays unchanged during A's held save.
                expect((await mobileState(phiB.url)).ui_font_size).toBe(20);
                await expect(
                    pageB.locator('#settings-mobile-ui-font-size'),
                ).toHaveValue('20');
                // Release A's response; only A changes.
                releaseA!();
                await electronApp.evaluate(() =>
                    (globalThis as any).__phiMsReleaseSave(),
                );
                await expect(
                    pageA.locator('#settings-mobile-status'),
                ).toHaveText('Saved', { timeout: 30_000 });
                await expect
                    .poll(
                        async () => (await mobileState(phiA!.url)).ui_font_size,
                        { timeout: 15_000 },
                    )
                    .toBe(24);
                expect((await mobileState(phiB.url)).ui_font_size).toBe(20);
                await pageA.unroute('**/api/config/mobile-appearance');

                // Auth-enabled fixture: enable a password on A only via its
                // Settings UI (owner-bound context). A's popup stays
                // authenticated via its saved verifier; B (no password)
                // loads without auth. Requests remain owner-bound across
                // the switch (verified by distinct reads).
                await pageA.locator('#settings-desktop-view').click();
                await pageA
                    .locator('#settings-access-new')
                    .fill('phi-ms-native-a-pw');
                await pageA
                    .locator('#settings-access-confirm')
                    .fill('phi-ms-native-a-pw');
                await pageA.locator('.settings-access-primary').click();
                // Wait for the password save to complete (button re-enabled
                // and state shows Enabled).
                await expect(
                    pageA.locator('.settings-access-state-text'),
                ).toHaveText('Enabled', { timeout: 60_000 });
                // Verify only A requires auth (B still open).
                const aAuth = await authStatus(phiA.url);
                const bAuth = await authStatus(phiB.url);
                expect(aAuth.enabled).toBe(true);
                expect(bAuth.enabled).toBe(false);
                await pageA.reload();
                await pageB.reload();
                await expect(
                    pageA.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                await expect(
                    pageB.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                // A auto-logins from its saved verifier (no unlock dialog)
                // and still reads 24; B reads 20 without auth.
                await expect(pageA.locator('.access-auth-overlay')).toHaveCount(
                    0,
                    { timeout: 15_000 },
                );
                await pageA.locator('#settings-mobile-view').click();
                await pageB.locator('#settings-mobile-view').click();
                await expect(
                    pageA.locator('#settings-mobile-ui-font-size'),
                ).toHaveValue('24', { timeout: 15_000 });
                await expect(
                    pageB.locator('#settings-mobile-ui-font-size'),
                ).toHaveValue('20', { timeout: 15_000 });

                // Fullscreen in-page fallback: with the main window
                // fullscreen, native config popups are denied and Settings
                // falls back in-page. Toggle via the real window, attempt
                // an open from B's view, then restore.
                await electronApp.evaluate(async ({ app }) => {
                    app.focus({ steal: true });
                    const g = globalThis as unknown as {
                        __phiMsHost: {
                            window: () => {
                                show: () => void;
                                focus: () => void;
                                setFullScreen: (b: boolean) => void;
                                isFullScreen: () => boolean;
                                once: (
                                    event: string,
                                    listener: () => void,
                                ) => void;
                            } | null;
                        };
                    };
                    const win = g.__phiMsHost.window();
                    if (!win) throw new Error('main window is missing');
                    win.show();
                    win.focus();
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        `native fullscreen transition timed out (state=${win.isFullScreen()})`,
                                    ),
                                ),
                            15_000,
                        );
                        win.once('enter-full-screen', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                        win.setFullScreen(true);
                    });
                });
                await expect
                    .poll(
                        () =>
                            electronApp!.evaluate(async () => {
                                const g = globalThis as unknown as {
                                    __phiMsHost: {
                                        window: () => {
                                            isFullScreen: () => boolean;
                                        } | null;
                                    };
                                };
                                return (
                                    g.__phiMsHost.window()?.isFullScreen() ??
                                    false
                                );
                            }),
                        {
                            message: 'native window entered fullscreen',
                            timeout: 15_000,
                        },
                    )
                    .toBe(true);
                await waitFor(async () =>
                    electronApp!.evaluate(
                        async (_electronApi: unknown, id: string) => {
                            const host = (globalThis as any).__phiMsHost;
                            const view = host.profileViews.getView(id);
                            return view.webContents.executeJavaScript(
                                `document.documentElement.dataset.phiDesktopFullscreen === 'true'`,
                            );
                        },
                        ids.bId,
                    ),
                );
                {
                    const winsBefore = windows.length;
                    const clicked = await electronApp.evaluate(
                        async (_electronApi: unknown, id: string) => {
                            const g = globalThis as unknown as {
                                __phiMsHost: {
                                    profileViews: {
                                        getView: (x: string) => {
                                            webContents: {
                                                executeJavaScript: (
                                                    c: string,
                                                ) => Promise<unknown>;
                                                getURL: () => string;
                                            };
                                        } | null;
                                    };
                                };
                            };
                            const view = g.__phiMsHost.profileViews.getView(id);
                            if (!view) return { ok: false, url: '' };
                            const url = view.webContents.getURL();
                            const ok = await view.webContents.executeJavaScript(
                                `(() => {
                                const drawer = document.getElementById('drawer-settings-btn');
                                if (drawer) { drawer.click(); return 'drawer'; }
                                const pill = document.querySelector('#header-config-pill .pill-label');
                                if (pill) { pill.click(); return 'pill'; }
                                return '';
                            })()`,
                            );
                            return { ok, url };
                        },
                        ids.bId,
                    );
                    expect(clicked.ok).not.toBe('');
                    // No new popup window; the view shows an in-page modal.
                    await new Promise((r) => setTimeout(r, 2000));
                    expect(windows.length).toBe(winsBefore);
                    let inPage = false;
                    for (let i = 0; i < 10 && !inPage; i++) {
                        inPage = (await electronApp.evaluate(
                            async (_electronApi: unknown, id: string) => {
                                const g = globalThis as unknown as {
                                    __phiMsHost: {
                                        profileViews: {
                                            getView: (x: string) => {
                                                webContents: {
                                                    executeJavaScript: (
                                                        c: string,
                                                    ) => Promise<unknown>;
                                                };
                                            } | null;
                                        };
                                    };
                                };
                                const view =
                                    g.__phiMsHost.profileViews.getView(id);
                                if (!view) return false;
                                return view.webContents.executeJavaScript(
                                    `!!document.querySelector('.settings-overlay')`,
                                );
                            },
                            ids.bId,
                        )) as boolean;
                        if (!inPage)
                            await new Promise((r) => setTimeout(r, 500));
                    }
                    expect(
                        inPage,
                        'fullscreen Settings uses the in-page modal',
                    ).toBe(true);
                    {
                        // Close the in-page modal via its Close button.
                        await electronApp.evaluate(
                            async (_electronApi: unknown, id: string) => {
                                const g = globalThis as unknown as {
                                    __phiMsHost: {
                                        profileViews: {
                                            getView: (x: string) => {
                                                webContents: {
                                                    executeJavaScript: (
                                                        c: string,
                                                    ) => Promise<unknown>;
                                                };
                                            } | null;
                                        };
                                    };
                                };
                                const view =
                                    g.__phiMsHost.profileViews.getView(id);
                                await view?.webContents.executeJavaScript(
                                    `document.querySelector('.settings-overlay .modal-close-btn')?.click()`,
                                );
                            },
                            ids.bId,
                        );
                    }
                }
                await electronApp.evaluate(async () => {
                    const g = globalThis as unknown as {
                        __phiMsHost: {
                            window: () => {
                                setFullScreen: (b: boolean) => void;
                            } | null;
                        };
                    };
                    g.__phiMsHost.window()?.setFullScreen(false);
                });

                // Removal: retain an unsent draft and an unconfirmed attempt
                // for A, then remove A through the real shell action. Drive
                // IndexedDB directly in A's popup: one never-dispatched
                // draft plus one occupied attempt slot on a separate draft.
                const retained = await pageA.evaluate(async () => {
                    const open = () =>
                        new Promise<IDBDatabase>((resolve, reject) => {
                            const req = indexedDB.open(
                                'phi-mobile-appearance-v1',
                                1,
                            );
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => reject(req.error);
                        });
                    const db = await open();
                    const tx = db.transaction(
                        ['owners', 'drafts'],
                        'readwrite',
                    );
                    const owners = tx.objectStore('owners');
                    const drafts = tx.objectStore('drafts');
                    const ownerRows = await new Promise<
                        Array<{
                            owner: string;
                            confirmed: unknown;
                            counter: number;
                            attempt: unknown;
                        }>
                    >((resolve, reject) => {
                        const r = owners.getAll();
                        r.onsuccess = () =>
                            resolve(
                                r.result as Array<{
                                    owner: string;
                                    confirmed: unknown;
                                    counter: number;
                                    attempt: unknown;
                                }>,
                            );
                        r.onerror = () => reject(r.error);
                    });
                    const owner = ownerRows[0]?.owner || '';
                    if (!owner) {
                        db.close();
                        return { owner: '', draftId: 0, attemptId: 0 };
                    }
                    const draftId = await new Promise<number>(
                        (resolve, reject) => {
                            const req = drafts.add({
                                owner,
                                fields: { ui_font_size: 23 },
                                versions: { ui_font_size: 9999 },
                                base: 99,
                                seq: 9999,
                                explicit: true,
                            });
                            req.onsuccess = () => resolve(Number(req.result));
                            req.onerror = () => reject(req.error);
                        },
                    );
                    // Unconfirmed attempt on a second draft (occupied slot).
                    const attemptDraftId = await new Promise<number>(
                        (resolve, reject) => {
                            const req = drafts.add({
                                owner,
                                fields: { terminal_font_size: 19 },
                                versions: { terminal_font_size: 9998 },
                                base: 99,
                                seq: 9998,
                                explicit: true,
                            });
                            req.onsuccess = () => resolve(Number(req.result));
                            req.onerror = () => reject(req.error);
                        },
                    );
                    const rec = ownerRows[0];
                    const attemptId = (rec.counter || 0) + 1;
                    await new Promise<void>((resolve, reject) => {
                        const put = owners.put({
                            owner,
                            confirmed: rec.confirmed,
                            counter: attemptId,
                            attempt: {
                                id: attemptId,
                                revision: 99,
                                fields: { terminal_font_size: 19 },
                                versions: { terminal_font_size: 9998 },
                                draftId: attemptDraftId,
                                fences: [],
                            },
                        });
                        put.onsuccess = () => resolve();
                        put.onerror = () => reject(put.error);
                    });
                    await new Promise<void>((resolve, reject) => {
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                        tx.onabort = () => reject(tx.error);
                    });
                    db.close();
                    return { owner, draftId, attemptId };
                });
                expect(retained.owner).not.toBe('');
                expect(retained.draftId).toBeGreaterThan(0);
                expect(retained.attemptId).toBeGreaterThan(0);

                // Remove A via controller + views (the real shell order:
                // persist, destroy view, select survivor). Use IPC-equivalent
                // sequencing through the host.
                const removal = await electronApp.evaluate(
                    async (_electronApi: unknown, arg: { id: string }) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                controller: {
                                    remove: (id: string) => void;
                                    state: () => {
                                        activeId: string;
                                        profiles: Array<{ id: string }>;
                                    };
                                    setActive: (id: string | null) => void;
                                };
                                profileViews: {
                                    removeProfile: (id: string) => void;
                                    getView: (id: string) => unknown;
                                    getActive: () => string | null;
                                    viewsCreated: () => number;
                                    isSingleTab?: () => boolean;
                                };
                            };
                        };
                        const before =
                            g.__phiMsHost.profileViews.viewsCreated();
                        const wasSingle =
                            g.__phiMsHost.profileViews.isSingleTab?.() ?? false;
                        g.__phiMsHost.controller.remove(arg.id);
                        g.__phiMsHost.profileViews.removeProfile(arg.id);
                        const activeId =
                            g.__phiMsHost.controller.state().activeId;
                        if (activeId !== '')
                            g.__phiMsHost.controller.setActive(activeId);
                        else g.__phiMsHost.profileViews.getActive();
                        const after = g.__phiMsHost.profileViews.viewsCreated();
                        const gone =
                            g.__phiMsHost.profileViews.getView(arg.id) == null;
                        return { before, after, gone, wasSingle, activeId };
                    },
                    { id: ids.aId },
                );
                if (lowMemory === '0') {
                    // Retained-view mode: A's view is destroyed.
                    expect(removal.gone).toBe(true);
                } else {
                    // Single-tab mode: the shared view survives for B.
                    expect(removal.after).toBe(1);
                }

                // Remove the final profile(s) and assert teardown. Remove B
                // as well, leaving zero profiles.
                const finalRemoval = await electronApp.evaluate(
                    async (_electronApi: unknown, arg: { id: string }) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                controller: {
                                    remove: (id: string) => void;
                                    state: () => {
                                        profiles: Array<{ id: string }>;
                                    };
                                };
                                profileViews: {
                                    removeProfile: (id: string) => void;
                                    viewsCreated: () => number;
                                    getActive: () => string | null;
                                    setActive: (id: string | null) => void;
                                };
                            };
                        };
                        g.__phiMsHost.controller.remove(arg.id);
                        g.__phiMsHost.profileViews.removeProfile(arg.id);
                        g.__phiMsHost.profileViews.setActive(null);
                        return {
                            views: g.__phiMsHost.profileViews.viewsCreated(),
                            active: g.__phiMsHost.profileViews.getActive(),
                            profiles:
                                g.__phiMsHost.controller.state().profiles
                                    .length,
                        };
                    },
                    { id: ids.bId },
                );
                expect(finalRemoval.profiles).toBe(0);
                expect(finalRemoval.views).toBe(0);
                expect(finalRemoval.active).toBeNull();

                // Re-add B through the real shell action. Open its Mobile
                // Settings in a fresh renderer using the same session, then
                // inspect read-only recovery entries for removed owner A.
                const readded = await electronApp.evaluate(
                    async (_electronApi: unknown, url: string) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                activateServerUrl: (u: string) => void;
                                controller: {
                                    state: () => {
                                        profiles: Array<{
                                            id: string;
                                            origin: string;
                                        }>;
                                        activeId: string;
                                    };
                                };
                            };
                        };
                        g.__phiMsHost.activateServerUrl(url);
                        const st = g.__phiMsHost.controller.state();
                        return {
                            id: st.profiles[0]?.id || '',
                            count: st.profiles.length,
                        };
                    },
                    phiB.url,
                );
                expect(readded.count).toBe(1);
                await waitFor(async () => {
                    return electronApp!.evaluate(
                        async (_electronApi: unknown, id: string) => {
                            const g = globalThis as unknown as {
                                __phiMsHost: {
                                    profileViews: {
                                        getView: (x: string) => {
                                            webContents: {
                                                executeJavaScript: (
                                                    c: string,
                                                ) => Promise<unknown>;
                                                getURL: () => string;
                                            };
                                        } | null;
                                    } | null;
                                };
                            };
                            const view =
                                g.__phiMsHost.profileViews?.getView(id);
                            if (!view) return false;
                            if (
                                !view.webContents.getURL().includes('desktop=1')
                            )
                                return false;
                            try {
                                return (await view.webContents.executeJavaScript(
                                    `!!(document.getElementById('drawer-settings-btn') || document.querySelector('#header-config-pill .pill-label'))`,
                                )) as boolean;
                            } catch {
                                return false;
                            }
                        },
                        readded.id,
                    );
                }, 30_000);
                // Open fresh Settings for re-added B.
                await electronApp.evaluate(
                    async (_electronApi: unknown, id: string) => {
                        const g = globalThis as unknown as {
                            __phiMsHost: {
                                profileViews: {
                                    getView: (x: string) => {
                                        webContents: {
                                            executeJavaScript: (
                                                c: string,
                                            ) => Promise<unknown>;
                                        };
                                    } | null;
                                };
                            };
                        };
                        const view = g.__phiMsHost.profileViews.getView(id);
                        if (!view) return false;
                        await view.webContents.executeJavaScript(
                            `(() => {
                            const drawer = document.getElementById('drawer-settings-btn');
                            if (drawer) { drawer.click(); return true; }
                            const pill = document.querySelector('#header-config-pill .pill-label');
                            if (pill) { pill.click(); return true; }
                            return false;
                        })()`,
                        );
                        return true;
                    },
                    readded.id,
                );
                await waitFor(
                    async () =>
                        windows.some(
                            (page) =>
                                page !== pageA &&
                                page !== pageB &&
                                !page.isClosed() &&
                                page.url().includes('/config.html'),
                        ),
                    30_000,
                );
                let popupC: Page | null = null;
                for (let i = windows.length - 1; i >= 0; i--) {
                    try {
                        if (windows[i].url().includes('/config.html')) {
                            popupC = windows[i];
                            break;
                        }
                    } catch {}
                }
                expect(popupC).not.toBeNull();
                await expect(
                    popupC!.locator('#settings-mobile-view'),
                ).toBeVisible({ timeout: 30_000 });
                await popupC!.locator('#settings-mobile-view').click();
                await expect(
                    popupC!.locator('#settings-mobile-appearance'),
                ).toBeVisible();
                // Recovery: no automatic save/fence may reach B. In
                // single-tab embedded mode the phi-app origin is shared, so
                // A's draft/attempt survive as read-only recovery entries
                // with their original owner. In retained mode each origin
                // has isolated storage, so B must not see A's rows.
                const bBefore = await mobileState(phiB.url);
                const recovery = await popupC!.evaluate(async () => {
                    const open = () =>
                        new Promise<IDBDatabase>((resolve, reject) => {
                            const req = indexedDB.open(
                                'phi-mobile-appearance-v1',
                                1,
                            );
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => reject(req.error);
                        });
                    const db = await open();
                    const tx = db.transaction(['owners', 'drafts'], 'readonly');
                    const drafts = tx.objectStore('drafts');
                    const owners = tx.objectStore('owners');
                    const rows = await new Promise<
                        Array<{ owner: string; fields: unknown }>
                    >((resolve, reject) => {
                        const r = drafts.getAll();
                        r.onsuccess = () =>
                            resolve(
                                r.result as Array<{
                                    owner: string;
                                    fields: unknown;
                                }>,
                            );
                        r.onerror = () => reject(r.error);
                    });
                    const ownerRows = await new Promise<
                        Array<{ owner: string; attempt: unknown }>
                    >((resolve, reject) => {
                        const r = owners.getAll();
                        r.onsuccess = () =>
                            resolve(
                                r.result as Array<{
                                    owner: string;
                                    attempt: unknown;
                                }>,
                            );
                        r.onerror = () => reject(r.error);
                    });
                    db.close();
                    const entries = [
                        ...document.querySelectorAll(
                            '#settings-mobile-drafts .settings-recovery-entry',
                        ),
                    ].map((el) => el.textContent || '');
                    return { rows, ownerRows, entries };
                });
                if (lowMemory === '1') {
                    expect(
                        recovery.rows.some((r) => r.owner === retained.owner),
                    ).toBe(true);
                    expect(
                        recovery.ownerRows.some(
                            (r) =>
                                r.owner === retained.owner && r.attempt != null,
                        ),
                    ).toBe(true);
                    expect(
                        recovery.entries.some((t) =>
                            t.includes('Other backend (read-only)'),
                        ),
                    ).toBe(true);
                } else {
                    expect(
                        recovery.rows.some((r) => r.owner === retained.owner),
                    ).toBe(false);
                }
                const bAfter = await mobileState(phiB.url);
                expect(bAfter).toEqual(bBefore);

                // Close behavior: popup Close buttons close their windows.
                // Close the fresh popup via its UI and assert it disappears.
                await popupC!
                    .locator('.settings-overlay .modal-close-btn')
                    .click();
                await waitFor(async () => popupC!.isClosed(), 15_000);

                // Normal quit tears down owned views and polling. Close via
                // the app (not kill) and assert Electron exits.
                await electronApp.close();
                electronApp = null;
            } finally {
                try {
                    await electronApp?.close();
                } catch {}
                electronApp = null;
                await phiA?.stop().catch(() => {});
                await phiB?.stop().catch(() => {});
                try {
                    rmSync(fixtureDir, { recursive: true, force: true });
                } catch {}
            }
        });
    }
});
