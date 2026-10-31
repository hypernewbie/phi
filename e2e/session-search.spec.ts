import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { tabList } from './_tabs.js';
import { startPhi, type PhiServer } from './_server.js';

test.describe.configure({ timeout: 120_000 });

type SearchTerm = {
    element?: HTMLElement;
    cols: number;
    rows: number;
    buffer: {
        active: {
            baseY: number;
            length: number;
            viewportY: number;
            getLine(
                index: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
};

type SearchWindow = Window & { searchTerms?: SearchTerm[] };

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'search-fixture');
            writeFileSync(
                command,
                `#!/bin/sh
printf 'SEARCH-READY\\r\\n'
IFS= read -r start
i=0
while [ "$i" -lt 160 ]; do
    case "$i" in
        37|112) printf 'FIND-MATCH-%03d\\r\\n' "$i" ;;
        *) printf 'ROW-%03d\\r\\n' "$i" ;;
    esac
    i=$((i + 1))
done
while IFS= read -r line; do
    case "$line" in
        many)
            printf 'ARCHIVE-RARE-MARKER\\r\\n'
            i=0
            while [ "$i" -lt 16000 ]; do
                printf 'ARCHIVE-ROW-%05d\\r\\n' "$i"
                i=$((i + 1))
            done
            ;;
        *) printf 'PTY INPUT: %s\\r\\n' "$line" ;;
    esac
done
`,
                { mode: 0o755 },
            );
            chmodSync(command, 0o755);
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
});

test.afterAll(async () => {
    await phi?.stop();
});

async function captureSearchTerms(page: Page) {
    await page.addInitScript(() => {
        const w = window as SearchWindow;
        w.searchTerms = [];
        let Base: new (options: Record<string, unknown>) => SearchTerm;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (
                Original: new (options: Record<string, unknown>) => SearchTerm,
            ) => {
                Base = class extends Original {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.searchTerms?.push(this);
                    }
                };
            },
        });
    });
}

async function terminalBufferText(page: Page, paneId: string) {
    return page.evaluate((id: string) => {
        const terms = (window as SearchWindow).searchTerms ?? [];
        const term = terms.find(
            (candidate) =>
                candidate.element?.closest('.term-container')?.id ===
                `term-${id}`,
        );
        if (!term) return null;
        const buffer = term.buffer.active;
        return {
            baseY: buffer.baseY,
            length: buffer.length,
            viewportY: buffer.viewportY,
            cols: term.cols,
            rows: term.rows,
            text: Array.from(
                { length: buffer.length },
                (_, row) => buffer.getLine(row)?.translateToString(true) ?? '',
            ).join('\n'),
        };
    }, paneId);
}

async function terminalViewportText(page: Page, paneId: string) {
    const buffer = await terminalBufferText(page, paneId);
    return (
        buffer?.text
            .split('\n')
            .slice(buffer.viewportY, buffer.viewportY + buffer.rows)
            .join('\n') ?? ''
    );
}

async function waitForRecordedText(
    phiServer: PhiServer,
    paneId: string,
    marker = 'FIND-MATCH-037',
) {
    const endpoint = `${phiServer.url}/api/terminals/${paneId}/recording?from=0&through=1048576`;
    await expect
        .poll(
            async () => {
                const response = await fetch(endpoint);
                if (!response.ok) return '';
                return new TextDecoder().decode(await response.arrayBuffer());
            },
            { timeout: 20_000 },
        )
        .toContain(marker);
}

async function readTerminalHead(
    phiServer: PhiServer,
    paneId: string,
    request: import('@playwright/test').APIRequestContext,
) {
    const response = await request.get(
        `${phiServer.url}/api/terminals/${paneId}/recording?from=0&through=1048576`,
    );
    if (!response.ok())
        throw new Error(`terminal recording read failed: ${response.status()}`);
    const body = new Uint8Array(await response.body());
    if (body.length < 4) throw new Error('short terminal state envelope');
    const headerLength = new DataView(
        body.buffer,
        body.byteOffset,
        body.byteLength,
    ).getUint32(0);
    if (headerLength > 4096 || headerLength + 4 > body.length)
        throw new Error('invalid terminal state header');
    const header = JSON.parse(
        new TextDecoder().decode(body.subarray(4, 4 + headerLength)),
    ) as {
        epoch: number;
        end: number;
    };
    return { epoch: header.epoch, head: header.end };
}

