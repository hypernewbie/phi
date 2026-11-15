/**
 * Soft-keyboard shift: the shell keeps its pre-keyboard geometry and the
 * terminal moves instead of resizing.
 *
 * The helpers below are deliberate local copies of the fixture,
 * instrumentation and polling helpers in
 * e2e/terminal-panel-geometry-real.spec.ts. That spec belongs to the
 * composer workstream and must not change from this workstream, so this
 * file owns its own copy instead of exporting shared helpers from it.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
    type WebSocketRoute,
} from '@playwright/test';
import { TerminalClientFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

interface FitAddon {
    proposeDimensions?(): { cols: number; rows: number } | undefined;
    fit?(): void;
}

interface Terminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    fit?: FitAddon;
    loadAddon(addon: FitAddon): void;
    resize(cols: number, rows: number): void;
    refresh(start: number, end: number): void;
    write(data: string | Uint8Array, callback?: () => void): void;
    buffer: {
        active: {
            baseY: number;
            viewportY: number;
            length: number;
            getLine(
                row: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

interface KeyboardWindow extends Window {
    Terminal: new (options: Record<string, unknown>) => Terminal;
    geometryTerms: Terminal[];
    geometryFits: number;
    geometryRefreshes: number;
    geometryGridEvents: { cols: number; rows: number }[];
    geometryPendingWrites: number;
    geometryPanelResizes: { id: string; width: number; height: number }[];
    __setVisualViewportHeight: (height: number) => void;
    __visualViewportListenerCount: () => number;
}

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

interface KeyboardState {
    root: Box | null;
    panel: Box | null;
    content: Box | null;
    term: Box | null;
    composer: Box | null;
    screen: Box | null;
    sink: Box | null;
    cols: number | null;
    rows: number | null;
    viewportY: number | null;
    fits: number;
    refreshes: number;
    gridEvents: number;
    scrollX: number;
    scrollY: number;
    xtermViewport: {
        scrollHeight: number;
        clientHeight: number;
        scrollTop: number;
    } | null;
    contentTransform: string;
    kbAttribute: string | null;
    kbRootHeight: string;
    kbShift: string;
    kbContentLeft: string;
    kbContentTop: string;
    vvHeight: string;
    activePane: string;
}

interface ShiftLimits {
    visibleHeight: number;
    resizeFrames: number;
    inputFrames: number;
    /** Baseline grid overhang the keyboard must not make worse. */
    overhangLimit?: number;
}

interface WireCounters {
    resize: { cols: number; rows: number }[];
    input: string[];
}

const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

const fixture = `#!/usr/bin/python3
import os, signal, sys, termios

attrs = termios.tcgetattr(0)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(0, termios.TCSANOW, attrs)
sequence = 0

def paint(reason):
    global sequence
    sequence += 1
    cols, rows = os.get_terminal_size(1)
    data = '\\x1b[2J\\x1b[HDRAW %d %s %dx%d\\x1b[%d;1HEDGE' % (sequence, reason, cols, rows, rows)
    os.write(1, data.encode())

def resized(_signum, _frame):
    paint('WINCH')

signal.signal(signal.SIGWINCH, resized)
paint('START')
for line in sys.stdin:
    if line.strip() == 'REPORT':
        paint('REPORT')
    elif line.strip() == 'SCROLL':
        data = ''.join('ROW %03d %s\\r\\n' % (i, 'x' * 24) for i in range(1, 201))
        os.write(1, data.encode())
        paint('SCROLLDONE')
`;

function startGeometryFixture(
    config?: Record<string, unknown>,
): Promise<PhiServer> {
    return startPhi({
        ...(config ? { config } : {}),
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const folder = join(dir, 'workspace');
            mkdirSync(folder, { recursive: true });
            const workspace = realpathSync(folder);
            const phiDir = join(dir, 'home', '.phi');
            const backends = join(phiDir, 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'fixture-bash');
            writeFileSync(command, fixture, { mode: 0o755 });
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command }),
            );
            writeFileSync(
                join(phiDir, 'tabs.json'),
                JSON.stringify(
                    ['t1', 't2'].map((id, index) => ({
                        id,
                        coder: 'bash',
                        session_id: '',
                        cwd: workspace,
                        workspace,
                        title: `Tab ${index + 1}`,
                    })),
                ),
            );
        },
    });
}

async function captureGeometry(page: Page) {
    await page.addInitScript(() => {
        const win = window as unknown as KeyboardWindow;
        win.geometryTerms = [];
        win.geometryFits = 0;
        win.geometryRefreshes = 0;
        win.geometryGridEvents = [];
        win.geometryPendingWrites = 0;
        let Constructor: typeof win.Terminal;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Constructor,
            set: (Base: typeof win.Terminal) => {
                Constructor = class extends Base {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        win.geometryTerms.push(this);
                    }
                    loadAddon(addon: FitAddon) {
                        if (addon.proposeDimensions) {
                            this.fit = addon;
                            const fit = addon.fit?.bind(addon);
                            if (fit) {
                                addon.fit = () => {
                                    win.geometryFits++;
                                    fit();
                                };
                            }
                        }
                        super.loadAddon(addon);
                    }
                    resize(cols: number, rows: number) {
                        win.geometryGridEvents.push({ cols, rows });
                        super.resize(cols, rows);
                    }
                    refresh(start: number, end: number) {
                        if (start === 0 && end >= this.rows - 1)
                            win.geometryRefreshes++;
                        super.refresh(start, end);
                    }
                    write(data: string | Uint8Array, callback?: () => void) {
                        win.geometryPendingWrites++;
                        super.write(data, () => {
                            win.geometryPendingWrites--;
                            callback?.();
                        });
                    }
                };
            },
        });
    });
}

async function grid(page: Page) {
    return page.evaluate(() => {
        const win = window as unknown as KeyboardWindow;
        const term = win.geometryTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!term) return null;
        const active = term.buffer.active;
        const first =
            active.getLine(active.baseY)?.translateToString(true) ?? '';
        const match = /^DRAW (\d+) (START|WINCH|REPORT) (\d+)x(\d+)/.exec(
            first,
        );
        return {
            cols: term.cols,
            rows: term.rows,
            proposed: term.fit?.proposeDimensions?.(),
            seq: match ? Number(match[1]) : 0,
            reason: match?.[2] ?? '',
            ptyCols: match ? Number(match[3]) : 0,
            ptyRows: match ? Number(match[4]) : 0,
            edge:
                active
                    .getLine(active.baseY + term.rows - 1)
                    ?.translateToString(true) ?? '',
            first,
        };
    });
}

async function waitForGrid(
    page: Page,
    label: string,
    after = 0,
    reason?: 'WINCH' | 'REPORT',
    previousCols?: number,
) {
    await expect
        .poll(
            async () => {
                const state = await grid(page);
                return (
                    !!state &&
                    state.seq > after &&
                    (!reason || state.reason === reason) &&
                    (previousCols === undefined ||
                        state.cols !== previousCols) &&
                    state.cols === state.ptyCols &&
                    state.rows === state.ptyRows &&
                    state.proposed?.cols === state.cols &&
                    state.proposed.rows === state.rows &&
                    state.edge === 'EDGE'
                );
            },
            {
                message: `${label}: fresh matching real PTY grid`,
                timeout: 15_000,
            },
        )
        .toBe(true);
    const state = await grid(page);
    if (!state) throw new Error(`${label}: missing terminal`);
    console.log(`${label}: ${JSON.stringify(state)}`);
    return state;
}

/** Same consistency contract as waitForGrid, without demanding a new seq. */
async function waitForSettledGrid(page: Page, label: string) {
    await expect
        .poll(
            async () => {
                const state = await grid(page);
                return (
                    !!state &&
                    state.seq > 0 &&
                    state.cols === state.ptyCols &&
                    state.rows === state.ptyRows &&
                    state.proposed?.cols === state.cols &&
                    state.proposed.rows === state.rows &&
                    state.edge === 'EDGE'
                );
            },
            {
                message: `${label}: settled matching real PTY grid`,
                timeout: 15_000,
            },
        )
        .toBe(true);
    const state = await grid(page);
    if (!state) throw new Error(`${label}: missing terminal`);
    console.log(`${label}: ${JSON.stringify(state)}`);
    return state;
}

async function selectMobile(page: Page) {
    await page.locator('#mobile-sidebar-toggle').click();
    const row = page.locator(
        '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t1"] .hostname-dropdown-select-btn',
    );
    if (!(await row.isVisible())) {
        // A touch shell wider than the compact breakpoint opens the drawer
        // on its sessions page; switch it to the tab list first.
        await page.locator('#drawer-back-to-tabs').dispatchEvent('click');
    }
    await expect(row, 'drawer tab row').toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        't1',
    );
}

/**
 * Fake visualViewport. The setter simulates a visual-only change; a layout
 * change is simulated with the real viewport instead. `absent` mode hides
 * the API entirely, the way old Chromium behaves.
 */
