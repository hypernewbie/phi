import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
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

// macOS Dock safe-area trim (desktop/electron/src/dockSafeArea.ts): a
// fixed 24px blank strip under the app column so an auto-hiding Dock
// cannot steal the pointer from the bottom row. The trim is injected
// user CSS from the macOS desktop main process only — the shipped web
// bundle never contains it. This spec pins BOTH sides of that gate on
// the real Electron shell: on macOS the trim is present (and survives
// reloads and low power mode's fast-mode class); everywhere else it is
// absent (no injected sheet, zero padding) — "macOS desktop only, not
// web, not other desktops" is an invariant, not a hope.

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..', 'desktop', 'electron');
const IS_MAC = process.platform === 'darwin';
const TRIM_PX = 24;

test.describe.configure({ timeout: 180_000 });

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

/** Minimal main-process surface the spec reaches through app.evaluate. */
interface BodyWebContents {
    getURL: () => string;
    executeJavaScript: (code: string) => Promise<unknown>;
    getZoomFactor?: () => number;
}

test('the bottom row keeps a Dock safe-area trim on macOS (and only there)', async () => {
    const testInfo = test.info();
    const paths = ownedPaths();
    const phi = await startPhi();
    const app = await _electron.launch({
        executablePath: electronBinary(),
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
        // The active body view is the retained Phi page marked ?desktop=1.
        const findBody = (): Promise<BodyWebContents | null> =>
            app.evaluate(
                (api: {
                    webContents: {
                        getAllWebContents: () => BodyWebContents[];
                    };
                }) =>
                    api.webContents
                        .getAllWebContents()
                        .find((wc) => wc.getURL().includes('desktop=1')) ??
                    null,
            );
        const refindBody = async (): Promise<BodyWebContents> => {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const found = await findBody();
                if (found) return found;
                await new Promise((r) => setTimeout(r, 500));
            }
            throw new Error('body view (?desktop=1) never appeared');
        };
        const liveBody = await refindBody();

        interface TrimProbe {
            desktop: boolean;
            pad: string;
            fillErr: number;
            lift: number | null;
            fastModeSafe: string;
        }
        const probe = (wc: BodyWebContents): Promise<TrimProbe> =>
            wc.executeJavaScript(`(() => {
                const app = document.querySelector('.app-container');
                const cs = getComputedStyle(app);
                const rect = app.getBoundingClientRect();
                const bar = document.querySelector('.input-bar-container');
                // The visible bottom row's edge: the composer when a session
                // is open, otherwise the app column's content-box bottom
                // (the trim's own lower edge — the composer starts hidden).
                const contentBottom =
                    rect.bottom -
                    parseFloat(cs.paddingBottom) -
                    parseFloat(cs.borderBottomWidth);
                const lift =
                    bar && bar.offsetParent !== null
                        ? window.innerHeight -
                          bar.getBoundingClientRect().bottom
                        : window.innerHeight - contentBottom;
                return {
                    desktop: document.documentElement.hasAttribute(
                        'data-phi-desktop',
                    ),
                    pad: cs.paddingBottom,
                    fillErr: Math.abs(rect.height - window.innerHeight),
                    lift,
                    fastModeSafe: '',
                };
            })()`) as Promise<TrimProbe>;

        // Content zoom scales user CSS like page CSS: the expected trim is
        // TRIM_PX * the body view's zoom factor (fresh fixture = default).
        const zoomFactor = liveBody.getZoomFactor?.() ?? 1;
        const expected = TRIM_PX * (zoomFactor || 1);

        const first = await probe(liveBody);
        expect(first.desktop, 'desktop-hosted page marker').toBe(true);

        if (IS_MAC) {
            expect(parseFloat(first.pad)).toBeCloseTo(expected, 0);
            // Padding, never a resize: the app column still fills the
            // viewport exactly (the strip is painted by the page itself).
            expect(first.fillErr).toBeLessThanOrEqual(1);
            expect(first.lift).toBeCloseTo(expected, 0);

            // Reloads replace the document (and the injected sheet with
            // it): the installer's did-finish-load re-arm must bring it
            // back.
            await liveBody
                .executeJavaScript('location.reload()')
                .catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
            const afterReload = await probe(await refindBody());
            expect(parseFloat(afterReload.pad)).toBeCloseTo(expected, 0);

            // Low power mode only kills effects and throttles rAF: with
            // the controller's fast-mode class forced on, the static
            // padding must be untouched.
            const afterFast = await (
                await refindBody()
            ).executeJavaScript(`(() => {
                document.body.classList.add('fast-mode');
                document.documentElement.setAttribute(
                    'data-phi-desktop-low-power', 'true');
                return getComputedStyle(
                    document.querySelector('.app-container')).paddingBottom;
            })()`);
            expect(parseFloat(afterFast as string)).toBeCloseTo(expected, 0);
        } else {
            // Everywhere else: no injected sheet, no trim — the composer
            // keeps its authored geometry down to the window bottom.
            expect(first.pad).toBe('0px');
        }

        // The rail shares the window's bottom edge (its add button):
        // same trim on macOS, none elsewhere.
        const railPad = await app.evaluate(
            async (api: {
                webContents: { getAllWebContents: () => BodyWebContents[] };
            }) => {
                const rail = api.webContents
                    .getAllWebContents()
                    .find((wc) => wc.getURL().includes('renderer.html'));
                if (!rail) return null;
                return (await rail.executeJavaScript(
                    `(() => {
                        const rail = document.querySelector('#rail');
                        return rail
                            ? getComputedStyle(rail).paddingBottom
                            : null;
                    })()`,
                )) as string | null;
            },
        );
        if (railPad !== null) {
            expect(parseFloat(railPad)).toBe(IS_MAC ? expected : 0);
        }

        // Retain the window capture for the UI acceptance record
        // (composited: header + rail + body, including the trim strip).
        const dataUrl = await app.evaluate(
            (api: {
                BrowserWindow: {
                    getAllWindows: () => {
                        isDestroyed: () => boolean;
                        capturePage: () => {
                            toDataURL: () => string;
                        };
                    }[];
                };
            }) => {
                const win = api.BrowserWindow.getAllWindows().find(
                    (w) => !w.isDestroyed(),
                );
                return win ? win.capturePage().toDataURL() : null;
            },
        );
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
            const shot = join(
                testInfo.outputDir,
                `dock-safe-${process.platform}.png`,
            );
            mkdirSync(testInfo.outputDir, { recursive: true });
            writeFileSync(shot, Buffer.from(dataUrl.split(',')[1], 'base64'));
            await testInfo.attach('dock-safe-window', { path: shot });
        }
    } finally {
        await app.close();
        await phi.stop();
        rmSync(paths.home, { recursive: true, force: true });
    }
});