test('Ctrl/Cmd+F searches resident terminal output without sending search keys to the PTY', async ({
    browser,
    page,
    request,
}) => {
    phi.verify();
    const piResponse = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir },
    });
    expect(piResponse.ok()).toBe(true);
    const { pane_id: piPane } = (await piResponse.json()) as {
        pane_id: string;
    };
    const shellResponse = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd: phi.dir },
    });
    expect(shellResponse.ok()).toBe(true);
    const { pane_id: shellPane } = (await shellResponse.json()) as {
        pane_id: string;
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await captureSearchTerms(page);

    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${piPane}"]`).click();
    await expect(page.locator(`#term-${piPane} .xterm`)).toBeVisible();
    await expect
        .poll(async () => (await terminalBufferText(page, piPane))?.text ?? '')
        .toContain('SEARCH-READY');
    const piStartResponse = await request.post(
        `${phi.url}/api/terminals/${piPane}/input`,
        { data: { text: 'go' } },
    );
    expect(piStartResponse.ok()).toBe(true);
    await waitForRecordedText(phi, piPane);
    await expect
        .poll(async () => (await terminalBufferText(page, piPane))?.text ?? '')
        .toContain('FIND-MATCH-112');
    await page.waitForTimeout(350);
    const piInitialViewport = await terminalViewportText(page, piPane);
    expect(piInitialViewport).not.toContain('FIND-MATCH-037');
    expect(piInitialViewport).not.toContain('FIND-MATCH-112');

    await page.locator(`#term-${piPane} .xterm-screen`).click();
    await page.keyboard.press('Control+f');
    const piFind = page.locator(`#term-${piPane} .find-bar`);
    await expect(piFind).toBeVisible();
    const piSource = piFind.locator('.find-source-select');
    await expect(piSource).toHaveValue('terminal');
    await expect(piSource.locator('option:checked')).toHaveText(
        'Loaded terminal output',
    );
    await piSource.selectOption('terminal');
    const piInput = piFind.locator('.find-input');
    await piInput.fill('FIND-MATCH-');
    await expect
        .poll(() => terminalViewportText(page, piPane))
        .toContain('FIND-MATCH-037');
    await piFind.locator('.find-input').press('Enter');
    await expect
        .poll(() => terminalViewportText(page, piPane))
        .toContain('FIND-MATCH-112');
    await piFind.locator('.find-input').press('Shift+Enter');
    await expect
        .poll(() => terminalViewportText(page, piPane))
        .toContain('FIND-MATCH-037');
    await expect
        .poll(async () => (await terminalBufferText(page, piPane))?.text ?? '')
        .not.toContain('PTY INPUT:');
    await piFind.locator('.find-input').press('Escape');
    await expect(piFind).toHaveCount(0);

    const composer = page.locator('#input-textarea');
    await composer.fill('staged draft survives search');
    await expect(composer).toBeFocused();
    await composer.press('Control+f');
    await expect(piFind.locator('.find-input')).toBeFocused();
    await expect(composer).toHaveValue('staged draft survives search');
    await piFind.locator('.find-input').press('Escape');
    await expect(piFind).toHaveCount(0);
    await expect(composer).toBeFocused();

    await page.locator(`.tab[data-pane-id="${shellPane}"]`).click();
    await expect(page.locator(`#term-${shellPane} .xterm`)).toBeVisible();
    await expect
        .poll(
            async () =>
                (await terminalBufferText(page, shellPane))?.text.trimEnd() ??
                '',
        )
        .toMatch(/[$#]$/);
    const startResponse = await request.post(
        `${phi.url}/api/terminals/${shellPane}/input`,
        { data: { text: './search-fixture' } },
    );
    expect(startResponse.ok()).toBe(true);
    await expect
        .poll(
            async () => (await terminalBufferText(page, shellPane))?.text ?? '',
        )
        .toContain('SEARCH-READY');
    const shellStartResponse = await request.post(
        `${phi.url}/api/terminals/${shellPane}/input`,
        { data: { text: 'go' } },
    );
    expect(shellStartResponse.ok()).toBe(true);
    await waitForRecordedText(phi, shellPane);
    await expect
        .poll(
            async () => (await terminalBufferText(page, shellPane))?.text ?? '',
        )
        .toContain('FIND-MATCH-112');
    await page.waitForTimeout(350);
    const shellInitialViewport = await terminalViewportText(page, shellPane);
    expect(shellInitialViewport).not.toContain('FIND-MATCH-037');
    expect(shellInitialViewport).not.toContain('FIND-MATCH-112');

    await page.locator(`#term-${shellPane} .xterm-screen`).click();
    await page.keyboard.press('Control+Shift+f');
    const shellFind = page.locator(`#term-${shellPane} .find-bar`);
    await expect(shellFind).toBeVisible();
    const shellInput = shellFind.locator('.find-input');
    await shellInput.fill('');
    const shellSource = shellFind.locator('.find-source-select');
    await shellSource.selectOption('terminal');
    await expect(shellSource).toHaveValue('terminal');
    await shellInput.fill('FIND-MATCH-');
    await expect
        .poll(() => terminalViewportText(page, shellPane))
        .toContain('FIND-MATCH-037');
    await shellFind.locator('.find-input').press('Escape');

    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);

    const mobilePiResponse = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir },
    });
    expect(mobilePiResponse.ok()).toBe(true);
    const { pane_id: mobilePiPane } = (await mobilePiResponse.json()) as {
        pane_id: string;
    };
    const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark',
    });
    try {
        const mobilePage = await mobileContext.newPage();
        await captureSearchTerms(mobilePage);
        await mobilePage.goto(phi.url);
        await mobilePage.locator('#hostname-display').tap();
        await tabList(mobilePage)
            .locator(
                `[data-pane-id="${mobilePiPane}"] .hostname-dropdown-select-btn`,
            )
            .tap();
        await expect(
            mobilePage.locator(`#term-${mobilePiPane} .xterm`),
        ).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await terminalBufferText(mobilePage, mobilePiPane))
                        ?.text ?? '',
            )
            .toContain('SEARCH-READY');
        const mobileStart = await request.post(
            `${phi.url}/api/terminals/${mobilePiPane}/input`,
            { data: { text: 'go' } },
        );
        expect(mobileStart.ok()).toBe(true);
        await waitForRecordedText(phi, mobilePiPane);
        await expect
            .poll(
                async () =>
                    (await terminalBufferText(mobilePage, mobilePiPane))
                        ?.text ?? '',
            )
            .toContain('FIND-MATCH-112');
        await mobilePage.waitForTimeout(350);
        await mobilePage.locator(`#term-${mobilePiPane} .xterm-screen`).tap();
        await mobilePage.keyboard.press('Control+f');
        const mobileFind = mobilePage.locator(
            `#term-${mobilePiPane} .find-bar`,
        );
        await expect(mobileFind).toBeVisible();
        const mobileFindInput = mobileFind.locator('.find-input');
        await mobileFindInput.tap();
        await mobilePage.keyboard.type('FIND-MATCH-');
        await expect
            .poll(() => terminalViewportText(mobilePage, mobilePiPane))
            .toContain('FIND-MATCH-037');
        expect(
            await mobilePage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        const mobileBar = await mobileFind.boundingBox();
        if (!mobileBar) throw new Error('mobile find bar has no layout box');
        expect(mobileBar.x + mobileBar.width).toBeLessThanOrEqual(390);
        await mobileFind.locator('.find-close').tap();
        await expect(mobileFind).toHaveCount(0);
    } finally {
        await mobileContext.close();
    }
});