async function installVisualViewport(
    page: Page,
    mode: 'fake' | 'absent' = 'fake',
) {
    await page.addInitScript((kind) => {
        const control = window as unknown as KeyboardWindow;
        if (kind === 'absent') {
            Object.defineProperty(window, 'visualViewport', {
                configurable: true,
                get: () => undefined,
            });
            control.__setVisualViewportHeight = () => {
                throw new Error('visualViewport is absent in this context');
            };
            control.__visualViewportListenerCount = () => 0;
            return;
        }
        const listeners = new Set<EventListenerOrEventListenerObject>();
        const viewport = {
            width: window.innerWidth,
            height: window.innerHeight,
            offsetTop: 0,
            offsetLeft: 0,
            pageTop: 0,
            pageLeft: 0,
            scale: 1,
            addEventListener(
                type: string,
                listener: EventListenerOrEventListenerObject,
            ) {
                if (type === 'resize' || type === 'scroll')
                    listeners.add(listener);
            },
            removeEventListener(
                type: string,
                listener: EventListenerOrEventListenerObject,
            ) {
                if (type === 'resize' || type === 'scroll')
                    listeners.delete(listener);
            },
            dispatchEvent() {
                return true;
            },
        };
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            get: () => viewport,
        });
        control.__setVisualViewportHeight = (height: number) => {
            // A layout change is simulated by changing the real viewport
            // first; the fake width must follow it so width resets are real.
            viewport.width = window.innerWidth;
            viewport.height = height;
            for (const listener of listeners) {
                if (typeof listener === 'function')
                    listener(new Event('resize'));
                else listener.handleEvent(new Event('resize'));
            }
        };
        control.__visualViewportListenerCount = () => listeners.size;
    }, mode);
}

function watchPaneWire(page: Page): WireCounters {
    const counters: WireCounters = { resize: [], input: [] };
    page.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname !== '/ws/pane/t1') return;
        socket.on('framesent', (event) => {
            if (typeof event.payload === 'string') return;
            try {
                const frame = ClientCodec.decode(new Uint8Array(event.payload));
                const payload = frame.payload;
                if (payload?.$case === 'resize') {
                    counters.resize.push({
                        cols: payload.value.cols ?? 0,
                        rows: payload.value.rows ?? 0,
                    });
                } else if (payload?.$case === 'input') {
                    counters.input.push(
                        Buffer.from(payload.value).toString('utf8'),
                    );
                }
            } catch {
                /* non-terminal frames are not counted */
            }
        });
    });
    return counters;
}

/** Raw, unrounded geometry. Rounding here would hide subpixel resizes. */
async function keyboardState(page: Page): Promise<KeyboardState | null> {
    return page.evaluate(() => {
        const win = window as unknown as KeyboardWindow;
        const box = (element: Element | null) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
            };
        };
        const rootElement = document.documentElement;
        const rootStyle = rootElement.style;
        const content = document.querySelector('.terminal-content');
        const activePane = document.querySelector(
            '#terminals-wrapper > .term-container.active',
        );
        const termElement = activePane ?? document.getElementById('term-t1');
        const viewportElement =
            termElement?.querySelector('.xterm-viewport') ?? null;
        const term = win.geometryTerms?.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        const buffer = term?.buffer?.active;
        return {
            root: box(document.querySelector('.app-container')),
            panel: box(document.querySelector('.terminal-panel')),
            content: box(content),
            term: box(document.getElementById('term-t1')),
            composer: box(document.getElementById('input-bar-container')),
            screen: box(termElement?.querySelector('.xterm-screen') ?? null),
            sink: box(
                termElement?.querySelector('.xterm-helper-textarea') ?? null,
            ),
            cols: term?.cols ?? null,
            rows: term?.rows ?? null,
            viewportY: buffer?.viewportY ?? null,
            fits: win.geometryFits,
            refreshes: win.geometryRefreshes,
            gridEvents: win.geometryGridEvents.length,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            xtermViewport: viewportElement
                ? {
                      scrollHeight: viewportElement.scrollHeight,
                      clientHeight: viewportElement.clientHeight,
                      scrollTop: viewportElement.scrollTop,
                  }
                : null,
            contentTransform: content
                ? getComputedStyle(content).transform
                : '',
            kbAttribute: rootElement.getAttribute('data-kb-shift'),
            kbRootHeight: rootStyle.getPropertyValue('--kb-root-height'),
            kbShift: rootStyle.getPropertyValue('--kb-shift'),
            kbContentLeft: rootStyle.getPropertyValue('--kb-content-left'),
            kbContentTop: rootStyle.getPropertyValue('--kb-content-top'),
            vvHeight: rootStyle.getPropertyValue('--vv-height'),
            activePane:
                document
                    .querySelector('#tabs-container .tab.active')
                    ?.getAttribute('data-pane-id') ?? '',
        };
    });
}

async function settleComposer(page: Page) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (window as unknown as KeyboardWindow)
                            .geometryPendingWrites,
                ),
            { timeout: 10_000 },
        )
        .toBe(0);
    for (let i = 0; i < 2; i++) {
        await page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    ),
                ),
        );
    }
}

async function setVisualHeight(page: Page, height: number) {
    await page.evaluate(
        (value) =>
            (window as unknown as KeyboardWindow).__setVisualViewportHeight(
                value,
            ),
        height,
    );
}

async function expectVisibleHeight(page: Page, expected: number) {
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    document.documentElement.style.getPropertyValue(
                        '--vv-height',
                    ),
                ),
            { timeout: 15_000, message: `--vv-height ${expected}px` },
        )
        .toBe(`${expected}px`);
    await settleComposer(page);
}

/** Subpixel-exact geometry: 1/64 CSS px, no integer rounding. */
const GEOMETRY_TOLERANCE = 1 / 64;
const PIXEL_TOLERANCE = 1;

function expectWithin(
    label: string,
    actual: number | null | undefined,
    expected: number | null | undefined,
    tolerance: number,
    log: Record<string, unknown>,
    failures: string[],
) {
    const before = expected ?? Number.NaN;
    const after = actual ?? Number.NaN;
    const ok =
        Number.isFinite(before) &&
        Number.isFinite(after) &&
        Math.abs(after - before) <= tolerance;
    log[label] = { before, after, tolerance, ok };
    if (!ok) failures.push(label);
    expect
        .soft(
            Math.abs(after - before),
            `${label} (before ${before}, after ${after})`,
        )
        .toBeLessThanOrEqual(tolerance);
}

function expectEqual(
    label: string,
    actual: unknown,
    expected: unknown,
    log: Record<string, unknown>,
    failures: string[],
) {
    const ok = actual === expected;
    log[label] = { before: expected, after: actual, ok };
    if (!ok) failures.push(label);
    expect
        .soft(actual, `${label} (before ${expected}, after ${actual})`)
        .toBe(expected);
}

/**
 * I1..I10: the claims the keyboard path must keep, for one sample against
 * one closed baseline. Every check is soft so one run reports all breaks.
 */
