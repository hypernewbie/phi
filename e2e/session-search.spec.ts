import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
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

type SearchWindow = Window & {
    searchTerms?: SearchTerm[];
    searchCopies?: number;
};

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
    printf 'PTY INPUT: %s\\r\\n' "$line"
done
`,
                { mode: 0o755 },
            );
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

async function typeFindQuery(input: Locator, query: string) {
    await input.fill('');
    await input.focus();
    for (const character of query) {
        await input.page().keyboard.type(character);
        await expect(input).toBeFocused();
    }
    await expect(input).toHaveValue(query);
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

    // Plain-HTTP tailnet clients have no Clipboard API. Search selections
    // must not enter the legacy copy path and steal keyboard focus.
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined });
        const w = window as SearchWindow;
        w.searchCopies = 0;
        document.addEventListener('copy', () => {
            w.searchCopies = (w.searchCopies ?? 0) + 1;
        });
    });
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
    await expect(piFind.locator('.find-source-select')).toHaveCount(0);
    const piInput = piFind.locator('.find-input');
    await typeFindQuery(piInput, 'FIND-MATCH-');
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
    await typeFindQuery(piInput, 'ROW-150');
    await expect
        .poll(() => terminalViewportText(page, piPane))
        .toContain('ROW-150');
    await page.keyboard.press('Backspace');
    await expect(piInput).toBeFocused();
    await expect(piInput).toHaveValue('ROW-15');
    const liveOutput = await request.post(
        `${phi.url}/api/terminals/${piPane}/input`,
        { data: { text: 'live-output-during-search' } },
    );
    expect(liveOutput.ok()).toBe(true);
    await expect
        .poll(async () => (await terminalBufferText(page, piPane))?.text ?? '')
        .toContain('PTY INPUT: live-output-during-search');
    // The addon refreshes highlights 200 ms after parsing live output.
    await page.waitForTimeout(350);
    await expect(piInput).toBeFocused();
    await expect(piInput).toHaveValue('ROW-15');
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
    await expect(shellFind.locator('.find-source-select')).toHaveCount(0);
    const shellInput = shellFind.locator('.find-input');
    await shellInput.fill('');
    await typeFindQuery(shellInput, 'FIND-MATCH-');
    await expect
        .poll(() => terminalViewportText(page, shellPane))
        .toContain('FIND-MATCH-037');
    expect(
        await page.evaluate(() => (window as SearchWindow).searchCopies),
    ).toBe(0);
    await shellFind.locator('.find-input').press('Escape');
    // A real mouse selection still uses the ordinary auto-copy path.
    await page.locator(`#term-${shellPane} .xterm-screen`).dblclick({
        position: { x: 20, y: 10 },
    });
    await expect
        .poll(() =>
            page.evaluate(() => (window as SearchWindow).searchCopies ?? 0),
        )
        .toBeGreaterThan(0);

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
        await mobilePage.addInitScript(() => {
            Object.defineProperty(navigator, 'clipboard', { value: undefined });
        });
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
        // A phone has no Ctrl+F. Tap the launcher, keep the draft, and prove
        // the quiet search interval added no bytes to the recording.
        const mobileDraft = 'keep mobile draft';
        const mobileComposer = mobilePage.locator('#input-textarea');
        await mobileComposer.fill(mobileDraft);
        const beforeSearch = await readTerminalHead(phi, mobilePiPane, request);
        await mobilePage.locator('#session-search-btn').tap();
        const mobileFind = mobilePage.locator(
            `#term-${mobilePiPane} .find-bar`,
        );
        await expect(mobileFind).toBeVisible();
        const mobileFindInput = mobileFind.locator('.find-input');
        await expect(mobileFindInput).toBeFocused();
        await mobileFindInput.tap();
        await typeFindQuery(mobileFindInput, 'FIND-MATCH-');
        await expect
            .poll(() => terminalViewportText(mobilePage, mobilePiPane))
            .toContain('FIND-MATCH-037');
        await mobileFind.locator('.find-next').tap();
        await expect
            .poll(() => terminalViewportText(mobilePage, mobilePiPane))
            .toContain('FIND-MATCH-112');
        await mobileFind.locator('.find-prev').tap();
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
        // Touch targets, not merely visible controls.
        const navBoxes = await mobileFind
            .locator('.find-btn')
            .evaluateAll((nodes) =>
                nodes.map((node) => {
                    const rect = node.getBoundingClientRect();
                    return { w: rect.width, h: rect.height, right: rect.right };
                }),
            );
        expect(navBoxes).toHaveLength(3);
        for (const box of navBoxes) {
            expect(box.w).toBeGreaterThanOrEqual(44);
            expect(box.h).toBeGreaterThanOrEqual(44);
            expect(box.right).toBeLessThanOrEqual(390);
        }
        await mobileFind.locator('.find-close').tap();
        await expect(mobileFind).toHaveCount(0);
        await expect(mobileComposer).toHaveValue(mobileDraft);
        await expect(mobileComposer).toBeFocused();
        expect(await readTerminalHead(phi, mobilePiPane, request)).toEqual(
            beforeSearch,
        );
        expect(
            (await terminalBufferText(mobilePage, mobilePiPane))?.text,
        ).not.toContain('PTY INPUT:');

        // Reopening restores the last query.
        await mobilePage.locator('#session-search-btn').tap();
        await expect(mobileFind).toHaveCount(1);
        await expect(mobileFindInput).toBeFocused();
        await expect(mobileFindInput).toHaveValue('FIND-MATCH-');
        await mobileFind.locator('.find-close').tap();
        await expect(mobileFind).toHaveCount(0);
        await expect(mobileComposer).toHaveValue(mobileDraft);

        // Collapsed input parks the same launcher in the footer row.
        await mobilePage.locator('#direct-mode-toggle').tap();
        const collapsedSearch = mobilePage.locator('#session-search-btn');
        await expect(collapsedSearch).toBeVisible();
        const collapsedBox = await collapsedSearch.boundingBox();
        if (!collapsedBox)
            throw new Error('collapsed search has no layout box');
        expect(collapsedBox.width).toBeGreaterThanOrEqual(48);
        expect(collapsedBox.height).toBeGreaterThanOrEqual(48);
        await collapsedSearch.tap();
        await expect(mobileFindInput).toBeFocused();
        await mobileFindInput.tap();
        await typeFindQuery(mobileFindInput, 'FIND-MATCH-');
        await expect
            .poll(() => terminalViewportText(mobilePage, mobilePiPane))
            .toContain('FIND-MATCH-037');
        await mobileFind.locator('.find-close').tap();
        await expect(mobileFind).toHaveCount(0);
        await expect(
            mobilePage.locator(`#term-${mobilePiPane} .xterm-helper-textarea`),
        ).toBeFocused();
        await mobilePage.locator('#direct-mode-toggle').tap();
        await expect(mobileComposer).toHaveValue(mobileDraft);
    } finally {
        await mobileContext.close();
    }
});
