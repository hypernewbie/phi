import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    _electron,
    expect,
    test,
    type ElectronApplication,
    type Page,
} from '@playwright/test';
import {
    configToToml,
    electronFixtureEnv,
    startPhi,
    type ElectronFixturePaths,
    type PhiServer,
} from './_server.js';

// The desktop shell hides the body page's own header, so the `...` workspace
// manager button lives only in the shell's vendored header. One real pointer
// click must reach the active body's own manager, and native keyboard input
// must reach that body without a second pointer click. Two desktop modes are
// covered because the body is either a remote HTTP page or the embedded
// phi-app surface.

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..', 'desktop', 'electron');
const fixtureApp = join(here, 'fixtures', 'mobile-settings-app');

const READ_DEADLINE_MS = 3_000;
const CLOSE_DEADLINE_MS = 10_000;
const STATE_ATTACHMENT_BYTES = 8 * 1024;
const LOG_ATTACHMENT_BYTES = 64 * 1024;

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

/** Bounds one renderer or main-process read so a wedged view cannot stall. */
async function withinDeadline<T>(
    work: Promise<T>,
    label: string,
    ms = READ_DEADLINE_MS,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} exceeded ${ms}ms`)),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Reads at most `maxBytes` from the end of `file`; the tail holds shutdown. */
function readTail(file: string, maxBytes: number): Buffer {
    const size = statSync(file).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
        const bytesRead = readSync(fd, buffer, 0, length, size - length);
        return buffer.subarray(0, bytesRead);
    } finally {
        closeSync(fd);
    }
}

/** Keeps complete JSON and ownership metadata within the attachment bound. */
function stateAttachment(evidence: Record<string, unknown>): Buffer {
    const body = Buffer.from(JSON.stringify(evidence, null, 2), 'utf8');
    if (body.length <= STATE_ATTACHMENT_BYTES) return body;
    const lastState = evidence.lastState;
    const summary = Buffer.from(
        JSON.stringify(
            {
                ...evidence,
                truncated: true,
                lastState:
                    lastState !== null && typeof lastState === 'object'
                        ? { ...lastState, dom: null }
                        : null,
            },
            null,
            2,
        ),
        'utf8',
    );
    if (summary.length > STATE_ATTACHMENT_BYTES) {
        throw new Error('state metadata exceeds attachment byte bound');
    }
    return summary;
}

interface BodyDomState {
    activeElementId: string;
    activeElementTag: string;
    activeElementClass: string;
    activeElementFocusVisible: boolean;
    activeElementOutlineStyle: string;
    activeElementBoxShadow: string;
    modalPresent: boolean;
    modalHidden: boolean;
    dialogWidth: number;
    dialogHeight: number;
    dialogOutlineStyle: string;
    dialogOutlineWidth: string;
    dialogBorderTopWidth: string;
    projectValues: string[];
    filterValue: string;
    workspaceValues: string[];
}

interface HostState {
    activeId: string | null;
    activeOrigin: string | null;
    viewActiveId: string | null;
    lowMemoryMode: boolean;
    singleTab: boolean;
    bodyUrl: string | null;
    bodyWebContentsId: number | null;
    focusedWebContentsId: number | null;
    windowFocused: boolean;
    windowVisible: boolean;
    windowMinimized: boolean;
    dom: BodyDomState | null;
}

interface LooseHost {
    controller?: {
        state: () => {
            activeId: string | null;
            profiles: Array<{ id: string; origin: string }>;
        };
        getLowMemoryMode?: () => boolean;
    } | null;
    profileViews?: {
        getActive: () => string | null;
        getView: (id: string) => {
            webContents: {
                id: number;
                getURL: () => string;
                executeJavaScript: (code: string) => Promise<unknown>;
            };
        } | null;
        isSingleTab: () => boolean;
    } | null;
    window: () => {
        isFocused: () => boolean;
        isVisible: () => boolean;
        isMinimized: () => boolean;
        focus: () => void;
    } | null;
}
const BODY_STATE_SCRIPT = `(() => {
    const active = document.activeElement;
    const modal = document.getElementById('ws-manager-modal');
    const dialog = modal ? modal.querySelector('.modal-content') : null;
    const rect = dialog ? dialog.getBoundingClientRect() : null;
    const dialogStyle = dialog ? getComputedStyle(dialog) : null;
    const activeStyle = active ? getComputedStyle(active) : null;
    const filter = document.getElementById('ws-manager-filter');
    const select = document.getElementById('workspace-select');
    return {
        activeElementId: active ? String(active.id || '') : '',
        activeElementTag: active ? String(active.tagName || '') : '',
        activeElementClass: active ? String(active.className || '') : '',
        activeElementFocusVisible: active
            ? active.matches(':focus-visible')
            : false,
        activeElementOutlineStyle: activeStyle
            ? activeStyle.outlineStyle
            : '',
        activeElementBoxShadow: activeStyle ? activeStyle.boxShadow : '',
        modalPresent: modal !== null,
        modalHidden: modal ? modal.classList.contains('hidden') : true,
        dialogWidth: rect ? Math.round(rect.width) : 0,
        dialogHeight: rect ? Math.round(rect.height) : 0,
        dialogOutlineStyle: dialogStyle ? dialogStyle.outlineStyle : '',
        dialogOutlineWidth: dialogStyle ? dialogStyle.outlineWidth : '',
        dialogBorderTopWidth: dialogStyle ? dialogStyle.borderTopWidth : '',
        projectValues: Array.from(
            document.querySelectorAll('#ws-manager-projects .ws-manager-check'),
        ).map((el) => String(el.value)),
        filterValue: filter ? String(filter.value) : '',
        workspaceValues: select
            ? Array.from(select.options).map((option) => String(option.value))
            : [],
    };
})()`;

function readHostState(app: ElectronApplication): Promise<HostState> {
    return app.evaluate(async (api, script: string): Promise<HostState> => {
        const host = (globalThis as unknown as { __phiMsHost: LooseHost })
            .__phiMsHost;
        const views = host?.profileViews ?? null;
        const controllerState = host?.controller?.state() ?? null;
        const activeId = controllerState?.activeId ?? null;
        const activeOrigin =
            controllerState?.profiles.find((profile) => profile.id === activeId)
                ?.origin ?? null;
        const viewActiveId = views ? views.getActive() : null;
        const view =
            activeId !== null && views ? views.getView(activeId) : null;
        const contents = view ? view.webContents : null;
        const dom = contents
            ? ((await contents.executeJavaScript(script)) as BodyDomState)
            : null;
        const focused = api.webContents.getFocusedWebContents();
        const win = host?.window() ?? null;
        return {
            activeId,
            activeOrigin,
            viewActiveId,
            lowMemoryMode: Boolean(
                host?.controller?.getLowMemoryMode?.() ?? false,
            ),
            singleTab: Boolean(views?.isSingleTab() ?? false),
            bodyUrl: contents ? contents.getURL() : null,
            bodyWebContentsId: contents ? contents.id : null,
            focusedWebContentsId: focused ? focused.id : null,
            windowFocused: win ? Boolean(win.isFocused()) : false,
            windowVisible: win ? Boolean(win.isVisible()) : false,
            windowMinimized: win ? Boolean(win.isMinimized()) : false,
            dom,
        };
    }, BODY_STATE_SCRIPT);
}

/** Empty string means ready; anything else is the polled failure reason. */
function readyReason(
    shellValues: string[],
    state: HostState,
    fixtureOrigin: string,
    projectPath: string,
    lowMemory: string,
): string {
    if (state.activeId === null) return 'no active profile';
    if (state.activeOrigin === null) return 'active profile origin unavailable';
    let profileOrigin: string;
    try {
        profileOrigin = new URL(state.activeOrigin).origin;
    } catch {
        return `unparseable active profile origin ${state.activeOrigin}`;
    }
    if (profileOrigin !== fixtureOrigin) {
        return `active profile origin ${profileOrigin} != ${fixtureOrigin}`;
    }
    if (state.viewActiveId !== state.activeId) {
        return `active view ${state.viewActiveId} != profile ${state.activeId}`;
    }
    const wantLowMemory = lowMemory === '1';
    if (state.lowMemoryMode !== wantLowMemory) {
        return `low memory mode ${state.lowMemoryMode} != ${wantLowMemory}`;
    }
    if (state.singleTab !== wantLowMemory) {
        return `single tab ${state.singleTab} != ${wantLowMemory}`;
    }
    if (state.bodyUrl === null) return 'body url unavailable';
    let body: URL;
    try {
        body = new URL(state.bodyUrl);
    } catch {
        return `unparseable body url ${state.bodyUrl}`;
    }
    if (wantLowMemory) {
        if (body.protocol !== 'phi-app:') {
            return `embedded protocol ${body.protocol}`;
        }
        if (body.host !== 'app') return `embedded host ${body.host}`;
        const raw = body.searchParams.get('origin');
        if (raw === null) return 'embedded url has no origin parameter';
        let embedded = '';
        try {
            embedded = new URL(raw).origin;
        } catch {
            return `unparseable embedded origin ${raw}`;
        }
        if (embedded !== fixtureOrigin) {
            return `embedded origin ${embedded} != ${fixtureOrigin}`;
        }
    } else if (body.origin !== fixtureOrigin) {
        return `body origin ${body.origin} != ${fixtureOrigin}`;
    }
    if (body.searchParams.get('desktop') !== '1') {
        return 'body url is missing desktop=1';
    }
    if (!shellValues.includes(projectPath)) {
        return `shell selector missing ${projectPath}`;
    }
    if (!state.dom) return 'body dom unavailable';
    if (!state.dom.workspaceValues.includes(projectPath)) {
        return `body selector missing ${projectPath}`;
    }
    if (!state.dom.modalPresent) return 'body manager modal missing';
    if (!state.dom.modalHidden) return 'body manager opened before the click';
    return '';
}

/** Sends native events to the focused webContents, never to a stale target. */
async function sendInput(
    app: ElectronApplication,
    expectedBodyId: number,
    events: Array<Record<string, unknown>>,
): Promise<void> {
    await app.evaluate(
        async (
            api,
            arg: {
                expected: number;
                events: Array<Record<string, unknown>>;
            },
        ) => {
            const focused = api.webContents.getFocusedWebContents();
            if (!focused || focused.id !== arg.expected) {
                throw new Error(
                    `focused webContents ${focused ? String(focused.id) : 'none'} is not the expected body ${arg.expected}`,
                );
            }
            const send = (event: Record<string, unknown>) =>
                focused.sendInputEvent(
                    event as unknown as Parameters<
                        typeof focused.sendInputEvent
                    >[0],
                );
            for (const event of arg.events) send(event);
        },
        { expected: expectedBodyId, events },
    );
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern for the fixtures argument.
test('workspace manager failure evidence stays byte-bounded', ({}, testInfo) => {
    const evidence = {
        completedStep: 'focus-window',
        serverRoot: 'owned-server-root',
        electronRoot: 'owned-electron-root',
        serverPid: 123,
        electronPid: 456,
        lastState: {
            activeId: 'fixture-profile',
            windowFocused: false,
            dom: { projectValues: ['€'.repeat(3_000)] },
        },
    };
    expect(JSON.stringify(evidence, null, 2).length).toBeLessThan(
        STATE_ATTACHMENT_BYTES,
    );
    const state = stateAttachment(evidence);
    expect.soft(state.length).toBeLessThanOrEqual(STATE_ATTACHMENT_BYTES);
    const parsed = JSON.parse(state.toString('utf8'));
    expect.soft(parsed.truncated).toBe(true);
    expect.soft(parsed.lastState.dom).toBeNull();
    expect(parsed).toMatchObject({
        completedStep: evidence.completedStep,
        serverRoot: evidence.serverRoot,
        electronRoot: evidence.electronRoot,
        serverPid: evidence.serverPid,
        electronPid: evidence.electronPid,
        lastState: { activeId: 'fixture-profile', windowFocused: false },
    });
    const smallEvidence = {
        ...evidence,
        lastState: { ...evidence.lastState, dom: null },
    };
    expect(JSON.parse(stateAttachment(smallEvidence).toString('utf8'))).toEqual(
        smallEvidence,
    );
    expect(() =>
        stateAttachment({
            ...evidence,
            serverRoot: 'x'.repeat(STATE_ATTACHMENT_BYTES),
        }),
    ).toThrow('state metadata exceeds attachment byte bound');

    const log = Buffer.from('€'.repeat(LOG_ATTACHMENT_BYTES), 'utf8');
    const logFile = testInfo.outputPath('unicode-server.log');
    writeFileSync(logFile, log);
    const tail = readTail(logFile, LOG_ATTACHMENT_BYTES);
    expect.soft(tail.length).toBeLessThanOrEqual(LOG_ATTACHMENT_BYTES);
    expect.soft(tail.equals(log.subarray(-LOG_ATTACHMENT_BYTES))).toBe(true);
});

for (const lowMemory of ['0', '1'] as const) {
    test.describe(`desktop workspace manager (lowMemory=${lowMemory})`, () => {
        let app: ElectronApplication | null = null;
        let phi: PhiServer | null = null;
        let electronRoot: string | null = null;
        let serverRoot: string | null = null;
        let projectPath = '';
        let launchAttempted = false;
        let teardownStarted = false;
        let completedStep = 'created';
        let lastState: HostState | null = null;

        /**
         * A startup await can settle after teardown began (test timeout). A
         * late handle is closed here instead of continuing the scenario.
         */
        const stopLateHandle = async (): Promise<boolean> => {
            if (!teardownStarted) return false;
            if (app) {
                await withinDeadline(
                    app.close(),
                    'late app.close',
                    CLOSE_DEADLINE_MS,
                ).catch(() => {});
            }
            await phi?.stop().catch(() => {});
            return true;
        };

        // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern for the fixtures argument.
        test.afterEach(async ({}, testInfo) => {
            testInfo.setTimeout(75_000);
            teardownStarted = true;
            const failures: string[] = [];

            // Evidence first: a failed diagnostic must not block shutdown.
            if (app) {
                try {
                    lastState = await withinDeadline(
                        readHostState(app),
                        'teardown state read',
                    );
                } catch (error) {
                    failures.push(`state evidence: ${String(error)}`);
                }
            }
            const child = app ? app.process() : null;
            const evidence: Record<string, unknown> = {
                lowMemory,
                completedStep,
                projectPath,
                fixtureOrigin: phi ? new URL(phi.url).origin : null,
                serverRoot,
                electronRoot,
                serverPid: phi ? (phi.pid() ?? null) : null,
                electronPid: child ? (child.pid ?? null) : null,
                launchAttempted,
                lastState,
            };
            try {
                await testInfo.attach('desktop-wm-relay-state.json', {
                    body: stateAttachment(evidence),
                    contentType: 'application/json',
                });
            } catch (error) {
                failures.push(`state attachment: ${String(error)}`);
            }
            if (phi) {
                try {
                    const log = readTail(phi.logPath, LOG_ATTACHMENT_BYTES);
                    await testInfo.attach('desktop-wm-relay-server.log', {
                        body: log,
                        contentType: 'text/plain',
                    });
                } catch (error) {
                    failures.push(`server log evidence: ${String(error)}`);
                }
            }

            try {
                if (app) {
                    await withinDeadline(
                        app.close(),
                        'app.close',
                        CLOSE_DEADLINE_MS,
                    );
                }
            } catch (error) {
                failures.push(`app.close: ${String(error)}`);
            }
            try {
                await phi?.stop();
            } catch (error) {
                failures.push(`phi.stop: ${String(error)}`);
            }

            if (electronRoot !== null) {
                const exited =
                    child !== null &&
                    (child.exitCode !== null || child.signalCode !== null);
                if (exited) {
                    try {
                        rmSync(electronRoot, { recursive: true, force: true });
                    } catch (error) {
                        failures.push(
                            `electron root removal: ${String(error)}`,
                        );
                    }
                } else {
                    failures.push(
                        `electron root retained (exit unverified): ${electronRoot}`,
                    );
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `desktop-wm-relay teardown failed:\n${failures.join('\n')}`,
                );
            }
        });

        test(`one shell click opens the active manager (lowMemory=${lowMemory})`, async () => {
            test.setTimeout(180_000);
            completedStep = 'setup';
            phi = await startPhi({
                setup: (dir) => {
                    serverRoot = dir;
                    const project = join(dir, 'project');
                    mkdirSync(project, { recursive: true });
                    projectPath = realpathSync(project);
                    const phiDir = join(dir, 'home', '.phi');
                    mkdirSync(phiDir, { recursive: true });
                    writeFileSync(
                        join(phiDir, 'config.toml'),
                        configToToml({ workspaces: [projectPath] }),
                    );
                },
            });
            if (await stopLateHandle()) return;

            const fixture = ownedPaths();
            electronRoot = dirname(fixture.home);
            const env = electronFixtureEnv(fixture);
            env.PHI_MS_FIXTURE_DIR = electronRoot;
            env.PHI_MS_A_URL = phi.url;
            env.PHI_DESKTOP_LOW_MEMORY = lowMemory;

            completedStep = 'launching';
            launchAttempted = true;
            const launched = await _electron.launch({
                executablePath: electronBinary(),
                args: [fixtureApp],
                cwd: electronRoot,
                env,
                timeout: 60_000,
            });
            app = launched;
            if (await stopLateHandle()) return;
            completedStep = 'launched';

            await expect
                .poll(
                    () =>
                        launched.evaluate(() => {
                            const globals = globalThis as unknown as Record<
                                string,
                                unknown
                            >;
                            if (globals.__phiMsStartError) {
                                throw new Error(
                                    `fixture start failed: ${String(globals.__phiMsStartError)}`,
                                );
                            }
                            return globals.__phiMsReady === true;
                        }),
                    { timeout: 60_000 },
                )
                .toBe(true);
            if (await stopLateHandle()) return;

            completedStep = 'activate';
            await launched.evaluate((_api: unknown, url: string) => {
                const host = (
                    globalThis as unknown as {
                        __phiMsHost: {
                            activateServerUrl: (value: string) => void;
                        };
                    }
                ).__phiMsHost;
                host.activateServerUrl(url);
            }, phi.url);
            if (await stopLateHandle()) return;

            completedStep = 'shell';
            let shell: Page | null = null;
            await expect
                .poll(
                    () => {
                        const found = launched
                            .windows()
                            .find((page) =>
                                page.url().includes('/web/index.html'),
                            );
                        shell = found ?? null;
                        return found !== undefined;
                    },
                    { timeout: 60_000 },
                )
                .toBe(true);
            const shellPage = shell as Page | null;
            if (shellPage === null) throw new Error('shell page not found');
            completedStep = 'shell-ready';

            const fixtureOrigin = new URL(phi.url).origin;
            const readShellValues = async (): Promise<string[]> =>
                shellPage.evaluate(() =>
                    Array.from(
                        document.querySelectorAll('#workspace-select option'),
                    ).map((option) =>
                        String((option as HTMLOptionElement).value),
                    ),
                );

            completedStep = 'ready';
            await expect
                .poll(
                    async () => {
                        const shellValues = await withinDeadline(
                            readShellValues(),
                            'shell selector read',
                        );
                        const state = await withinDeadline(
                            readHostState(launched),
                            'host state read',
                        );
                        lastState = state;
                        return readyReason(
                            shellValues,
                            state,
                            fixtureOrigin,
                            projectPath,
                            lowMemory,
                        );
                    },
                    { timeout: 60_000 },
                )
                .toBe('');

            completedStep = 'ready-verified';

            completedStep = 'focus-window';
            // A launch from a background shell is not the active macOS app, so
            // no webContents owns focus until the app and its window are
            // activated. Activation can be dropped while the window server
            // settles, so retry it within a bound. Only the app and its window
            // are focused here; the body is never focused by the test.
            await expect
                .poll(
                    async () => {
                        const stated = await launched.evaluate((api) => {
                            const host = (
                                globalThis as unknown as {
                                    __phiMsHost: {
                                        window: () => {
                                            isFocused: () => boolean;
                                            focus: () => void;
                                            show: () => void;
                                        } | null;
                                    };
                                }
                            ).__phiMsHost;
                            const win = host.window();
                            if (!win)
                                return { focused: false, reason: 'no window' };
                            try {
                                api.app.focus({ steal: true });
                            } catch (error) {
                                return {
                                    focused: false,
                                    reason: `app.focus failed: ${String(error)}`,
                                };
                            }
                            win.show();
                            win.focus();
                            return { focused: win.isFocused(), reason: '' };
                        });
                        return stated.focused
                            ? ''
                            : stated.reason || 'window not focused';
                    },
                    { timeout: 15_000 },
                )
                .toBe('');
            if (await stopLateHandle()) return;

            completedStep = 'click';
            await shellPage.locator('#ws-manager-btn').click();

            completedStep = 'dialog';
            await expect
                .poll(
                    async () => {
                        const state = await withinDeadline(
                            readHostState(launched),
                            'dialog read',
                        );
                        lastState = state;
                        const dom = state.dom;
                        if (!dom) return 'body dom unavailable';
                        if (dom.modalHidden) return 'manager still hidden';
                        if (dom.dialogWidth <= 0 || dom.dialogHeight <= 0) {
                            return `dialog bounds ${dom.dialogWidth}x${dom.dialogHeight}`;
                        }
                        if (
                            state.focusedWebContentsId !==
                            state.bodyWebContentsId
                        ) {
                            return `focused webContents ${state.focusedWebContentsId ?? 'none'} != body ${state.bodyWebContentsId ?? 'none'} (window focused=${state.windowFocused} visible=${state.windowVisible} minimized=${state.windowMinimized})`;
                        }
                        if (!state.windowFocused)
                            return 'main window not focused';
                        return '';
                    },
                    { timeout: 15_000 },
                )
                .toBe('');

            const opened = await readHostState(launched);
            lastState = opened;
            expect(opened.bodyWebContentsId).not.toBeNull();
            expect(opened.focusedWebContentsId).toBe(opened.bodyWebContentsId);
            expect(opened.windowFocused).toBe(true);
            expect(
                opened.dom?.projectValues.filter(
                    (value) => value === projectPath,
                ),
            ).toEqual([projectPath]);
            expect(opened.dom?.activeElementTag).toBe('DIV');
            expect(opened.dom?.activeElementClass).toContain('modal-content');
            // Chromium keeps outline-width at 3px when outline-style is none.
            expect(opened.dom?.dialogOutlineStyle).toBe('none');
            expect(opened.dom?.dialogBorderTopWidth).toBe('1px');
            const bodyId = opened.bodyWebContentsId as number;
            completedStep = 'opened';

            completedStep = 'tab-close';
            await sendInput(launched, bodyId, [
                { type: 'keyDown', keyCode: 'Tab' },
                { type: 'keyUp', keyCode: 'Tab' },
            ]);
            await expect
                .poll(
                    async () => {
                        const state = await withinDeadline(
                            readHostState(launched),
                            'tab read',
                        );
                        lastState = state;
                        return state.dom?.activeElementId ?? '';
                    },
                    { timeout: 15_000 },
                )
                .toBe('ws-manager-close');
            const closeFocused = await readHostState(launched);
            lastState = closeFocused;
            expect(closeFocused.dom?.activeElementFocusVisible).toBe(true);
            expect(closeFocused.dom?.activeElementOutlineStyle).toBe('none');
            expect(closeFocused.dom?.activeElementBoxShadow).not.toBe('none');

            completedStep = 'tab-filter';
            await sendInput(launched, bodyId, [
                { type: 'keyDown', keyCode: 'Tab' },
                { type: 'keyUp', keyCode: 'Tab' },
            ]);
            await expect
                .poll(
                    async () => {
                        const state = await withinDeadline(
                            readHostState(launched),
                            'tab read',
                        );
                        lastState = state;
                        return state.dom?.activeElementId ?? '';
                    },
                    { timeout: 15_000 },
                )
                .toBe('ws-manager-filter');
            const filterFocused = await readHostState(launched);
            lastState = filterFocused;
            expect(filterFocused.dom?.activeElementFocusVisible).toBe(true);
            expect(filterFocused.dom?.activeElementOutlineStyle).toBe('none');
            expect(filterFocused.dom?.activeElementBoxShadow).not.toBe('none');

            completedStep = 'type';
            await sendInput(launched, bodyId, [
                { type: 'keyDown', keyCode: 'x' },
                { type: 'char', keyCode: 'x' },
                { type: 'keyUp', keyCode: 'x' },
            ]);
            await expect
                .poll(
                    async () => {
                        const state = await withinDeadline(
                            readHostState(launched),
                            'type read',
                        );
                        lastState = state;
                        return state.dom?.filterValue ?? '';
                    },
                    { timeout: 15_000 },
                )
                .toBe('x');

            completedStep = 'escape';
            await sendInput(launched, bodyId, [
                { type: 'keyDown', keyCode: 'Escape' },
                { type: 'keyUp', keyCode: 'Escape' },
            ]);
            await expect
                .poll(
                    async () => {
                        const state = await withinDeadline(
                            readHostState(launched),
                            'escape read',
                        );
                        lastState = state;
                        return state.dom?.modalHidden === true;
                    },
                    { timeout: 15_000 },
                )
                .toBe(true);
            completedStep = 'closed';
        });
    });
}