function assertShiftInvariants(
    label: string,
    baseline: KeyboardState,
    current: KeyboardState,
    limits: ShiftLimits,
) {
    const log: Record<string, unknown> = {};
    const failures: string[] = [];
    const box = (name: string, before: Box | null, after: Box | null) => {
        expectWithin(
            `${name} left`,
            after?.left,
            before?.left,
            GEOMETRY_TOLERANCE,
            log,
            failures,
        );
        expectWithin(
            `${name} top`,
            after?.top,
            before?.top,
            GEOMETRY_TOLERANCE,
            log,
            failures,
        );
        size(name, before, after);
    };
    // Size only: the panel is a fit-observable box, its screen position is
    // not (the whole point is that content moves while boxes keep their size).
    const size = (name: string, before: Box | null, after: Box | null) => {
        expectWithin(
            `${name} width`,
            after?.width,
            before?.width,
            GEOMETRY_TOLERANCE,
            log,
            failures,
        );
        expectWithin(
            `${name} height`,
            after?.height,
            before?.height,
            GEOMETRY_TOLERANCE,
            log,
            failures,
        );
    };

    // I1: the app root keeps its geometry. This is the whole point.
    expectWithin(
        'I1 root width',
        current.root?.width,
        baseline.root?.width,
        GEOMETRY_TOLERANCE,
        log,
        failures,
    );
    expectWithin(
        'I1 root height',
        current.root?.height,
        baseline.root?.height,
        GEOMETRY_TOLERANCE,
        log,
        failures,
    );
    // I2: no fit-observable box changed size.
    size('I2 panel', baseline.panel, current.panel);
    size('I2 term container', baseline.term, current.term);
    // I3: the frozen grid keeps its rows.
    expectEqual('I3 rows', current.rows, baseline.rows, log, failures);
    // I4: the keyboard never resized the PTY.
    expectEqual('I4 wire resize frames', limits.resizeFrames, 0, log, failures);
    // I5: the composer stack rides the visible bottom. `.presets-toolbar`
    // is the last child of `.terminal-content`, so the stack bottom is the
    // content's own bottom edge, not the input bar's.
    expectWithin(
        'I5 composer stack bottom',
        current.content?.bottom,
        limits.visibleHeight,
        PIXEL_TOLERANCE,
        log,
        failures,
    );
    expectWithin(
        'I5 composer offset from stack bottom',
        (current.content?.bottom ?? Number.NaN) -
            (current.composer?.bottom ?? Number.NaN),
        (baseline.content?.bottom ?? Number.NaN) -
            (baseline.composer?.bottom ?? Number.NaN),
        GEOMETRY_TOLERANCE,
        log,
        failures,
    );
    // I6: the grid is not clipped inside xterm.
    expectWithin(
        'I6 xterm viewport scrollHeight - clientHeight',
        current.xtermViewport?.scrollHeight,
        current.xtermViewport?.clientHeight,
        PIXEL_TOLERANCE,
        log,
        failures,
    );
    // I7: the grid bottom, where the prompt lives, must not pass the
    // composer's top edge. One-sided: a gap above the composer is fine.
    // A case whose closed baseline is already overfull passes its own
    // limit, so the keyboard is still required not to make it worse.
    const overhangLimit = limits.overhangLimit ?? PIXEL_TOLERANCE;
    const gridOverhang =
        (current.screen?.bottom ?? Number.NaN) -
        (current.composer?.top ?? Number.NaN);
    log['I7 screen bottom over composer top'] = {
        overhang: gridOverhang,
        limit: overhangLimit,
        ok: gridOverhang <= overhangLimit,
    };
    if (!(gridOverhang <= overhangLimit))
        failures.push('I7 screen bottom over composer top');
    expect
        .soft(gridOverhang, `I7 grid overhang past the composer (${label})`)
        .toBeLessThanOrEqual(overhangLimit);
    // I8: the focus sink keeps its screen origin, both axes.
    box('I8 helper textarea', baseline.sink, current.sink);
    // I9: no fit, refresh, grid resize, row or column change.
    expectEqual('I9 fits', current.fits, baseline.fits, log, failures);
    expectEqual(
        'I9 refreshes',
        current.refreshes,
        baseline.refreshes,
        log,
        failures,
    );
    expectEqual(
        'I9 grid events',
        current.gridEvents,
        baseline.gridEvents,
        log,
        failures,
    );
    expectEqual('I9 cols', current.cols, baseline.cols, log, failures);
    // I10: no scroll moved, and no input was sent.
    expectEqual(
        'I10 buffer viewportY',
        current.viewportY,
        baseline.viewportY,
        log,
        failures,
    );
    expectEqual(
        'I10 xterm scrollTop',
        current.xtermViewport?.scrollTop,
        baseline.xtermViewport?.scrollTop,
        log,
        failures,
    );
    expectEqual(
        'I10 scrollX',
        current.scrollX,
        baseline.scrollX,
        log,
        failures,
    );
    expectEqual(
        'I10 scrollY',
        current.scrollY,
        baseline.scrollY,
        log,
        failures,
    );
    expectEqual('I10 wire input frames', limits.inputFrames, 0, log, failures);

    console.log(
        `${label}: ${JSON.stringify({
            failures,
            checks: log,
            baseline,
            current,
        })}`,
    );
    return failures;
}

function assertShiftCleared(label: string, state: KeyboardState) {
    const log = {
        attribute: state.kbAttribute,
        rootHeight: state.kbRootHeight,
        shift: state.kbShift,
        contentLeft: state.kbContentLeft,
        contentTop: state.kbContentTop,
        transform: state.contentTransform,
    };
    console.log(`${label} cleared: ${JSON.stringify(log)}`);
    expect
        .soft(state.kbAttribute, `${label}: data-kb-shift removed`)
        .toBeNull();
    expect.soft(state.kbRootHeight, `${label}: --kb-root-height`).toBe('');
    expect.soft(state.kbShift, `${label}: --kb-shift`).toBe('');
    expect.soft(state.kbContentLeft, `${label}: --kb-content-left`).toBe('');
    expect.soft(state.kbContentTop, `${label}: --kb-content-top`).toBe('');
    expect
        .soft(state.contentTransform, `${label}: content transform`)
        .toBe('none');
}

async function selectTab(page: Page) {
    await page.locator('.tab[data-pane-id="t1"]').click();
    await expect(page.locator('#term-t1')).toHaveClass(/active/);
}

/** Tab chrome can be hidden inside a drawer; a dispatched click still selects. */
async function selectTabDispatch(page: Page) {
    await page.locator('.tab[data-pane-id="t1"]').dispatchEvent('click');
    await expect(page.locator('#term-t1')).toHaveClass(/active/);
}

async function ensureComposer(page: Page) {
    const bar = page.locator('#input-bar-container');
    if (!(await bar.isVisible())) {
        await page.locator('#direct-mode-toggle').click();
        await expect(bar).toBeVisible();
    }
    await expect(page.locator('#input-textarea')).toBeVisible();
    await settleComposer(page);
}

async function capabilities(page: Page) {
    return page.evaluate(() => {
        const layoutHeight = window.innerHeight;
        const visualHeight = window.visualViewport?.height ?? 0;
        return {
            coarse: matchMedia('(pointer: coarse)').matches,
            compact: matchMedia(
                '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
            ).matches,
            scale: window.visualViewport?.scale ?? 0,
            hasVisualViewport: !!window.visualViewport,
            visualHeight,
            layoutHeight,
            layoutWidth: window.innerWidth,
            clientHeight: document.documentElement.clientHeight,
            usableHeight: Math.min(layoutHeight, visualHeight),
            hasSelector: CSS.supports('selector(:has(*))'),
            resizeObserver: typeof ResizeObserver === 'function',
            listeners: (
                window as unknown as KeyboardWindow
            ).__visualViewportListenerCount(),
        };
    });
}

async function elementBox(page: Page, selector: string) {
    return page.evaluate((target) => {
        const element = document.querySelector(target);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
    }, selector);
}

interface Harness {
    context: BrowserContext;
    page: Page;
    wire: WireCounters;
    errors: string[];
    consoleErrors: string[];
}

interface HarnessOptions {
    viewport: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
    query?: string;
    select: 'mobile' | 'desktop' | 'dispatch';
    absentVisualViewport?: boolean;
    beforeGoto?: (page: Page) => Promise<void>;
}

async function openHarness(
    browser: Browser,
    url: string,
    options: HarnessOptions,
    label = 'ready',
): Promise<Harness> {
    const context = await browser.newContext({
        viewport: options.viewport,
        isMobile: options.isMobile ?? true,
        hasTouch: options.hasTouch ?? true,
    });
    try {
        const page = await context.newPage();
        const errors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        await installVisualViewport(
            page,
            options.absentVisualViewport ? 'absent' : 'fake',
        );
        await captureGeometry(page);
        const wire = watchPaneWire(page);
        if (options.beforeGoto) await options.beforeGoto(page);
        await page.goto(`${url}${options.query ?? ''}`);
        await page.evaluate(() => document.fonts.ready);
        if (options.select === 'mobile') await selectMobile(page);
        else if (options.select === 'dispatch') await selectTabDispatch(page);
        else await selectTab(page);
        await waitForGrid(page, `${label} initial`);
        await ensureComposer(page);
        await waitForSettledGrid(page, `${label} settled`);
        return { context, page, wire, errors, consoleErrors };
    } catch (error) {
        await context.close();
        throw error;
    }
}

async function requireState(page: Page, label: string): Promise<KeyboardState> {
    const state = await keyboardState(page);
    if (!state) throw new Error(`${label}: missing keyboard state`);
    return state;
}

async function keyboardSample(
    page: Page,
    visualHeight: number,
    expectedVisible = visualHeight,
): Promise<KeyboardState> {
    await setVisualHeight(page, visualHeight);
    await expectVisibleHeight(page, expectedVisible);
    return requireState(page, `sample ${visualHeight}`);
}

/**
 * A real layout change legitimately fits the grid, and the app may debounce
 * that fit. Baselines taken across such a boundary wait until the fit,
 * refresh and grid counters stop moving, so a legitimate late fit can never
 * be counted as a keyboard fit. Bounded, never a fixed sleep.
 */
async function waitForQuietCounters(
    page: Page,
    label: string,
): Promise<KeyboardState> {
    const quietMs = 500;
    const deadline = Date.now() + 15_000;
    const counters = () =>
        page.evaluate(() => {
            const win = window as unknown as KeyboardWindow;
            return {
                fits: win.geometryFits,
                refreshes: win.geometryRefreshes,
                gridEvents: win.geometryGridEvents.length,
            };
        });
    let last = await counters();
    let lastChange = Date.now();
    while (Date.now() < deadline) {
        await page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    ),
                ),
        );
        const current = await counters();
        if (
            current.fits !== last.fits ||
            current.refreshes !== last.refreshes ||
            current.gridEvents !== last.gridEvents
        ) {
            lastChange = Date.now();
        }
        last = current;
        if (Date.now() - lastChange >= quietMs)
            return requireState(page, label);
    }
    throw new Error(`${label}: fit counters never settled`);
}