test('served archive Worker searches a real retained recording range', async ({
    page,
    request,
}) => {
    phi.verify();
    const response = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir },
    });
    expect(response.ok()).toBe(true);
    const { pane_id: paneId } = (await response.json()) as { pane_id: string };

    await page.setViewportSize({ width: 1440, height: 900 });
    await captureSearchTerms(page);
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    await expect(page.locator(`#term-${paneId} .xterm`)).toBeVisible();
    await expect
        .poll(async () => (await terminalBufferText(page, paneId))?.text ?? '')
        .toContain('SEARCH-READY');
    const start = await request.post(
        `${phi.url}/api/terminals/${paneId}/input`,
        { data: { text: 'go' } },
    );
    expect(start.ok()).toBe(true);
    await waitForRecordedText(phi, paneId, 'FIND-MATCH-112');

    const workerScript = page.waitForResponse((candidate) =>
        candidate.url().endsWith('/terminal-search-worker.js'),
    );
    const parserScript = page.waitForResponse((candidate) =>
        candidate.url().endsWith('/vendor/xterm-headless.js'),
    );
    const result = await page.evaluate(async (id: string) => {
        type Envelope = {
            header: {
                epoch: number;
                oldest?: number;
                start?: number;
                end?: number;
                head?: number;
                ckpt?: {
                    through: number;
                    cols: number;
                    rows: number;
                    event_cursor?: string;
                };
                resizes?: Array<[number, number, number]>;
            };
            bytes: Uint8Array;
        };
        const readEnvelope = async (path: string): Promise<Envelope> => {
            const response = await fetch(path, { cache: 'no-store' });
            if (!response.ok)
                throw new Error(`fixture read failed: ${response.status}`);
            const body = new Uint8Array(await response.arrayBuffer());
            if (body.length < 4) throw new Error('short fixture envelope');
            const headerLength = new DataView(
                body.buffer,
                body.byteOffset,
                body.byteLength,
            ).getUint32(0);
            if (headerLength > 4096 || headerLength + 4 > body.length)
                throw new Error('invalid fixture envelope header');
            return {
                header: JSON.parse(
                    new TextDecoder().decode(
                        body.subarray(4, 4 + headerLength),
                    ),
                ) as Envelope['header'],
                bytes: body.slice(4 + headerLength),
            };
        };

        const base = `/api/terminals/${encodeURIComponent(id)}`;
        const recorded = await readEnvelope(
            `${base}/recording?from=0&through=1048576`,
        );
        const recordedEnd = recorded.header.end;
        if (
            typeof recordedEnd !== 'number' ||
            !Number.isSafeInteger(recordedEnd) ||
            recordedEnd <= 0
        )
            throw new Error('fixture recording has no retained bytes');
        const inheritedMarker = new TextEncoder().encode('FIND-MATCH-037');
        let inheritedOffset = -1;
        outer: for (
            let offset = 0;
            offset <= recorded.bytes.byteLength - inheritedMarker.length;
            offset++
        ) {
            for (let index = 0; index < inheritedMarker.length; index++) {
                if (recorded.bytes[offset + index] !== inheritedMarker[index])
                    continue outer;
            }
            inheritedOffset = offset;
            break;
        }
        if (inheritedOffset < 0)
            throw new Error('fixture inherited match is not in the recording');
        const checkpointThrough = inheritedOffset + inheritedMarker.length;
        const checkpoint = await readEnvelope(
            `${base}/state?epoch=${recorded.header.epoch}&through=${checkpointThrough}&kind=ansi-v1`,
        );
        const state = checkpoint.header.ckpt;
        if (
            !state ||
            state.through !== checkpointThrough ||
            typeof state.event_cursor !== 'string' ||
            checkpoint.header.epoch !== recorded.header.epoch ||
            checkpoint.bytes.byteLength === 0 ||
            !new TextDecoder()
                .decode(checkpoint.bytes)
                .includes('FIND-MATCH-037')
        )
            throw new Error('fixture has no nonempty inherited checkpoint');
        const range = await readEnvelope(
            `${base}/recording?from=${checkpointThrough}&through=${recordedEnd}&epoch=${recorded.header.epoch}&after_event_cursor=${encodeURIComponent(state.event_cursor)}`,
        );
        if (
            range.header.start !== checkpointThrough ||
            range.header.end !== recordedEnd ||
            range.header.epoch !== recorded.header.epoch
        )
            throw new Error('fixture range did not continue the checkpoint');
        if (
            range.bytes.some((_, offset) => {
                if (offset + inheritedMarker.length > range.bytes.byteLength)
                    return false;
                return inheritedMarker.every(
                    (byte, index) => range.bytes[offset + index] === byte,
                );
            })
        )
            throw new Error(
                'inherited match unexpectedly remains in the range',
            );

        const marker = new TextEncoder().encode('FIND-MATCH-112');
        let markerOffset = -1;
        outer: for (
            let offset = 0;
            offset <= range.bytes.byteLength - marker.length;
            offset++
        ) {
            for (let index = 0; index < marker.length; index++) {
                if (range.bytes[offset + index] !== marker[index])
                    continue outer;
            }
            markerOffset = offset;
            break;
        }
        if (markerOffset < 0)
            throw new Error('range match is not in the recording');
        const split =
            range.header.start + markerOffset + Math.floor(marker.length / 2);
        const splitOffset = split - range.header.start;
        const firstBytes = range.bytes.subarray(0, splitOffset);
        const secondBytes = range.bytes.subarray(splitOffset);
        const transferView = (bytes: Uint8Array) => {
            const backing = new Uint8Array(bytes.byteLength + 5);
            backing.set(bytes, 2);
            return {
                backing,
                view: backing.subarray(2, 2 + bytes.byteLength),
            };
        };
        const firstRange = transferView(firstBytes);
        const secondRange = transferView(secondBytes);
        const firstResizes = (range.header.resizes ?? []).filter(
            ([at]) => at <= split,
        );
        const secondResizes = (range.header.resizes ?? []).filter(
            ([at]) => at > split,
        );
        const checkpointBacking = new Uint8Array(
            checkpoint.bytes.byteLength + 5,
        );
        checkpointBacking.set(checkpoint.bytes, 2);
        const checkpointView = checkpointBacking.subarray(
            2,
            2 + checkpoint.bytes.byteLength,
        );
        const jobId = 'served-retained-book';
        return await new Promise<{
            complete: boolean;
            through: number;
            expectedThrough: number;
            matches: Array<{ id: number; snippet: string }>;
        }>((resolve, reject) => {
            const worker = new Worker(
                new URL('./terminal-search-worker.js', location.href),
                { type: 'module' },
            );
            const timer = window.setTimeout(() => {
                worker.terminate();
                reject(new Error('served archive Worker timed out'));
            }, 15_000);
            let matches: Array<{ id: number; snippet: string }> = [];
            let firstRangeAcknowledged = false;
            worker.onerror = (event) => {
                window.clearTimeout(timer);
                worker.terminate();
                reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
                if (data.jobId !== jobId) {
                    window.clearTimeout(timer);
                    worker.terminate();
                    reject(new Error('archive Worker returned a stale job'));
                    return;
                }
                if (data.type === 'error') {
                    window.clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(data.message));
                } else if (data.type === 'ready') {
                    worker.postMessage(
                        {
                            type: 'range',
                            jobId,
                            start: range.header.start,
                            end: split,
                            bytes: firstRange.view,
                            resizes: firstResizes,
                        },
                        [firstRange.backing.buffer],
                    );
                } else if (data.type === 'ack') {
                    if (!firstRangeAcknowledged) {
                        firstRangeAcknowledged = true;
                        worker.postMessage(
                            {
                                type: 'range',
                                jobId,
                                start: split,
                                end: range.header.end,
                                bytes: secondRange.view,
                                resizes: secondResizes,
                            },
                            [secondRange.backing.buffer],
                        );
                    } else {
                        worker.postMessage({ type: 'finish', jobId });
                    }
                } else if (data.type === 'matches') {
                    matches.push(...data.matches);
                } else if (data.type === 'complete') {
                    window.clearTimeout(timer);
                    worker.terminate();
                    resolve({
                        complete: true,
                        through: data.through,
                        expectedThrough: recordedEnd,
                        matches,
                    });
                }
            };
            worker.postMessage(
                {
                    type: 'init',
                    jobId,
                    query: 'FIND-MATCH-',
                    through: state.through,
                    cols: state.cols,
                    rows: state.rows,
                    bytes: checkpointView,
                },
                [checkpointBacking.buffer],
            );
        });
    }, paneId);
    expect((await workerScript).status()).toBe(200);
    expect((await parserScript).status()).toBe(200);
    expect(result.complete).toBe(true);
    expect(result.through).toBe(result.expectedThrough);
    expect(result.matches).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                snippet: expect.stringContaining('FIND-MATCH-037'),
            }),
            expect.objectContaining({
                snippet: expect.stringContaining('FIND-MATCH-112'),
            }),
        ]),
    );
});

