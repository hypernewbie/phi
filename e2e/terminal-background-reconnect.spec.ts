import {
    test,
    expect,
    type Page,
    type WebSocketRoute,
    type APIRequestContext,
} from '@playwright/test';
import { copyFileSync, writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { startPhi } from './_server.js';

interface TerminalView {
    element?: HTMLElement;
    rows: number;
    buffer: {
        active: {
            length: number;
            baseY: number;
            viewportY: number;
            getLine(
                row: number,
            ): { translateToString(trim: boolean): string } | undefined;
        };
    };
}
interface Observation {
    reconnectTerms: TerminalView[];
    reconnectToastTitles: string[];
    drainReconnectToasts: () => void;
    lateCloses: boolean;
    pendingCloses: (() => void)[];
}
async function observe(page: Page) {
    await page.addInitScript(() => {
        const capture = window as unknown as Observation;
        capture.reconnectTerms = [];
        capture.reconnectToastTitles = [];
        capture.lateCloses = false;
        capture.pendingCloses = [];
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener(
                    'close',
                    (event) => {
                        if (
                            !capture.lateCloses ||
                            !document.hidden ||
                            !new URL(this.url).pathname.startsWith('/ws/pane/')
                        )
                            return;
                        event.stopImmediatePropagation();
                        capture.pendingCloses.push(() =>
                            this.dispatchEvent(
                                new CloseEvent('close', {
                                    code: event.code,
                                    reason: event.reason,
                                    wasClean: event.wasClean,
                                }),
                            ),
                        );
                    },
                    true,
                );
            }
        };
        let ctor: new (opts: Record<string, unknown>) => TerminalView;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: typeof ctor) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.reconnectTerms.push(this);
                    }
                };
            },
        });
        const seen = new WeakSet<Element>();
        const collect = (records: MutationRecord[]) => {
            for (const record of records)
                for (const node of record.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    const toasts = [...node.querySelectorAll('.toast')];
                    if (node.matches('.toast')) toasts.push(node);
                    for (const toast of toasts)
                        if (!seen.has(toast)) {
                            seen.add(toast);
                            capture.reconnectToastTitles.push(
                                toast.querySelector('.toast-title')
                                    ?.textContent ?? '',
                            );
                        }
                }
        };
        const observer = new MutationObserver(collect);
        observer.observe(document, { childList: true, subtree: true });
        capture.drainReconnectToasts = () => collect(observer.takeRecords());
    });
}
async function screen(page: Page, pane: string) {
    return page.evaluate((id) => {
        const term = (window as unknown as Observation).reconnectTerms.find(
            (item) =>
                item.element?.closest('.term-container')?.id === `term-${id}`,
        );
        const buffer = term?.buffer.active;
        const line = (row: number) =>
            buffer?.getLine(row)?.translateToString(true) ?? '';
        const input =
            document.querySelector<HTMLTextAreaElement>('#input-textarea');
        return {
            lines: Array.from({ length: buffer?.length ?? 0 }, (_, i) =>
                line(i),
            ),
            top: line(buffer?.viewportY ?? 0),
            aboveBottom: Boolean(buffer && buffer.viewportY < buffer.baseY),
            draft: input?.value,
            start: input?.selectionStart,
            end: input?.selectionEnd,
            focused: (document.activeElement as HTMLElement)?.id,
            active: document.querySelector<HTMLElement>('.tab.active')?.dataset
                .paneId,
        };
    }, pane);
}
async function selectPane(page: Page, pane: string) {
    const tab = page.locator(`.tab[data-pane-id="${pane}"]`);
    await tab.waitFor({ state: 'attached' });
    if (page.viewportSize()!.width <= 768) {
        await page.locator('#mobile-sidebar-toggle').click();
        await page
            .locator(
                `#drawer-tabs-body [data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
            )
            .click();
    } else await tab.click();
    const drawer = page.locator('#sidebar-panel.drawer-open');
    if (await drawer.count())
        await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator(`#term-${pane}`)).toBeVisible();
}
async function sendUI(page: Page, command: string) {
    if (!(await page.locator('#input-textarea').isVisible()))
        await page.locator('#direct-mode-toggle').click();
    await page.locator('#input-textarea').fill(command);
    await page.locator('#send-input-btn').click();
}
async function recorded(request: APIRequestContext, url: string, pane: string) {
    const response = await request.get(
        `${url}/api/terminals/${encodeURIComponent(pane)}/recording?from=0&through=18446744073709551615`,
    );
    expect(response.status()).toBe(200);
    const body = await response.body();
    expect(body.length).toBeGreaterThanOrEqual(4);
    const headerSize = body.readUInt32BE(0);
    expect(headerSize).toBeGreaterThan(0);
    expect(headerSize + 4).toBeLessThanOrEqual(body.length);
    const header = JSON.parse(
        body.subarray(4, headerSize + 4).toString('utf8'),
    ) as { start: number; end: number };
    expect(header.start).toBe(0);
    expect(header.end).toBeLessThan(2 * 1024 * 1024);
    return stripVTControlCharacters(
        body.subarray(headerSize + 4).toString('utf8'),
    )
        .replaceAll('\r', '')
        .split('\n');
}
async function visibility(page: Page, hidden: boolean) {
    await page.evaluate((value) => {
        Object.defineProperty(document, 'hidden', {
            value,
            configurable: true,
        });
        Object.defineProperty(document, 'visibilityState', {
            value: value ? 'hidden' : 'visible',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        if (!value)
            for (const event of ['focus', 'pageshow', 'online'])
                window.dispatchEvent(new Event(event));
    }, hidden);
}

for (const mobile of [false, true]) {
    for (const scenario of [
        'normal',
        'reject',
        'slow',
        'late-close',
        'off-manual',
        ...(!mobile ? ['desktop-wake', 'desktop-off'] : []),
    ]) {
        test(`synthetic visibility ${scenario} restores all panes without changing reader/input state @${mobile ? 'mobile' : 'desktop'}`, async ({
            browser,
            browserName,
        }, testInfo) => {
            const phi = await startPhi({
                config: {
                    auto_reconnect: scenario.includes('off')
                        ? 'off'
                        : 'visible',
                },
            });
            const context = await browser.newContext({
                viewport: mobile
                    ? { width: 390, height: 844 }
                    : { width: 1440, height: 900 },
                ...(mobile ? { isMobile: true, hasTouch: true } : {}),
            });
            const page = await context.newPage();
            const sockets = new Map<
                string,
                { client: WebSocketRoute; backend?: WebSocketRoute }[]
            >();
            let faultEnabled = false;
            let delayed = 0;
            let released = false;
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error' || message.type() === 'warning')
                    console.log(
                        `BROWSER ${message.type()}: ${message.text()} ${message.location().url}`,
                    );
            });
            try {
                const panes: string[] = [];
                for (let i = 0; i < 3; i++) {
                    const response = await context.request.post(
                        `${phi.url}/api/terminals`,
                        { data: { coder: 'bash', cwd: phi.dir } },
                    );
                    expect(response.ok()).toBe(true);
                    panes.push(
                        ((await response.json()) as { pane_id: string })
                            .pane_id,
                    );
                }
                await observe(page);
                await page.routeWebSocket('**/ws/pane/**', async (socket) => {
                    const id = new URL(socket.url()).pathname
                        .split('/')
                        .at(-1)!;
                    const entries = sockets.get(id) ?? [];
                    const rejected =
                        faultEnabled &&
                        scenario === 'reject' &&
                        entries.length < 3;
                    entries.push({
                        client: socket,
                        backend: rejected
                            ? undefined
                            : socket.connectToServer(),
                    });
                    sockets.set(id, entries);
                    if (rejected)
                        await socket.close({
                            code: 1011,
                            reason: 'controlled transient rejection',
                        });
                });
                await page.route(
                    (url) =>
                        url.pathname.startsWith('/api/terminals/') &&
                        url.pathname.endsWith('/recording'),
                    async (route) => {
                        if (faultEnabled && scenario === 'slow') {
                            delayed++;
                            await new Promise((resolve) =>
                                setTimeout(resolve, 2000),
                            );
                            released = true;
                        }
                        await route.continue();
                    },
                );
                await page.goto(
                    `${phi.url}/?pane=${panes[0]}${scenario.startsWith('desktop-') ? '&desktop=1' : ''}`,
                );
                for (const pane of panes) {
                    await selectPane(page, pane);
                    await sendUI(page, 'echo READY');
                    await expect
                        .poll(async () => (await screen(page, pane)).lines, {
                            timeout: 30000,
                        })
                        .toContain('READY');
                    expect(sockets.get(pane)).toHaveLength(1);
                }
                await selectPane(page, panes[0]);
                await sendUI(page, 'seq 1 160');
                await expect
                    .poll(async () => (await screen(page, panes[0])).lines)
                    .toContain('160');
                const area = await page
                    .locator(`#term-${panes[0]} .xterm-screen`)
                    .boundingBox();
                expect(area).not.toBeNull();
                await page.mouse.move(
                    area!.x + area!.width / 2,
                    area!.y + area!.height / 2,
                );
                // Playwright cannot send native wheel input to mobile WebKit.
                if (mobile && browserName === 'webkit')
                    await page
                        .locator(`#term-${panes[0]} .xterm-screen`)
                        .dispatchEvent('wheel', { deltaY: -400 });
                else await page.mouse.wheel(0, -400);
                await expect
                    .poll(
                        async () => (await screen(page, panes[0])).aboveBottom,
                    )
                    .toBe(true);
                const input = page.locator('#input-textarea');
                await input.fill('draft survives recovery');
                await input.focus();
                await input.evaluate((element: HTMLTextAreaElement) =>
                    element.setSelectionRange(2, 8),
                );
                // Capture the reader only after input layout and scrolling settle.
                await expect
                    .poll(() =>
                        page.evaluate(async (id) => {
                            await document.fonts.ready;
                            const term = (
                                window as unknown as Observation
                            ).reconnectTerms.find(
                                (item) =>
                                    item.element?.closest('.term-container')
                                        ?.id === `term-${id}`,
                            )!;
                            const positions: string[] = [];
                            for (let i = 0; i < 4; i++) {
                                await new Promise<void>((resolve) =>
                                    requestAnimationFrame(() => resolve()),
                                );
                                const buffer = term.buffer.active;
                                positions.push(
                                    JSON.stringify([
                                        buffer.viewportY,
                                        buffer.baseY,
                                        term.rows,
                                    ]),
                                );
                            }
                            return positions.every(
                                (position) => position === positions[0],
                            );
                        }, panes[0]),
                    )
                    .toBe(true);
                const before = await screen(page, panes[0]);
                if (scenario === 'late-close')
                    await page.evaluate(() => {
                        (window as unknown as Observation).lateCloses = true;
                    });
                expect(before.top).not.toBe('');
                expect(before.end! - before.start!).toBeGreaterThan(0);
                await visibility(page, true);
                if (scenario.startsWith('desktop-'))
                    await page.evaluate(() => {
                        window.dispatchEvent(
                            new CustomEvent('phi:desktop-wake'),
                        );
                        window.dispatchEvent(new Event('focus'));
                    });
                for (const pane of panes.slice(0, 2)) {
                    const pair = sockets.get(pane)![0];
                    await pair.backend!.close();
                    await pair.client.close();
                }
                const recordings: string[][] = [];
                for (let i = 0; i < 2; i++) {
                    const response = await context.request.post(
                        `${phi.url}/api/terminals/${panes[i]}/input`,
                        { data: { text: `echo AWAY${i}` } },
                    );
                    expect(response.status()).toBe(204);
                    await expect
                        .poll(
                            async () => {
                                recordings[i] = await recorded(
                                    context.request,
                                    phi.url,
                                    panes[i],
                                );
                                return recordings[i];
                            },
                            { timeout: 30000 },
                        )
                        .toContain(`AWAY${i}`);
                    expect((await screen(page, panes[i])).lines).not.toContain(
                        `AWAY${i}`,
                    );
                    expect(sockets.get(panes[i])).toHaveLength(1);
                }
                writeFileSync(
                    testInfo.outputPath('away-recordings.json'),
                    JSON.stringify(recordings),
                );
                if (scenario === 'late-close')
                    await expect
                        .poll(() =>
                            page.evaluate(
                                () =>
                                    (window as unknown as Observation)
                                        .pendingCloses.length,
                            ),
                        )
                        .toBe(2);
                faultEnabled = true;
                await visibility(page, false);
                if (scenario.startsWith('desktop-'))
                    await page.evaluate(() => {
                        window.dispatchEvent(
                            new CustomEvent('phi:desktop-wake'),
                        );
                        window.dispatchEvent(new Event('focus'));
                    });
                if (scenario === 'late-close')
                    await page.evaluate(() => {
                        for (const callback of (
                            window as unknown as Observation
                        ).pendingCloses.splice(0))
                            callback();
                    });
                if (scenario.includes('off')) {
                    await input.fill(before.draft!);
                    await expect(
                        page.locator('#disconnect-banner'),
                    ).toBeVisible();
                    for (const pane of panes)
                        expect(sockets.get(pane)).toHaveLength(1);
                    await page.locator('.reconnect-all-banner-btn').click();
                }
                if (scenario === 'slow') {
                    await expect.poll(() => delayed).toBeGreaterThan(0);
                    await input.fill(`${before.draft}x`);
                    await expect(input).toHaveValue(`${before.draft}x`);
                    await input.press('Backspace');
                    await page
                        .getByRole('button', { name: 'Cmds ▾', exact: true })
                        .click();
                    await expect(
                        page.locator('#quick-commands-dropup'),
                    ).toBeVisible();
                    expect(
                        released,
                        'local typing and menu must work before the delayed response',
                    ).toBe(false);
                    await page
                        .getByRole('button', { name: 'Cmds ▾', exact: true })
                        .click();
                    await input.focus();
                    await input.evaluate((element: HTMLTextAreaElement) =>
                        element.setSelectionRange(2, 8),
                    );
                }
                for (let i = 0; i < 2; i++) {
                    await expect
                        .poll(
                            async () => (await screen(page, panes[i])).lines,
                            { timeout: 30000 },
                        )
                        .toContain(`AWAY${i}`);
                    expect(sockets.get(panes[i])).toHaveLength(
                        scenario === 'reject' ? 4 : 2,
                    );
                }
                expect(sockets.get(panes[2])).toHaveLength(1);
                let after = await screen(page, panes[0]);
                const preserved = scenario.includes('off')
                    ? (['draft', 'active'] as const)
                    : ([
                          'top',
                          'aboveBottom',
                          'draft',
                          'start',
                          'end',
                          'focused',
                          'active',
                      ] as const);
                // Parsed output can precede xterm's queued resize/anchor restore.
                await expect
                    .poll(
                        async () => {
                            after = await screen(page, panes[0]);
                            return Object.fromEntries(
                                preserved.map((key) => [key, after[key]]),
                            );
                        },
                        { timeout: 30000 },
                    )
                    .toEqual(
                        Object.fromEntries(
                            preserved.map((key) => [key, before[key]]),
                        ),
                    );
                expect(
                    (await recorded(context.request, phi.url, panes[0])).join(
                        '\n',
                    ),
                ).not.toContain(before.draft);
                for (let i = 0; i < 2; i++) {
                    await selectPane(page, panes[i]);
                    await sendUI(page, `echo NEW${i}`);
                    await expect
                        .poll(async () => (await screen(page, panes[i])).lines)
                        .toContain(`NEW${i}`);
                }
                const titles = await page.evaluate(() => {
                    const capture = window as unknown as Observation;
                    capture.drainReconnectToasts();
                    return capture.reconnectToastTitles;
                });
                expect(titles).not.toContain('Terminal disconnected');
                await expect(page.locator('#disconnect-banner')).toBeHidden();
                expect(errors).toEqual([]);
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <= innerWidth,
                    ),
                ).toBe(true);
                await page.screenshot({
                    path: testInfo.outputPath('recovered.png'),
                });
                writeFileSync(
                    testInfo.outputPath('evidence.json'),
                    JSON.stringify({
                        before,
                        after,
                        titles,
                        counts: panes.map((pane) => sockets.get(pane)?.length),
                    }),
                );
                console.log(
                    `RECOVERED ${scenario} ${mobile ? '390x844 touch' : '1440x900'}: AWAY0 AWAY1 NEW0 NEW1; sockets=${panes.map((pane) => sockets.get(pane)?.length)}; preserved=${preserved.join(',')}`,
                );
            } finally {
                try {
                    copyFileSync(
                        phi.logPath,
                        testInfo.outputPath('server.log'),
                    );
                } finally {
                    try {
                        await context.close();
                    } finally {
                        await phi.stop();
                    }
                }
            }
        });
    }
}