async function expectShiftClearedEventually(page: Page, label: string) {
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    document.documentElement.getAttribute('data-kb-shift'),
                ),
            { timeout: 15_000, message: `${label}: shift attribute removed` },
        )
        .toBeNull();
}

async function expectRootHeight(page: Page, height: number, label: string) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        document
                            .querySelector('.app-container')
                            ?.getBoundingClientRect().height ?? 0,
                ),
            { timeout: 15_000, message: `${label}: root height ${height}` },
        )
        .toBeCloseTo(height, 3);
}

function shiftValue(state: KeyboardState) {
    return Number.parseFloat(state.kbShift);
}

interface CycleExpectation {
    label: string;
    page: Page;
    wire: WireCounters;
    baseline: KeyboardState;
    resizeBase: number;
    inputBase: number;
    openHeight: number;
    closeHeight: number;
    expectedRoot: number;
    samples: Record<string, unknown>;
    clearedOnClose?: boolean;
    overhangLimit?: number;
}

/** One open/close cycle, fully asserted against a closed baseline. */
async function runKeyboardCycle(expectation: CycleExpectation) {
    const {
        label,
        page,
        wire,
        baseline,
        resizeBase,
        inputBase,
        openHeight,
        closeHeight,
        expectedRoot,
        samples,
    } = expectation;
    const opened = await keyboardSample(page, openHeight);
    expect.soft(opened.kbAttribute, `${label}: shift intent`).toBe('terminal');
    expect
        .soft(opened.kbRootHeight, `${label}: captured root`)
        .toBe(`${expectedRoot}px`);
    expect
        .soft(shiftValue(opened), `${label}: shift`)
        .toBeCloseTo(expectedRoot - openHeight, 6);
    const openFailures = assertShiftInvariants(
        `${label} open`,
        baseline,
        opened,
        {
            visibleHeight: openHeight,
            resizeFrames: wire.resize.slice(resizeBase).length,
            inputFrames: wire.input.slice(inputBase).length,
            overhangLimit: expectation.overhangLimit,
        },
    );
    const closed = await keyboardSample(page, closeHeight);
    const closeFailures = assertShiftInvariants(
        `${label} close`,
        baseline,
        closed,
        {
            visibleHeight: closeHeight,
            resizeFrames: wire.resize.slice(resizeBase).length,
            inputFrames: wire.input.slice(inputBase).length,
            overhangLimit: expectation.overhangLimit,
        },
    );
    if (expectation.clearedOnClose !== false)
        assertShiftCleared(`${label} close`, closed);
    samples[label] = {
        opened,
        closed,
        openFailures,
        closeFailures,
        wire: {
            resize: wire.resize.slice(resizeBase),
            input: wire.input.slice(inputBase),
        },
    };
    return { opened, closed, openFailures, closeFailures };
}