test('served archive Worker reports malformed ranges and command backpressure', async ({
    page,
}) => {
    phi.verify();
    const workerScript = page.waitForResponse((response) =>
        response.url().endsWith('/terminal-search-worker.js'),
    );
    const parserScript = page.waitForResponse((response) =>
        response.url().endsWith('/vendor/xterm-headless.js'),
    );
    await page.goto(phi.url);
    const failures = await page.evaluate(async () => {
        type Reply = {
            type: string;
            jobId: string;
            message?: string;
        };
        const waitFor = (worker: Worker, type: string) =>
            new Promise<Reply>((resolve, reject) => {
                const timer = window.setTimeout(() => {
                    cleanup();
                    reject(new Error(`Worker did not reply with ${type}`));
                }, 15_000);
                const cleanup = () => {
                    window.clearTimeout(timer);
                    worker.removeEventListener('message', onMessage);
                    worker.removeEventListener('error', onError);
                };
                const onMessage = (event: MessageEvent<Reply>) => {
                    if (event.data.type !== type) return;
                    cleanup();
                    resolve(event.data);
                };
                const onError = (event: ErrorEvent) => {
                    cleanup();
                    reject(new Error(event.message));
                };
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onError);
            });
        const start = async (jobId: string) => {
            const worker = new Worker(
                new URL('./terminal-search-worker.js', location.href),
                { type: 'module' },
            );
            const ready = waitFor(worker, 'ready');
            worker.postMessage({
                type: 'init',
                jobId,
                query: 'needle',
                through: 0,
                cols: 80,
                rows: 24,
                bytes: new Uint8Array(),
            });
            await ready;
            return worker;
        };

        const malformedWorker = await start('malformed-range');
        const malformedReply = waitFor(malformedWorker, 'error');
        malformedWorker.postMessage({
            type: 'range',
            jobId: 'malformed-range',
            start: 0,
            end: 2,
            bytes: new Uint8Array([1]),
        });
        const malformed = await malformedReply;
        malformedWorker.terminate();

        const busyWorker = await start('busy-range');
        const backpressureReply = waitFor(busyWorker, 'error');
        const bytes = new TextEncoder().encode('x'.repeat(32 * 1024));
        busyWorker.postMessage({
            type: 'range',
            jobId: 'busy-range',
            start: 0,
            end: bytes.byteLength,
            bytes,
        });
        busyWorker.postMessage({ type: 'finish', jobId: 'busy-range' });
        const backpressure = await backpressureReply;
        busyWorker.terminate();
        return {
            malformed: malformed.message,
            backpressure: backpressure.message,
        };
    });
    expect((await workerScript).status()).toBe(200);
    expect((await parserScript).status()).toBe(200);
    expect(failures).toEqual({
        malformed: 'non-contiguous recording range',
        backpressure: 'worker command already pending',
    });
});

