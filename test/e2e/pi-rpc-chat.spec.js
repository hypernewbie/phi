import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fakeLogPath = process.env.PI_FAKE_LOG;
const e2eBaseURL =
    process.env.PI_E2E_BASE_URL ?? 'http://127.0.0.1:17891';
test.setTimeout(180_000);

async function readFakeLog() {
    const text = await readFile(fakeLogPath, 'utf8');
    return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

async function waitForReady(page) {
    await expect(page.locator('.term-container.active.review-panel')).toBeVisible({
        timeout: 30_000,
    });
    await expect(page.locator('.review-chat-wrapper')).toBeVisible();
    await expect(
        page
            .locator('.term-container.active.review-panel .review-header-coder')
            .filter({ hasText: 'Ready' }),
    ).toBeVisible({ timeout: 30_000 });
}

async function openPi(page) {
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const controlSockets = [];
        let dropRequested = false;
        const isControlSocket = (value) => {
            try {
                return new URL(String(value), location.href).pathname ===
                    '/ws/control';
            } catch {
                return false;
            }
        };
        const dropControlSockets = () => {
            if (dropRequested) return;
            dropRequested = true;
            for (const socket of controlSockets) {
                try {
                    socket.close();
                } catch {
                    // The test only needs a deterministic control loss.
                }
            }
        };
        window.__e2eDropControlSockets = dropControlSockets;
        window.__e2eControlSockets = controlSockets;
        window.WebSocket = new Proxy(NativeWebSocket, {
            construct(target, args) {
                const socket = new target(...args);
                if (isControlSocket(args[0])) controlSockets.push(socket);
                return socket;
            },
        });
    });
    await page.goto('/');
    await page.locator('.coder-tab[data-coder="pi-rpc"]').dispatchEvent('click');
    await page.locator('#new-session-btn').dispatchEvent('click');
    await waitForReady(page);
    await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
    await expect.poll(async () => {
        const records = await readFakeLog();
        return records.find((record) => record.kind === 'startup');
    }).toMatchObject({ args: ['--mode', 'rpc'] });
}

async function send(page, message, press = 'Enter') {
    const input = page.locator('#input-textarea');
    await input.fill(message);
    await input.press(press);
}

async function waitForSettled(page) {
    await expect(page.locator('.pi-active-turn')).toHaveClass(/hidden/, {
        timeout: 30_000,
    });
}

async function waitForFakeEventAfterCommand(message, eventType) {
    await expect
        .poll(async () => {
            const records = await readFakeLog();
            const commandIndex = records.findLastIndex(
                (record) =>
                    record.kind === 'command' && record.message === message,
            );
            return (
                commandIndex >= 0 &&
                records
                    .slice(commandIndex + 1)
                    .some(
                        (record) =>
                            record.kind === 'event' &&
                            record.type === eventType,
                    )
            );
        }, { timeout: 15_000 })
        .toBe(true);
}

async function readViewportSurface(page) {
    return page.evaluate(() => {
        const wrapper = document.querySelector('.review-chat-wrapper');
        const body = document.body;
        const html = document.documentElement;
        const outside = [
            '.pi-active-turn',
            '.pi-queue-panel',
            '#input-bar-container',
            '#pi-rpc-status-bar',
        ]
            .map((selector) => [selector, document.querySelector(selector)])
            .every(([, node]) => node && !wrapper.contains(node));
        const relevant = [html, body, wrapper, ...(() => {
            const out = [];
            let node = wrapper?.parentElement;
            while (node) {
                out.push(node);
                node = node.parentElement;
            }
            return out;
        })()];
        const styles = relevant.map((node) => {
            const style = getComputedStyle(node);
            return {
                node: node === wrapper ? 'wrapper' : node.tagName.toLowerCase(),
                overflowY: style.overflowY,
                overflowX: style.overflowX,
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
                scrollWidth: node.scrollWidth,
                clientWidth: node.clientWidth,
            };
        });
        return {
            wrapperScrollable:
                wrapper &&
                wrapper.scrollHeight > wrapper.clientHeight &&
                ['auto', 'scroll'].includes(getComputedStyle(wrapper).overflowY),
            bodyFits:
                body.scrollHeight <= body.clientHeight &&
                html.scrollHeight <= html.clientHeight,
            horizontalFits:
                body.scrollWidth <= body.clientWidth &&
                html.scrollWidth <= html.clientWidth,
            outside,
            styles,
        };
    });
}