test('keyboard MVP', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await mobile.newPage();
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error')
                    consoleErrors.push(message.text());
            });
            await installVisualViewport(page);
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);

            const capabilities = await page.evaluate(() => {
                const layoutHeight = window.innerHeight;
                const visualHeight = window.visualViewport?.height ?? 0;
                return {
                    coarse: matchMedia('(pointer: coarse)').matches,
                    scale: window.visualViewport?.scale ?? 0,
                    visualHeight,
                    layoutHeight,
                    clientHeight: document.documentElement.clientHeight,
                    usableHeight: Math.min(layoutHeight, visualHeight),
                    hasSelector: CSS.supports('selector(:has(*))'),
                    resizeObserver: typeof ResizeObserver === 'function',
                    listeners: (
                        window as unknown as KeyboardWindow
                    ).__visualViewportListenerCount(),
                };
            });
            samples.capabilities = capabilities;
            expect(capabilities.coarse, 'coarse pointer').toBe(true);
            expect(capabilities.scale, 'viewport scale').toBe(1);
            expect(capabilities.layoutHeight, 'layout height').toBe(844);
            expect(capabilities.clientHeight, 'layout client height').toBe(844);
            expect(capabilities.visualHeight, 'visual height').toBeGreaterThan(
                0,
            );
            expect(capabilities.usableHeight, 'usable visual height').toBe(844);
            expect(capabilities.hasSelector, 'CSS :has()').toBe(true);
            expect(capabilities.resizeObserver, 'ResizeObserver').toBe(true);
            expect(
                capabilities.listeners,
                'visualViewport listeners',
            ).toBeGreaterThan(0);

            await selectMobile(page);
            const initial = await waitForGrid(page, 'kb shift');
            expect(initial.seq, 'initial PTY marker').toBeGreaterThan(0);
            expect(initial.edge, 'initial PTY edge').toBe('EDGE');
            expect(initial.cols, 'initial PTY cols').toBe(
                initial.proposed?.cols,
            );
            expect(initial.rows, 'initial PTY rows').toBe(
                initial.proposed?.rows,
            );
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible())) {
                await page.locator('#direct-mode-toggle').click();
                await expect(bar).toBeVisible();
            }
            await expect(page.locator('#input-textarea')).toBeVisible();
            await settleComposer(page);
            // Revealing the composer legitimately refits the grid once. The
            // keyboard-proof baseline is the settled grid that follows.
            const settled = await waitForSettledGrid(page, 'kb shift settled');
            expect(settled.seq, 'settled PTY marker').toBeGreaterThan(0);
            expect(settled.edge, 'settled PTY edge').toBe('EDGE');
            expect(settled.cols, 'settled PTY cols').toBe(
                settled.proposed?.cols,
            );
            expect(settled.rows, 'settled PTY rows').toBe(
                settled.proposed?.rows,
            );
            expect(
                wire.resize.length,
                'initial pane resize frames',
            ).toBeGreaterThan(0);

            const before = await keyboardState(page);
            expect(before, 'closed baseline').not.toBeNull();
            if (!before) throw new Error('missing closed baseline');
            expect(before.root?.height, 'baseline root height').toBeCloseTo(
                844,
                3,
            );
            expect(before.vvHeight, 'baseline visible height var').toBe(
                '844px',
            );
            expect(before.activePane, 'baseline active pane').toBe('t1');
            expect(before.rows, 'baseline rows').toBe(settled.rows);
            expect(before.cols, 'baseline cols').toBe(settled.cols);
            // A clipped baseline would make every later check meaningless.
            expect(
                Math.abs(
                    (before.xtermViewport?.scrollHeight ?? 0) -
                        (before.xtermViewport?.clientHeight ?? 0),
                ),
                'baseline xterm viewport is not clipped',
            ).toBeLessThanOrEqual(PIXEL_TOLERANCE);
            expect(before.sink, 'baseline focus sink').not.toBeNull();
            expect(before.screen, 'baseline grid canvas').not.toBeNull();

            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;

            await page.locator('#input-textarea').focus();
            await setVisualHeight(page, 500);
            await expectVisibleHeight(page, 500);
            const opened = await keyboardState(page);
            expect(opened, 'keyboard state').not.toBeNull();
            if (!opened) throw new Error('missing keyboard state');
            const openWire = {
                resizeFrames: wire.resize.slice(resizeBase).length,
                inputFrames: wire.input.slice(inputBase).length,
            };
            samples.opened = {
                before,
                after: opened,
                wire: {
                    resize: wire.resize.slice(resizeBase),
                    input: wire.input.slice(inputBase),
                },
            };
            const openFailures = assertShiftInvariants('open', before, opened, {
                visibleHeight: 500,
                resizeFrames: openWire.resizeFrames,
                inputFrames: openWire.inputFrames,
            });
            expect.soft(opened.kbAttribute, 'shift intent').toBe('terminal');
            expect
                .soft(opened.kbRootHeight, 'captured root height')
                .toBe('844px');
            samples.openFailures = openFailures;

            await setVisualHeight(page, 844);
            await expectVisibleHeight(page, 844);
            const closed = await keyboardState(page);
            expect(closed, 'closed state').not.toBeNull();
            if (!closed) throw new Error('missing closed state');
            samples.closed = {
                before,
                after: closed,
                wire: {
                    resize: wire.resize.slice(resizeBase),
                    input: wire.input.slice(inputBase),
                },
            };
            const closeFailures = assertShiftInvariants(
                'close',
                before,
                closed,
                {
                    visibleHeight: 844,
                    resizeFrames: wire.resize.slice(resizeBase).length,
                    inputFrames: wire.input.slice(inputBase).length,
                },
            );
            samples.closeFailures = closeFailures;
            assertShiftCleared('close', closed);
            expect(closed.root?.height, 'closed root height').toBeCloseTo(
                844,
                3,
            );
            expect(pageErrors, 'page errors').toEqual([]);
            expect(
                consoleErrors.filter((text) =>
                    /ResizeObserver loop/.test(text),
                ),
                'no ResizeObserver loop errors',
            ).toEqual([]);
            samples.pageErrors = pageErrors;
        } finally {
            await mobile.close();
        }
    } finally {
        await test.info().attach('mobile-keyboard-shift', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B1 animation and repeat', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 390, height: 844 }, select: 'mobile' },
            'B1',
        );
        try {
            const { page, wire, errors } = harness;
            const baseline = await requireState(page, 'B1 baseline');
            expect(baseline.root?.height, 'B1 root height').toBeCloseTo(844, 3);
            expect(baseline.contentTransform, 'B1 baseline transform').toBe(
                'none',
            );
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            const stepStates: KeyboardState[] = [];
            const stepFailures: Record<string, string[]> = {};
            for (const height of [
                800.5, 700.25, 500.125, 620.375, 500.25, 500.25,
            ]) {
                const state = await keyboardSample(page, height);
                expect
                    .soft(state.kbAttribute, `B1 ${height}: shift intent`)
                    .toBe('terminal');
                expect
                    .soft(state.kbRootHeight, `B1 ${height}: captured root`)
                    .toBe('844px');
                expect
                    .soft(shiftValue(state), `B1 ${height}: shift`)
                    .toBeCloseTo(844 - height, 6);
                stepFailures[`${height}`] = assertShiftInvariants(
                    `B1 ${height}`,
                    baseline,
                    state,
                    {
                        visibleHeight: height,
                        resizeFrames: wire.resize.slice(resizeBase).length,
                        inputFrames: wire.input.slice(inputBase).length,
                    },
                );
                stepStates.push(state);
            }
            // Two identical samples in a row must not drift or refit.
            const [penultimate, last] = stepStates.slice(-2);
            expect(last.kbShift, 'B1 repeated sample shift').toBe(
                penultimate.kbShift,
            );
            expect(last.kbRootHeight, 'B1 repeated sample root').toBe(
                penultimate.kbRootHeight,
            );
            expect(last.root?.height, 'B1 repeated sample root box').toBe(
                penultimate.root?.height,
            );
            samples.steps = stepFailures;

            const closed = await keyboardSample(page, 844);
            samples.close = {
                closed,
                failures: assertShiftInvariants('B1 close', baseline, closed, {
                    visibleHeight: 844,
                    resizeFrames: wire.resize.slice(resizeBase).length,
                    inputFrames: wire.input.slice(inputBase).length,
                }),
            };
            assertShiftCleared('B1 close', closed);
            expect(closed.root?.height, 'B1 closed root').toBeCloseTo(844, 3);

            for (const cycle of [1, 2]) {
                await runKeyboardCycle({
                    label: `B1 repeat ${cycle}`,
                    page,
                    wire,
                    baseline,
                    resizeBase,
                    inputBase,
                    openHeight: 500,
                    closeHeight: 844,
                    expectedRoot: 844,
                    samples,
                });
            }
            expect(wire.resize.slice(resizeBase), 'B1 resize frames').toEqual(
                [],
            );
            expect(wire.input.slice(inputBase), 'B1 input frames').toEqual([]);
            expect(errors, 'B1 page errors').toEqual([]);
            samples.errors = errors;
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B1-animation-repeat', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B2 partial restoration', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 390, height: 844 }, select: 'mobile' },
            'B2',
        );
        try {
            const { page, wire, errors } = harness;
            const baseline = await requireState(page, 'B2 baseline');
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            const limits = (visibleHeight: number) => ({
                visibleHeight,
                resizeFrames: wire.resize.slice(resizeBase).length,
                inputFrames: wire.input.slice(inputBase).length,
            });
            samples.open = await runKeyboardCycle({
                label: 'B2 open',
                page,
                wire,
                baseline,
                resizeBase,
                inputBase,
                openHeight: 500,
                closeHeight: 844,
                expectedRoot: 844,
                samples,
            });

            const partial = await keyboardSample(page, 780);
            const partialFailures = assertShiftInvariants(
                'B2 partial',
                baseline,
                partial,
                limits(780),
            );
            expect
                .soft(partial.kbAttribute, 'B2 partial: intent retained')
                .toBe('terminal');
            expect
                .soft(partial.kbRootHeight, 'B2 partial: captured root')
                .toBe('844px');
            expect
                .soft(shiftValue(partial), 'B2 partial: shift')
                .toBeCloseTo(64, 6);
            expect
                .soft(partial.root?.height, 'B2 partial: root height')
                .toBeCloseTo(844, 3);
            expect
                .soft(partial.content?.bottom, 'B2 partial: stack bottom')
                .toBeCloseTo(780, 3);
            samples.partial = { partial, partialFailures };

            const reopened = await keyboardSample(page, 500);
            samples.reopened = {
                state: reopened,
                failures: assertShiftInvariants(
                    'B2 reopened',
                    baseline,
                    reopened,
                    limits(500),
                ),
            };
            expect
                .soft(shiftValue(reopened), 'B2 reopened: shift')
                .toBeCloseTo(344, 6);

            const closed = await keyboardSample(page, 844);
            samples.close = {
                state: closed,
                failures: assertShiftInvariants(
                    'B2 close',
                    baseline,
                    closed,
                    limits(844),
                ),
            };
            assertShiftCleared('B2 close', closed);
            expect(wire.resize.slice(resizeBase), 'B2 resize frames').toEqual(
                [],
            );
            expect(wire.input.slice(inputBase), 'B2 input frames').toEqual([]);
            expect(errors, 'B2 page errors').toEqual([]);
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B2-partial-restoration', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B3 smaller layout baseline', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 390, height: 844 }, select: 'mobile' },
            'B3',
        );
        try {
            const { page, wire, errors } = harness;
            const baseline = await requireState(page, 'B3 baseline');
            expect(
                baseline.root?.height,
                'B3 baseline root height',
            ).toBeCloseTo(844, 3);
            const opened = await keyboardSample(page, 500);
            expect(opened.kbAttribute, 'B3 open intent').toBe('terminal');
            expect(opened.kbRootHeight, 'B3 open root').toBe('844px');
            samples.opened = opened;

            // A real layout shrink is not a keyboard sample: it clears the
            // old capture and the next valid sample seeds the new baseline.
            await page.setViewportSize({ width: 390, height: 780 });
            await expectShiftClearedEventually(page, 'B3 layout shrink');
            await keyboardSample(page, 780, 780);
            // No waitForGrid here: this base suppresses same-width
            // height-only fits, so the frozen grid stays frozen after the
            // legitimate layout shrink. That policy is not this change's.
            const shrunken = await waitForQuietCounters(
                page,
                'B3 shrunk baseline',
            );
            expect
                .soft(shrunken.root?.height, 'B3 shrunk root height')
                .toBeCloseTo(780, 3);
            expect
                .soft(shrunken.kbAttribute, 'B3 shrunk: no capture')
                .toBeNull();
            samples.shrunken = shrunken;

            // Counters start after the legitimate layout change settled.
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            // The frozen grid may already overhang after the legitimate
            // shrink; the keyboard must not add to it.
            const baselineOverhang =
                (shrunken.screen?.bottom ?? Number.NaN) -
                (shrunken.composer?.top ?? Number.NaN);
            await runKeyboardCycle({
                label: 'B3 re-capture',
                page,
                wire,
                baseline: shrunken,
                resizeBase,
                inputBase,
                openHeight: 500,
                closeHeight: 780,
                expectedRoot: 780,
                samples,
                overhangLimit: baselineOverhang,
            });
            expect(wire.resize.slice(resizeBase), 'B3 resize frames').toEqual(
                [],
            );
            expect(wire.input.slice(inputBase), 'B3 input frames').toEqual([]);
            expect(errors, 'B3 page errors').toEqual([]);
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B3-smaller-layout', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B4 width reset and page restore', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 390, height: 844 }, select: 'mobile' },
            'B4',
        );
        try {
            const { page, wire, errors } = harness;
            const opened = await keyboardSample(page, 500);
            expect(opened.kbAttribute, 'B4 open intent').toBe('terminal');
            expect(opened.kbRootHeight, 'B4 open root').toBe('844px');

            // A real width change is not a keyboard sample: it drops the
            // old capture and the width-driven fit is legitimate.
            await page.setViewportSize({ width: 844, height: 390 });
            await setVisualHeight(page, 390);
            await expectShiftClearedEventually(page, 'B4 rotate');
            await waitForGrid(page, 'B4 rotated');
            await waitForSettledGrid(page, 'B4 rotated settled');
            const rotated = await waitForQuietCounters(
                page,
                'B4 rotated baseline',
            );
            expect
                .soft(rotated.root?.height, 'B4 rotated root height')
                .toBeCloseTo(390, 3);
            expect
                .soft(rotated.kbAttribute, 'B4 rotated: no capture')
                .toBeNull();
            samples.rotated = rotated;

            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            const reopened = await keyboardSample(page, 250);
            expect
                .soft(reopened.kbAttribute, 'B4 reopened: intent')
                .toBe('terminal');
            expect
                .soft(reopened.kbRootHeight, 'B4 reopened: captured root')
                .toBe('390px');
            expect
                .soft(shiftValue(reopened), 'B4 reopened: shift')
                .toBeCloseTo(140, 6);
            samples.reopened = {
                state: reopened,
                failures: assertShiftInvariants(
                    'B4 reopened',
                    rotated,
                    reopened,
                    {
                        visibleHeight: 250,
                        resizeFrames: wire.resize.slice(resizeBase).length,
                        inputFrames: wire.input.slice(inputBase).length,
                    },
                ),
            };

            // pageshow invalidates the baseline instead of reviving it.
            await page.evaluate(() =>
                window.dispatchEvent(
                    new PageTransitionEvent('pageshow', { persisted: true }),
                ),
            );
            await expectShiftClearedEventually(page, 'B4 pageshow');
            const afterPageShow = await requireState(page, 'B4 pageshow');
            expect
                .soft(afterPageShow.kbAttribute, 'B4 pageshow: no capture')
                .toBeNull();
            expect
                .soft(afterPageShow.root?.height, 'B4 pageshow: live root')
                .toBeCloseTo(250, 3);
            assertShiftCleared('B4 pageshow', afterPageShow);
            samples.pageshow = afterPageShow;

            const closed = await keyboardSample(page, 390);
            expect
                .soft(closed.root?.height, 'B4 closed root height')
                .toBeCloseTo(390, 3);
            assertShiftCleared('B4 close', closed);

            // Fresh cycle after the explicit pageshow fit settled.
            await waitForSettledGrid(page, 'B4 fresh');
            const fresh = await waitForQuietCounters(page, 'B4 fresh baseline');
            const resizeBase2 = wire.resize.length;
            const inputBase2 = wire.input.length;
            await runKeyboardCycle({
                label: 'B4 fresh cycle',
                page,
                wire,
                baseline: fresh,
                resizeBase: resizeBase2,
                inputBase: inputBase2,
                openHeight: 250,
                closeHeight: 390,
                expectedRoot: 390,
                samples,
            });
            expect(
                wire.resize.slice(resizeBase2),
                'B4 fresh resize frames',
            ).toEqual([]);
            expect(
                wire.input.slice(inputBase2),
                'B4 fresh input frames',
            ).toEqual([]);
            expect(errors, 'B4 page errors').toEqual([]);
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B4-width-reset', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B5 tablets', async ({ browser, request }) => {
    test.setTimeout(180_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);

        const portrait = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 820, height: 1180 }, select: 'dispatch' },
            'B5 portrait',
        );
        try {
            const { page, wire, errors } = portrait;
            const caps = await capabilities(page);
            samples.portraitCaps = caps;
            expect(caps.coarse, 'B5 portrait: coarse pointer').toBe(true);
            expect(
                caps.compact,
                'B5 portrait: outside the compact media query',
            ).toBe(false);
            const baseline = await requireState(page, 'B5 portrait baseline');
            expect(baseline.root?.height).toBeCloseTo(1180, 3);
            expect(baseline.content?.left).toBeCloseTo(0, 3);
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            const cycle = await runKeyboardCycle({
                label: 'B5 portrait cycle',
                page,
                wire,
                baseline,
                resizeBase,
                inputBase,
                openHeight: 750,
                closeHeight: 1180,
                expectedRoot: 1180,
                samples,
            });
            expect
                .soft(
                    cycle.opened.contentTransform,
                    'B5 portrait: content shifted outside the compact query',
                )
                .not.toBe('none');
            expect
                .soft(cycle.opened.root?.height, 'B5 portrait: root held')
                .toBeCloseTo(1180, 3);
            expect(errors, 'B5 portrait page errors').toEqual([]);
        } finally {
            await portrait.context.close();
        }

        const landscape = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 1366, height: 1024 }, select: 'desktop' },
            'B5 landscape',
        );
        try {
            const { page, wire, errors } = landscape;
            const caps = await capabilities(page);
            samples.landscapeCaps = caps;
            expect(caps.coarse, 'B5 landscape: coarse pointer').toBe(true);
            const baseline = await requireState(page, 'B5 landscape baseline');
            expect(baseline.root?.height).toBeCloseTo(1024, 3);
            expect(
                baseline.content?.left ?? 0,
                'B5 landscape: docked sidebar shifts content right',
            ).toBeGreaterThan(0);
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            const cycle = await runKeyboardCycle({
                label: 'B5 landscape cycle',
                page,
                wire,
                baseline,
                resizeBase,
                inputBase,
                openHeight: 700,
                closeHeight: 1024,
                expectedRoot: 1024,
                samples,
            });
            // I8 already checks both sink axes; this pins the premise.
            expect(
                cycle.opened.kbContentLeft,
                'B5 landscape: horizontal sink compensation',
            ).not.toBe('0px');
            expect(errors, 'B5 landscape page errors').toEqual([]);
        } finally {
            await landscape.context.close();
        }
    } finally {
        await test.info().attach('B5-tablets', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

function expectSinkAtBaseline(
    label: string,
    baseline: KeyboardState,
    current: KeyboardState,
) {
    // Both axes: a vertical-only transform still moves a fixed sink.
    expect
        .soft(current.sink?.left, `${label}: sink x`)
        .toBeCloseTo(baseline.sink?.left ?? Number.NaN, 6);
    expect
        .soft(current.sink?.top, `${label}: sink y`)
        .toBeCloseTo(baseline.sink?.top ?? Number.NaN, 6);
    expect
        .soft(current.sink?.width, `${label}: sink width`)
        .toBeCloseTo(baseline.sink?.width ?? Number.NaN, 6);
    expect
        .soft(current.sink?.height, `${label}: sink height`)
        .toBeCloseTo(baseline.sink?.height ?? Number.NaN, 6);
}

/**
 * The coordinate observer writes only custom properties, so it must never
 * report a ResizeObserver loop. That error is a console message, not a page
 * error, so it needs its own guard.
 */
function expectNoObserverLoop(harness: Harness, label: string) {
    expect
        .soft(
            harness.consoleErrors.filter((text) =>
                /ResizeObserver loop/.test(text),
            ),
            `${label}: no ResizeObserver loop errors`,
        )
        .toEqual([]);
}

/** A visual-only sample for shells that must never shift. */
async function visualOnlySample(page: Page, visualHeight: number) {
    await setVisualHeight(page, visualHeight);
    await settleComposer(page);
    return requireState(page, `visual ${visualHeight}`);
}

test('B6 live HTML gate and overlays', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 390, height: 844 }, select: 'mobile' },
            'B6',
        );
        try {
            const { page, errors } = harness;
            const baseline = await requireState(page, 'B6 baseline');
            const opened = await keyboardSample(page, 500);
            expect(opened.kbAttribute, 'B6 intent').toBe('terminal');
            expect(opened.kbRootHeight, 'B6 captured root').toBe('844px');
            expect(
                opened.contentTransform,
                'B6 terminal: content shifted',
            ).not.toBe('none');
            expectSinkAtBaseline('B6 terminal', baseline, opened);

            // An HTML tab closes the CSS gate but keeps the intent. No
            // viewport event may be needed to switch tabs.
            await page.locator('#header-kanban-btn').dispatchEvent('click');
            await expect(page.locator('#term-kanban-board')).toHaveClass(
                /active/,
            );
            await expectRootHeight(page, 500, 'B6 board');
            const board = await requireState(page, 'B6 board');
            expect
                .soft(board.kbAttribute, 'B6 board: intent retained')
                .toBe('terminal');
            expect
                .soft(board.kbRootHeight, 'B6 board: captured root kept')
                .toBe('844px');
            expect
                .soft(board.contentTransform, 'B6 board: transform off')
                .toBe('none');
            expect
                .soft(board.root?.height, 'B6 board: root follows live height')
                .toBeCloseTo(500, 3);
            samples.board = board;

            await page
                .locator('.tab[data-pane-id="t1"]')
                .dispatchEvent('click');
            await expect(page.locator('#term-t1')).toHaveClass(/active/);
            await expectRootHeight(page, 844, 'B6 back');
            const back = await requireState(page, 'B6 back');
            expect
                .soft(back.contentTransform, 'B6 back: shifted again')
                .not.toBe('none');
            expect.soft(back.kbShift, 'B6 back: shift').toBe('344px');
            expect
                .soft(back.root?.height, 'B6 back: root held')
                .toBeCloseTo(844, 3);
            expect
                .soft(back.content?.bottom, 'B6 back: stack bottom')
                .toBeCloseTo(500, 3);
            expectSinkAtBaseline('B6 back', baseline, back);
            samples.back = back;

            // Overlays keep the live visible height, not the captured root.
            await page.locator('#header-config-pill').dispatchEvent('click');
            await expect(page.locator('.settings-overlay')).toBeVisible();
            await settleComposer(page);
            const settingsState = await requireState(page, 'B6 settings');
            const overlay = await elementBox(page, '.settings-overlay');
            expect
                .soft(settingsState.vvHeight, 'B6 settings: live visible var')
                .toBe('500px');
            expect
                .soft(settingsState.kbRootHeight, 'B6 settings: captured root')
                .toBe('844px');
            expect
                .soft(settingsState.root?.height, 'B6 settings: terminal root')
                .toBeCloseTo(844, 3);
            expect
                .soft(overlay?.top, 'B6 settings: overlay top')
                .toBeCloseTo(0, 3);
            samples.settings = { settingsState, overlay };
            await page.locator('.settings-overlay .modal-close-btn').click();
            await expect(page.locator('.settings-overlay')).toBeHidden();

            const headerBefore = await elementBox(page, '.app-header');
            await page.locator('#mobile-sidebar-toggle').click();
            await expect(page.locator('#sidebar-panel')).toHaveClass(
                /drawer-open/,
            );
            const sidebar = await elementBox(page, '#sidebar-panel');
            expect
                .soft(sidebar?.top, 'B6 sidebar: header bottom')
                .toBeCloseTo(headerBefore?.bottom ?? Number.NaN, 3);
            expect
                .soft(
                    Math.abs((sidebar?.bottom ?? Number.NaN) - 500),
                    'B6 sidebar: live visible bottom (within 1px)',
                )
                .toBeLessThanOrEqual(PIXEL_TOLERANCE);
            const withDrawer = await requireState(page, 'B6 sidebar');
            expect
                .soft(withDrawer.root?.height, 'B6 sidebar: terminal root')
                .toBeCloseTo(844, 3);
            samples.sidebar = { sidebar, header: headerBefore, withDrawer };
            await page.locator('#mobile-sidebar-toggle').click();
            await expect(page.locator('#sidebar-panel')).not.toHaveClass(
                /drawer-open/,
            );

            const settled = await requireState(page, 'B6 settled');
            expect
                .soft(settled.root?.height, 'B6 end: root held')
                .toBeCloseTo(844, 3);
            expect.soft(settled.kbShift, 'B6 end: shift').toBe('344px');
            expectSinkAtBaseline('B6 end', baseline, settled);
            expect(errors, 'B6 page errors').toEqual([]);
            expectNoObserverLoop(harness, 'B6');
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B6-html-gate-overlays', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B7 shell exclusions', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);

        const fine = await openHarness(
            browser,
            phi.url,
            {
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                select: 'desktop',
            },
            'B7 fine',
        );
        try {
            const { page, wire, errors } = fine;
            const caps = await capabilities(page);
            samples.fineCaps = caps;
            expect(caps.coarse, 'B7 fine: fine pointer').toBe(false);
            const baseline = await requireState(page, 'B7 fine baseline');
            expect(baseline.root?.height).toBeCloseTo(900, 3);
            expect(baseline.vvHeight, 'B7 fine: no visible var').toBe('');
            const resizeBase = wire.resize.length;
            const opened = await visualOnlySample(page, 500);
            const closed = await visualOnlySample(page, 844);
            for (const [label, state] of [
                ['open', opened],
                ['close', closed],
            ] as const) {
                expect
                    .soft(state.kbAttribute, `B7 fine ${label}: no intent`)
                    .toBeNull();
                expect
                    .soft(state.kbRootHeight, `B7 fine ${label}: root var`)
                    .toBe('');
                expect
                    .soft(state.kbShift, `B7 fine ${label}: shift var`)
                    .toBe('');
                expect
                    .soft(state.contentTransform, `B7 fine ${label}: transform`)
                    .toBe('none');
                expect
                    .soft(state.vvHeight, `B7 fine ${label}: no visible var`)
                    .toBe('');
                expect
                    .soft(state.root?.height, `B7 fine ${label}: root height`)
                    .toBeCloseTo(900, 3);
            }
            expect(
                wire.resize.slice(resizeBase),
                'B7 fine resize frames',
            ).toEqual([]);
            expect(errors, 'B7 fine page errors').toEqual([]);
            samples.fine = { baseline, opened, closed };
        } finally {
            await fine.context.close();
        }

        const embed = await openHarness(
            browser,
            phi.url,
            {
                viewport: { width: 390, height: 844 },
                query: '?desktop',
                select: 'dispatch',
            },
            'B7 desktop embed',
        );
        try {
            const { page, wire, errors } = embed;
            const caps = await capabilities(page);
            samples.embedCaps = caps;
            expect(caps.coarse, 'B7 embed: coarse pointer').toBe(true);
            const baseline = await requireState(page, 'B7 embed baseline');
            expect(baseline.root?.height).toBeCloseTo(844, 3);
            expect(baseline.vvHeight, 'B7 embed: no visible var').toBe('');
            const resizeBase = wire.resize.length;
            const opened = await visualOnlySample(page, 500);
            const closed = await visualOnlySample(page, 844);
            for (const [label, state] of [
                ['open', opened],
                ['close', closed],
            ] as const) {
                expect
                    .soft(state.kbAttribute, `B7 embed ${label}: no intent`)
                    .toBeNull();
                expect
                    .soft(state.kbRootHeight, `B7 embed ${label}: root var`)
                    .toBe('');
                expect
                    .soft(state.kbShift, `B7 embed ${label}: shift var`)
                    .toBe('');
                expect
                    .soft(
                        state.contentTransform,
                        `B7 embed ${label}: transform`,
                    )
                    .toBe('none');
                expect
                    .soft(state.vvHeight, `B7 embed ${label}: no visible var`)
                    .toBe('');
                expect
                    .soft(state.root?.height, `B7 embed ${label}: root height`)
                    .toBeCloseTo(844, 3);
            }
            expect(
                wire.resize.slice(resizeBase),
                'B7 embed resize frames',
            ).toEqual([]);
            expect(errors, 'B7 embed page errors').toEqual([]);
            samples.embed = { baseline, opened, closed };
        } finally {
            await embed.context.close();
        }
    } finally {
        await test.info().attach('B7-shell-exclusions', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B8 missing visualViewport', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            {
                viewport: { width: 390, height: 844 },
                select: 'mobile',
                absentVisualViewport: true,
            },
            'B8',
        );
        try {
            const { page, wire, errors } = harness;
            const caps = await capabilities(page);
            samples.caps = caps;
            expect(caps.hasVisualViewport, 'B8: no visualViewport').toBe(false);
            expect(caps.coarse, 'B8: coarse pointer').toBe(true);
            const baseline = await requireState(page, 'B8 baseline');
            expect(baseline.kbAttribute, 'B8 baseline: no intent').toBeNull();
            expect(baseline.vvHeight, 'B8 baseline: fallback var').toBe(
                '844px',
            );
            expect(baseline.root?.height).toBeCloseTo(844, 3);

            await page.setViewportSize({ width: 390, height: 700 });
            await expectRootHeight(page, 700, 'B8 fallback');
            await expect
                .poll(
                    () =>
                        page.evaluate(() =>
                            document.documentElement.style.getPropertyValue(
                                '--vv-height',
                            ),
                        ),
                    { timeout: 15_000, message: 'B8 --vv-height 700px' },
                )
                .toBe('700px');
            await settleComposer(page);
            const fallback = await requireState(page, 'B8 fallback');
            expect
                .soft(fallback.kbAttribute, 'B8 fallback: no intent')
                .toBeNull();
            expect
                .soft(fallback.kbRootHeight, 'B8 fallback: root var')
                .toBe('');
            expect.soft(fallback.kbShift, 'B8 fallback: shift var').toBe('');
            expect
                .soft(fallback.contentTransform, 'B8 fallback: transform')
                .toBe('none');
            expect
                .soft(fallback.root?.height, 'B8 fallback: root follows')
                .toBeCloseTo(700, 3);
            expect
                .soft(fallback.vvHeight, 'B8 fallback: visible var')
                .toBe('700px');
            samples.fallback = { baseline, fallback };
            expect(errors, 'B8 page errors').toEqual([]);
            expect(wire.resize.length).toBeGreaterThan(0);
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B8-missing-visual-viewport', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B9 offline keyboard', async ({ browser, request }) => {
    test.setTimeout(180_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    // Routed sockets are invisible to page.on('websocket'), so this test
    // decodes the client frames it forwards itself.
    const counters: WireCounters = { resize: [], input: [] };
    const routed: {
        client: WebSocketRoute | null;
        server: WebSocketRoute | null;
        sockets: number;
    } = { client: null, server: null, sockets: 0 };
    try {
        phi = await startGeometryFixture({ auto_reconnect: 'off' });
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            {
                viewport: { width: 390, height: 844 },
                select: 'mobile',
                beforeGoto: async (page) => {
                    await page.routeWebSocket(
                        (url) => url.pathname === '/ws/pane/t1',
                        (clientRoute) => {
                            routed.sockets++;
                            routed.client = clientRoute;
                            const serverRoute = clientRoute.connectToServer();
                            routed.server = serverRoute;
                            clientRoute.onMessage((message) => {
                                if (typeof message !== 'string') {
                                    try {
                                        const frame = ClientCodec.decode(
                                            new Uint8Array(message),
                                        );
                                        const payload = frame.payload;
                                        if (payload?.$case === 'resize') {
                                            counters.resize.push({
                                                cols: payload.value.cols ?? 0,
                                                rows: payload.value.rows ?? 0,
                                            });
                                        } else if (payload?.$case === 'input') {
                                            counters.input.push(
                                                Buffer.from(
                                                    payload.value,
                                                ).toString('utf8'),
                                            );
                                        }
                                    } catch {
                                        /* non-terminal frames */
                                    }
                                }
                                serverRoute.send(message);
                            });
                            serverRoute.onMessage((message) =>
                                clientRoute.send(message),
                            );
                        },
                    );
                },
            },
            'B9',
        );
        const context = harness.context;
        try {
            const { page, errors } = harness;
            expect(routed.sockets, 'B9: one routed socket').toBe(1);
            expect(
                counters.resize.length,
                'B9: initial decoded resize from the route',
            ).toBeGreaterThan(0);

            // setOffline alone does not close an existing WebSocket.
            await context.setOffline(true);
            await routed.client?.close().catch(() => {});
            await routed.server?.close().catch(() => {});
            await expect(page.locator('#term-t1 .reconnect-btn')).toBeVisible({
                timeout: 10_000,
            });
            await settleComposer(page);
            // The reconnect banner is a real layout change, so let any
            // legitimate fit settle before the keyboard baseline.
            const baseline = await waitForQuietCounters(
                page,
                'B9 offline baseline',
            );
            expect(
                baseline.kbAttribute,
                'B9 baseline: no shift yet',
            ).toBeNull();
            const resizeBase = counters.resize.length;
            const inputBase = counters.input.length;
            const socketsBase = routed.sockets;
            // The offline banner legitimately shrank the panel while the
            // same-width height-only fit stayed suppressed, so the baseline
            // grid may already overhang. The keyboard must not add to it.
            const baselineOverhang =
                (baseline.screen?.bottom ?? Number.NaN) -
                (baseline.composer?.top ?? Number.NaN);

            await runKeyboardCycle({
                label: 'B9 offline cycle',
                page,
                wire: counters,
                baseline,
                resizeBase,
                inputBase,
                openHeight: 500,
                closeHeight: 844,
                expectedRoot: 844,
                samples,
                overhangLimit: baselineOverhang,
            });
            expect(
                routed.sockets,
                'B9: no connection attempts while offline',
            ).toBe(socketsBase);
            expect(
                counters.resize.slice(resizeBase),
                'B9 resize frames',
            ).toEqual([]);
            expect(counters.input.slice(inputBase), 'B9 input frames').toEqual(
                [],
            );
            expect(errors, 'B9 page errors').toEqual([]);
        } finally {
            await context.setOffline(false).catch(() => {});
            await context.close();
        }
    } finally {
        await test.info().attach('B9-offline-keyboard', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('B10 moving content origin', async ({ browser, request }) => {
    test.setTimeout(180_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const harness = await openHarness(
            browser,
            phi.url,
            { viewport: { width: 1366, height: 1024 }, select: 'desktop' },
            'B10',
        );
        try {
            const { page, wire, errors } = harness;
            const baseline = await requireState(page, 'B10 baseline');
            expect(
                baseline.content?.left ?? 0,
                'B10 baseline: docked sidebar',
            ).toBeGreaterThan(0);
            const opened = await keyboardSample(page, 700);
            expect(opened.kbRootHeight, 'B10 open: captured root').toBe(
                '1024px',
            );
            expect(opened.kbShift, 'B10 open: shift').toBe('324px');
            expectSinkAtBaseline('B10 open', baseline, opened);
            samples.open = opened;
            const openLeft = opened.content?.left ?? 0;

            const contentLeft = async () =>
                (await elementBox(page, '.terminal-content'))?.left ??
                Number.NaN;
            // The write is synchronous with the layout change, but the sink
            // converges only after the observer's coordinate update ran.
            // Poll the invariant itself; a fixed delay would hide a miss.
            const expectSinkConverged = async (label: string) => {
                await expect
                    .poll(
                        async () => {
                            const sink = (await requireState(page, label)).sink;
                            return Math.max(
                                Math.abs(
                                    (sink?.left ?? Number.NaN) -
                                        (baseline.sink?.left ?? Number.NaN),
                                ),
                                Math.abs(
                                    (sink?.top ?? Number.NaN) -
                                        (baseline.sink?.top ?? Number.NaN),
                                ),
                            );
                        },
                        {
                            timeout: 15_000,
                            message: `${label}: sink returns to its screen origin`,
                        },
                    )
                    .toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
            };
            const assertHeld = async (label: string) => {
                await expectSinkConverged(label);
                const state = await requireState(page, label);
                expect
                    .soft(state.root?.height, `${label}: root held`)
                    .toBeCloseTo(1024, 3);
                expect
                    .soft(state.kbRootHeight, `${label}: captured root`)
                    .toBe('1024px');
                expect
                    .soft(state.kbShift, `${label}: shift held`)
                    .toBe('324px');
                expect
                    .soft(state.content?.bottom, `${label}: stack bottom`)
                    .toBeCloseTo(700, 3);
                expectSinkAtBaseline(label, baseline, state);
                console.log(
                    `${label}: ${JSON.stringify({
                        content: state.content,
                        sink: state.sink,
                        contentLeft: state.kbContentLeft,
                        contentTop: state.kbContentTop,
                    })}`,
                );
                samples[label] = state;
                return state;
            };

            // Docked sidebar collapse: content left changes, the sink must
            // stay on its closed screen origin through the coordinate write.
            await page
                .locator('#desktop-sidebar-toggle')
                .dispatchEvent('click');
            await expect
                .poll(contentLeft, {
                    timeout: 15_000,
                    message: 'B10 collapsed: content left moved',
                })
                .not.toBeCloseTo(openLeft, 1);
            await assertHeld('B10 collapsed');
            // The toggle moves into the tab bar's restore slot when collapsed.
            await page
                .locator('#desktop-sidebar-toggle')
                .dispatchEvent('click');
            await expect
                .poll(contentLeft, {
                    timeout: 15_000,
                    message: 'B10 restored: content left back',
                })
                .toBeCloseTo(openLeft, 1);
            await assertHeld('B10 restored');

            // Real drag on the docked sidebar handle, no viewport events.
            const handle = await elementBox(page, '#left-resize-handle');
            if (!handle) throw new Error('B10: missing resize handle');
            const dragX = handle.left + handle.width / 2;
            const dragY = handle.top + handle.height / 2;
            const leftBeforeDrag = await contentLeft();
            await page.mouse.move(dragX, dragY);
            await page.mouse.down();
            await page.mouse.move(dragX + 32, dragY, { steps: 8 });
            await page.mouse.up();
            await expect
                .poll(contentLeft, {
                    timeout: 15_000,
                    message: 'B10 dragged: content left moved',
                })
                .not.toBeCloseTo(leftBeforeDrag, 1);
            await assertHeld('B10 dragged');

            const closed = await keyboardSample(page, 1024);
            assertShiftCleared('B10 close', closed);
            expect(closed.root?.height, 'B10 closed root').toBeCloseTo(1024, 3);

            // Legitimate width-driven fits happened; take a fresh baseline.
            await waitForGrid(page, 'B10 final grid');
            await waitForSettledGrid(page, 'B10 final settled');
            await settleComposer(page);
            const fresh = await waitForQuietCounters(
                page,
                'B10 fresh baseline',
            );
            expect(fresh.kbAttribute, 'B10 fresh: no capture').toBeNull();
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;
            await runKeyboardCycle({
                label: 'B10 fresh cycle',
                page,
                wire,
                baseline: fresh,
                resizeBase,
                inputBase,
                openHeight: 700,
                closeHeight: 1024,
                expectedRoot: 1024,
                samples,
            });
            expect(
                wire.resize.slice(resizeBase),
                'B10 fresh resize frames',
            ).toEqual([]);
            expect(
                wire.input.slice(inputBase),
                'B10 fresh input frames',
            ).toEqual([]);
            expect(errors, 'B10 page errors').toEqual([]);
            expectNoObserverLoop(harness, 'B10');
        } finally {
            await harness.context.close();
        }
    } finally {
        await test.info().attach('B10-moving-content-origin', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});
