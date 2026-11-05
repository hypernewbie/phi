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
import { _electron, expect, test } from '@playwright/test';
import {
    electronFixtureEnv,
    startPhi,
    type ElectronFixturePaths,
} from './_server.js';

// The desktop shell hides the body page's own header
// (html[data-phi-desktop] .app-header), so the sessions/tabs drawer toggle
// lives only in the shell's vendored header. This spec pins the relay that
// turns that hamburger into the active body view's own drawer toggle.

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..', 'desktop', 'electron');

test.skip(
    process.platform === 'linux' &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY,
    'Real Electron requires DISPLAY or WAYLAND_DISPLAY on Linux.',
);
test.describe.configure({ timeout: 180_000 });

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

function ownedPaths(): ElectronFixturePaths {
    const root = mkdtempSync(join(tmpdir(), 'pd-'));
    const paths: ElectronFixturePaths = {
        home: join(root, 'home'),
        appData: join(root, 'appdata'),
        config: join(root, 'config'),
        cache: join(root, 'cache'),
        data: join(root, 'data'),
        state: join(root, 'state'),
        temp: join(root, 'tmp'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
    return paths;
}

test('the shell header hamburger opens the body sessions drawer', async () => {
    const phi = await startPhi();
    const paths = ownedPaths();
    const app = await _electron.launch({
        executablePath: electronBinary(),
        // --server activates the fixture origin; --user-data-dir keeps
        // profiles.json and caches inside the owned fixture instead of the
        // real user store.
        args: [
            '.',
            '--server',
            phi.url,
            `--user-data-dir=${join(paths.appData, 'phi-client')}`,
        ],
        cwd: electronDir,
        env: electronFixtureEnv(paths),
        timeout: 60_000,
    });
    try {
        const shell = await (async () => {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const found = app
                    .windows()
                    .find((page) => page.url().includes('/web/index.html'));
                if (found) return found;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            throw new Error(
                `shell page not found: ${app
                    .windows()
                    .map((page) => page.url())
                    .join(', ')}`,
            );
        })();

        // The active body view is the retained Phi page: the desktop shell
        // marks it with ?desktop=1. (app.evaluate's context is untyped in
        // this tsconfig — annotate it rather than relying on inference.)
        interface BodyWebContents {
            getURL: () => string;
            executeJavaScript: (code: string) => Promise<unknown>;
        }
        const bodyDrawer = async () =>
            app.evaluate(
                async (api: {
                    webContents: {
                        getAllWebContents: () => BodyWebContents[];
                    };
                }) => {
                    const body = api.webContents
                        .getAllWebContents()
                        .find((wc) => wc.getURL().includes('desktop=1'));
                    if (!body) return null;
                    return (await body.executeJavaScript(`(() => {
                    const panel = document.getElementById('sidebar-panel');
                    if (!panel) return null;
                    return {
                        open: panel.classList.contains('drawer-open'),
                        right: Math.round(panel.getBoundingClientRect().right),
                        overflow:
                            document.documentElement.scrollWidth -
                            document.documentElement.clientWidth,
                    };
                })()`)) as {
                        open: boolean;
                        right: number;
                        overflow: number;
                    } | null;
                },
            );

        const resize = async (width: number, height: number) =>
            app.evaluate(
                (
                    api: {
                        BrowserWindow: {
                            getAllWindows: () => {
                                setContentSize: (w: number, h: number) => void;
                            }[];
                        };
                    },
                    size: { width: number; height: number },
                ) => {
                    api.BrowserWindow.getAllWindows()[0].setContentSize(
                        size.width,
                        size.height,
                    );
                },
                { width, height },
            );

        await expect
            .poll(bodyDrawer, { timeout: 60_000 })
            .toMatchObject({ open: false });
        const hamburger = shell.locator('#mobile-sidebar-toggle');

        // Narrow window: the shell shows the hamburger, its click must reach
        // the body view and slide the drawer in.
        await resize(800, 900);
        await expect(hamburger).toBeVisible({ timeout: 15_000 });
        await hamburger.click();
        await expect
            .poll(bodyDrawer, { timeout: 15_000 })
            .toMatchObject({ open: true });
        await expect
            .poll(async () => (await bodyDrawer())?.right ?? 0, {
                timeout: 15_000,
            })
            .toBeGreaterThan(0);
        // An open drawer must not push the body page wider than the view.
        expect((await bodyDrawer())?.overflow ?? 99).toBeLessThanOrEqual(1);
        await hamburger.click();
        await expect
            .poll(bodyDrawer, { timeout: 15_000 })
            .toMatchObject({ open: false });

        // The hamburger is a real button in the shell page, so the keyboard
        // path must reach the same relay (Enter activates the click
        // handler) without the drawer being pointer-only.
        await hamburger.focus();
        await shell.keyboard.press('Enter');
        await expect
            .poll(bodyDrawer, { timeout: 15_000 })
            .toMatchObject({ open: true });
        await shell.keyboard.press('Enter');
        await expect
            .poll(bodyDrawer, { timeout: 15_000 })
            .toMatchObject({ open: false });

        // Wide window: no hamburger, and the drawer state is untouched.
        await resize(1440, 900);
        await expect(hamburger).toBeHidden({ timeout: 15_000 });
        await expect
            .poll(bodyDrawer, { timeout: 15_000 })
            .toMatchObject({ open: false });
    } finally {
        await app.close().catch(() => {});
        await phi.stop();
        rmSync(dirname(paths.home), { recursive: true, force: true });
    }
});