async function waitForViewportSurface(page) {
    await expect
        .poll(async () => {
            const surface = await readViewportSurface(page);
            return (
                surface.wrapperScrollable === true &&
                surface.bodyFits === true &&
                surface.horizontalFits === true &&
                surface.outside === true &&
                surface.styles.every(
                    (style) =>
                        style.node === 'wrapper' ||
                        (style.scrollHeight <= style.clientHeight &&
                            !['auto', 'scroll'].includes(style.overflowY)),
                )
            );
        }, { timeout: 15_000 })
        .toBe(true);
    return readViewportSurface(page);
}

async function assertViewportSurface(surface) {
    expect(surface.wrapperScrollable).toBe(true);
    expect(surface.bodyFits).toBe(true);
    expect(surface.horizontalFits).toBe(true);
    expect(surface.outside).toBe(true);
    for (const style of surface.styles) {
        if (style.node === 'wrapper') continue;
        expect(style.scrollHeight, `${style.node} scroll height`).toBeLessThanOrEqual(
            style.clientHeight,
        );
        expect(['auto', 'scroll']).not.toContain(style.overflowY);
    }
}

test('Pi RPC chat survives reconnect and covers queue, dialogs, stream, image, search, and viewport', async ({
    page,
    browser,
}) => {
    await openPi(page);

    await page.locator('#input-textarea').fill('draft survives reconnect');
    await page.evaluate(() => {
        window.__e2eDropControlSockets();
        window.dispatchEvent(new Event('offline'));
    });
    await expect(page.locator('.pi-rpc-connection-state')).toContainText(
        'Reconnecting',
        { timeout: 15_000 },
    );
    expect(await page.locator('#input-textarea').inputValue()).toBe(
        'draft survives reconnect',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(3000);
    await waitForReady(page);
    expect(await page.locator('#input-textarea').inputValue()).toBe(
        'draft survives reconnect',
    );
    expect(
        (await readFakeLog()).some(
            (record) =>
                record.kind === 'command' &&
                record.type === 'prompt' &&
                record.message === 'draft survives reconnect',
        ),
    ).toBe(false);

    await send(page, 'reconnect-proof');
    await expect(page.getByText('reconnected', { exact: true })).toBeVisible({
        timeout: 30_000,
    });
    await waitForSettled(page);
    await expect(
        page.locator('.user-message').filter({ hasText: 'reconnect-proof' }),
    ).toHaveCount(1);

    await send(page, 'queue-run');
    await expect(
        page.locator('.pi-queue-authoritative[data-queue-delivery="steer"]'),
    ).toBeVisible({ timeout: 15_000 });
    await send(page, 'steer-target');
    await expect(
        page.locator('.pi-queue-item[data-queue-delivery="steer"]'),
    ).toHaveCount(1);
    await send(page, 'follow-target', 'Alt+Enter');
    await expect(page.getByText('queue complete', { exact: true })).toBeVisible({
        timeout: 30_000,
    });
    await waitForSettled(page);
    await expect(
        page.locator('.pi-queue-item:not([data-queue-state="consumed"])'),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.pi-queue-authoritative')).toHaveCount(0);
    await expect(page.locator('.pi-queue-panel')).toHaveClass(/hidden/);

    await send(page, 'late-steer-run');
    await expect(page.locator('.pi-active-turn')).not.toHaveClass(/hidden/, {
        timeout: 15_000,
    });
    await waitForFakeEventAfterCommand('late-steer-run', 'agent_start');
    await page.waitForTimeout(250);
    await send(page, 'late-steer-target');
    await expect(
        page.locator('.pi-queue-item[data-queue-state="promoted"]'),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
        page.getByText('late steer promoted', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await waitForSettled(page);
    await expect(
        page
            .locator('.review-chat-wrapper .user-message')
            .filter({ hasText: 'late-steer-target' }),
    ).toHaveCount(1);
    const latePrompts = (await readFakeLog()).filter(
        (record) =>
            record.kind === 'command' &&
            record.type === 'prompt' &&
            record.message === 'late-steer-target',
    );
    expect(latePrompts).toHaveLength(1);

    await send(page, 'dialog');
    const dialog = page.locator('.pi-extension-dialog[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator('.pi-extension-dialog-title')).toHaveText(
        'Choose fixture',
    );
    expect(
        await dialog.locator('[data-dialog-value="Allow"]').evaluate((node) =>
            node.ownerDocument.activeElement
                ? node.contains(node.ownerDocument.activeElement)
                : false,
        ),
    ).toBe(true);
    await dialog.locator('[data-dialog-value="Allow"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#input-textarea')).toBeFocused();
    await expect(page.getByText('fake dialog accepted', { exact: true })).toBeVisible({
        timeout: 15_000,
    });

    await send(page, 'stream');
    await expect(page.locator('.pi-live-thinking .thinking-text')).toContainText(
        'checking the fixture',
        { timeout: 15_000 },
    );
    await expect(
        page.locator('.tool-execution#tool-call-stream-call'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pi-live-tool')).toContainText('live-');
    await page.screenshot({ path: 'test-results/pi-rpc/stream-mid.png' });
    await expect(page.getByText('finished', { exact: true })).toBeVisible({
        timeout: 30_000,
    });
    await waitForSettled(page);
    await expect(page.getByText('live-tool-output-done', { exact: true })).toBeVisible();
    await expect(page.locator('.pi-streaming')).toHaveCount(0);

    await page.evaluate(() => {
        const bytes = Uint8Array.from(
            atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            ),
            (character) => character.charCodeAt(0),
        );
        const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document
            .querySelector('#input-textarea')
            .dispatchEvent(
                new ClipboardEvent('paste', {
                    clipboardData: transfer,
                    bubbles: true,
                }),
            );
    });
    const chip = page.locator('.attachment-chip[data-ref]');
    await expect(chip).toHaveCount(1, { timeout: 15_000 });
    await expect(chip).toHaveAttribute('data-ref', /^[0-9a-f]{64}$/);
    expect(await chip.textContent()).not.toContain('/clipboard/');
    await send(page, 'image-check');
    await expect(page.getByText('fake image received', { exact: true })).toBeVisible({
        timeout: 30_000,
    });
    const imageRecord = (await readFakeLog()).find(
        (record) =>
            record.kind === 'command' &&
            record.type === 'prompt' &&
            record.message === 'image-check',
    );
    expect(imageRecord).toMatchObject({
        imageSummary: [
            {
                type: 'image',
                mimeType: 'image/png',
                dataBytes: expect.any(Number),
            },
        ],
        containsPath: false,
    });
    expect(imageRecord.data).toBeUndefined();
    expect(imageRecord.path).toBeUndefined();

    await send(page, 'history');
    await expect(page.getByText('history-answer-119', { exact: true })).toBeVisible({
        timeout: 30_000,
    });
    await waitForSettled(page);
    await assertViewportSurface(await waitForViewportSurface(page));
    await page.screenshot({ path: 'test-results/pi-rpc/viewport-1280.png' });

    await page.keyboard.press('Control+Shift+F');
    await page.locator('[data-pi-search-input]').fill('oldest-search-target');
    await expect(page.locator('[data-pi-search-count]')).toHaveText('1 / 1', {
        timeout: 15_000,
    });
    await expect(page.locator('mark[data-pi-active-match]')).toContainText(
        'oldest-search-target',
    );
    await expect(
        page.locator('[data-buffer-index]').filter({
            hasText: 'oldest-search-target',
        }),
    ).toHaveCount(1);
    const closeSearch = async () => {
        const scoped = page.locator(
            '.pi-search-bar [data-pi-search-close]',
        );
        await scoped
            .click({ force: true })
            .catch(() => page.locator('.pi-search-bar').dispatchEvent('click'));
    };
    await closeSearch();
    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('[data-pi-search-input]')).toHaveValue(
        'oldest-search-target',
    );
    await expect(page.locator('[data-pi-search-count]')).toHaveText('1 / 1');
    await closeSearch();

    const smallContext = await browser.newContext({
        viewport: { width: 640, height: 480 },
        baseURL: e2eBaseURL,
    });
    const small = await smallContext.newPage();
    try {
        await openPi(small);
        await send(small, 'history');
        await expect(
            small.getByText('history-answer-119', { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await waitForSettled(small);
        await assertViewportSurface(await waitForViewportSurface(small));
        await expect(small.locator('#input-bar-container')).toBeVisible();
        await small.screenshot({ path: 'test-results/pi-rpc/viewport-640.png' });
    } finally {
        await smallContext.close();
    }
});