test('retained search finds evicted output without changing the live terminal', async ({
    browser,
    page,
    request,
}) => {
    test.setTimeout(180_000);
    phi.verify();
    const created = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir },
    });
    expect(created.ok()).toBe(true);
    const { pane_id: paneId } = (await created.json()) as { pane_id: string };

    let collectingFrames = false;
    const sentFrames: string[] = [];
    const socketConnections: unknown[] = [];
    const pageInputRequests: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: Array<{ path: string; error: string }> = [];
    const httpErrors: Array<{ path: string; status: number }> = [];
    const archiveResponseStatuses: number[] = [];
    page.on('websocket', (socket) => {
        socketConnections.push(socket);
        socket.on('framesent', ({ payload }) => {
            if (!collectingFrames) return;
            sentFrames.push(
                typeof payload === 'string'
                    ? payload
                    : Buffer.from(payload).toString('utf8'),
            );
        });
    });
    page.on('request', (candidate) => {
        if (
            candidate.method() === 'POST' &&
            candidate.url().includes(`/api/terminals/${paneId}/input`)
        )
            pageInputRequests.push(candidate.url());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (candidate) =>
        failedRequests.push({
            path: new URL(candidate.url()).pathname,
            error: candidate.failure()?.errorText ?? 'failed',
        }),
    );
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            httpErrors.push({
                path: new URL(response.url()).pathname,
                status: response.status(),
            });
        }
        if (
            response.url().includes(`/api/terminals/${paneId}/state`) ||
            response.url().includes(`/api/terminals/${paneId}/recording`) ||
            response.url().endsWith('/terminal-search-worker.js') ||
            response.url().endsWith('/terminal-search-core.js') ||
            response.url().endsWith('/vendor/xterm-headless.js')
        )
            archiveResponseStatuses.push(response.status());
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await captureSearchTerms(page);
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    await expect(page.locator(`#term-${paneId} .xterm`)).toBeVisible();
    await expect
        .poll(async () => (await terminalBufferText(page, paneId))?.text ?? '')
        .toContain('SEARCH-READY');
    expect(
        (
            await request.post(`${phi.url}/api/terminals/${paneId}/input`, {
                data: { text: 'go' },
            })
        ).ok(),
    ).toBe(true);
    await expect
        .poll(async () => (await terminalBufferText(page, paneId))?.text ?? '')
        .toContain('FIND-MATCH-112');
    expect(
        (
            await request.post(`${phi.url}/api/terminals/${paneId}/input`, {
                data: { text: 'many' },
            })
        ).ok(),
    ).toBe(true);
    await expect
        .poll(
            async () => (await terminalBufferText(page, paneId))?.text ?? '',
            { timeout: 60_000 },
        )
        .toContain('ARCHIVE-ROW-15999');
    const resident = await terminalBufferText(page, paneId);
    expect(resident?.baseY).toBeGreaterThanOrEqual(10_000);
    expect(resident?.text).not.toContain('ARCHIVE-RARE-MARKER');
    await waitForRecordedText(phi, paneId, 'ARCHIVE-ROW-15999');
    const before = await readTerminalHead(phi, paneId, request);
    const beforeParser = await terminalBufferText(page, paneId);
    await expect.poll(() => socketConnections.length).toBeGreaterThan(0);
    const socketsBeforeSearch = socketConnections.length;

    const composer = page.locator('#input-textarea');
    await composer.fill('archive search keeps this draft');
    await composer.press('Control+f');
    const findBar = page.locator(`#term-${paneId} .find-bar`);
    await expect(findBar).toBeVisible();
    const findInput = findBar.locator('.find-input');
    collectingFrames = true;
    await findInput.fill('ARCHIVE-RARE-MARKER');
    await expect(findBar.locator('.find-source-select')).toHaveValue(
        'retained',
        {
            timeout: 60_000,
        },
    );
    await expect(findBar.locator('.find-status')).toContainText(
        'Complete through captured byte',
        { timeout: 60_000 },
    );
    await findInput.press('Enter');
    await expect(findBar.locator('.find-preview')).toContainText(
        'ARCHIVE-RARE-MARKER',
    );
    collectingFrames = false;
    await expect(composer).toHaveValue('archive search keeps this draft');
    const afterParser = await terminalBufferText(page, paneId);
    expect(afterParser).toMatchObject({
        cols: beforeParser?.cols,
        rows: beforeParser?.rows,
        baseY: beforeParser?.baseY,
        length: beforeParser?.length,
    });
    const after = await readTerminalHead(phi, paneId, request);
    expect(after.epoch).toBe(before.epoch);
    expect(after.head).toBe(before.head);
    expect(socketConnections).toHaveLength(socketsBeforeSearch);
    expect(pageInputRequests).toEqual([]);
    expect(sentFrames.join('')).not.toContain('ARCHIVE-RARE-MARKER');
    expect(archiveResponseStatuses.length).toBeGreaterThan(0);
    expect(archiveResponseStatuses.every((status) => status === 200)).toBe(
        true,
    );

    expect(
        (
            await request.post(`${phi.url}/api/terminals/${paneId}/input`, {
                data: { text: 'live-probe' },
            })
        ).ok(),
    ).toBe(true);
    await expect
        .poll(async () => (await terminalBufferText(page, paneId))?.text ?? '')
        .toContain('PTY INPUT: live-probe');
    expect((await readTerminalHead(phi, paneId, request)).head).toBeGreaterThan(
        after.head,
    );
    expect(pageErrors).toEqual([]);
    const allowedCanceledBackgroundRequests = new Set([
        '/api/git/worktree-dirty',
        '/api/git/worktrees',
        '/vendor/bell.wav',
    ]);
    expect(
        failedRequests.every(
            (failure) =>
                allowedCanceledBackgroundRequests.has(failure.path) &&
                failure.error.includes('ERR_ABORTED'),
        ),
        `unexpected failed requests: ${JSON.stringify(failedRequests)}`,
    ).toBe(true);
    const allowedBackgroundErrors = new Set([
        '/api/update/status:503',
        '/api/sessions:500',
    ]);
    expect(
        httpErrors.every((error) =>
            allowedBackgroundErrors.has(`${error.path}:${error.status}`),
        ),
    ).toBe(true);
    expect(httpErrors.map((error) => `${error.path}:${error.status}`)).toEqual(
        expect.arrayContaining(['/api/update/status:503', '/api/sessions:500']),
    );
    expect(
        consoleErrors.filter(
            (message) =>
                !message.includes('503 (Service Unavailable)') &&
                !message.includes('500 (Internal Server Error)'),
        ),
    ).toEqual([]);
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);

    const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
    });
    try {
        const mobile = await mobileContext.newPage();
        const mobileErrors: string[] = [];
        const mobileConsoleErrors: string[] = [];
        const mobileFailures: Array<{ path: string; error: string }> = [];
        const mobileHttpErrors: Array<{ path: string; status: number }> = [];
        mobile.on('pageerror', (error) => mobileErrors.push(error.message));
        mobile.on('console', (message) => {
            if (message.type() === 'error')
                mobileConsoleErrors.push(message.text());
        });
        mobile.on('requestfailed', (candidate) =>
            mobileFailures.push({
                path: new URL(candidate.url()).pathname,
                error: candidate.failure()?.errorText ?? 'failed',
            }),
        );
        mobile.on('response', (response) => {
            if (response.status() >= 400) {
                mobileHttpErrors.push({
                    path: new URL(response.url()).pathname,
                    status: response.status(),
                });
            }
        });
        await captureSearchTerms(mobile);
        await mobile.goto(phi.url);
        await mobile.locator('#hostname-display').tap();
        await tabList(mobile)
            .locator(`[data-pane-id="${paneId}"] .hostname-dropdown-select-btn`)
            .tap();
        await expect(mobile.locator(`#term-${paneId} .xterm`)).toBeVisible();
        await mobile.locator(`#term-${paneId} .xterm-screen`).tap();
        await mobile.keyboard.press('Control+f');
        const mobileBar = mobile.locator(`#term-${paneId} .find-bar`);
        await expect(mobileBar).toBeVisible();
        await mobileBar.locator('.find-input').fill('ARCHIVE-RARE-MARKER');
        await expect(mobileBar.locator('.find-source-select')).toHaveValue(
            'retained',
            { timeout: 60_000 },
        );
        await mobileBar.locator('.find-next').tap();
        await expect(mobileBar.locator('.find-preview')).toContainText(
            'ARCHIVE-RARE-MARKER',
        );
        expect(
            await mobile.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        const bounds = await mobileBar.boundingBox();
        if (!bounds) throw new Error('mobile find bar has no layout bounds');
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
        await mobileBar.locator('.find-close').tap();
        await expect(mobileBar).toHaveCount(0);
        expect(mobileErrors).toEqual([]);
        expect(
            mobileFailures.every(
                (failure) =>
                    allowedCanceledBackgroundRequests.has(failure.path) &&
                    failure.error.includes('ERR_ABORTED'),
            ),
            `unexpected mobile failed requests: ${JSON.stringify(mobileFailures)}`,
        ).toBe(true);
        expect(
            mobileHttpErrors.every((error) =>
                allowedBackgroundErrors.has(`${error.path}:${error.status}`),
            ),
        ).toBe(true);
        expect(
            mobileConsoleErrors.filter(
                (message) =>
                    !message.includes('503 (Service Unavailable)') &&
                    !message.includes('500 (Internal Server Error)'),
            ),
        ).toEqual([]);
    } finally {
        await mobileContext.close();
    }
});
