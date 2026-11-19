import { realpathSync } from 'node:fs';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    readTopicsObserver,
    seedTopicsPi,
    startTopicsProvider,
    TOPICS_KEY,
    TOPICS_LARGE,
    TOPICS_MARKER,
    TOPICS_MODEL,
    TOPICS_PROVIDER,
    type TopicsProvider,
} from './_pi-syncboard-topics.js';

interface ObservedTerminal {
    rows: number;
    element?: { closest(selector: string): { id?: string } | null };
    buffer: {
        active: {
            viewportY: number;
            getLine(
                index: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

async function observe(page: Page) {
    await page.addInitScript(() => {
        type Constructor = new (
            opts: Record<string, unknown>,
        ) => ObservedTerminal;
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        w.nativeTerms = [];
        let ctor: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: Constructor) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        w.nativeTerms.push(this);
                    }
                };
            },
        });
    });
}

async function terminalText(page: Page, pane: string): Promise<string> {
    return page.evaluate((id) => {
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        const term = w.nativeTerms.find(
            (candidate) =>
                candidate.element?.closest('.term-container')?.id ===
                `term-${id}`,
        );
        if (!term) return '';
        return Array.from(
            { length: term.rows },
            (_, i) =>
                term.buffer.active
                    .getLine(term.buffer.active.viewportY + i)
                    ?.translateToString(true) || '',
        ).join('\n');
    }, pane);
}

async function spawnPi(
    request: APIRequestContext,
    owner: PhiServer,
): Promise<string> {
    const response = await request.post(`${owner.url}/api/terminals`, {
        data: { coder: 'pi', cwd: realpathSync(owner.dir), title: 'Topics Pi' },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { pane_id: string }).pane_id;
}

test('real Pi receives an external topic post after one subscribe', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    let provider: TopicsProvider | undefined;
    let server: PhiServer | undefined;
    try {
        provider = await startTopicsProvider();
        let fixture: ReturnType<typeof seedTopicsPi> | undefined;
        server = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                fixture = seedTopicsPi(dir, provider!.port);
            },
        });
        if (!fixture) throw new Error('topics Pi fixture was not seeded');
        await observe(page);
        const paneID = await spawnPi(request, server);
        await page.goto(server.url);
        await page.locator(`.tab[data-pane-id="${paneID}"]`).click();
        await expect
            .poll(
                async () => {
                    const r = await request.get(`${server!.url}/api/terminals`);
                    const tabs = (await r.json()) as Array<{
                        id: string;
                        pi_bridge?: { capabilities?: string[] };
                    }>;
                    return tabs.find((tab) => tab.id === paneID)?.pi_bridge
                        ?.capabilities;
                },
                { timeout: 30_000 },
            )
            .toEqual(
                expect.arrayContaining([
                    'pi.syncboard.topics.v1',
                    'pi.syncboard.push.v1',
                ]),
            );
        await expect
            .poll(() => readTopicsObserver(fixture!.observerPath), {
                timeout: 30_000,
            })
            .toContainEqual(expect.objectContaining({ available: true }));

        const prompt = await request.post(
            `${server.url}/api/terminals/${paneID}/input`,
            {
                data: {
                    text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
                },
            },
        );
        expect(prompt.status()).toBe(204);
        await provider!.waitForRequestCount(2, 30_000);
        await provider!.waitForResult(30_000);
        expect(provider.resultChecked()).toBe(true);
        expect(provider.error()).toBe('');

        const value = { marker: TOPICS_MARKER, text: TOPICS_LARGE };
        const posted = await request.post(`${server.url}/api/sync/messages`, {
            data: { key: TOPICS_KEY, value },
        });
        expect(posted.ok()).toBe(true);
        await provider!.waitForRequestCount(3, 30_000);
        await expect
            .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
            .toBe(true);
        expect(provider.error()).toBe('');
        await expect
            .poll(() => terminalText(page, paneID), { timeout: 30_000 })
            .toContain('TOPICS_END_4c2e');
        const bodies = provider.bodies();
        expect(bodies[2]).toContain('TOPICS_END_4c2e');
        expect(bodies[2]).toContain('ü'.repeat(100));
    } finally {
        await server?.stop();
        await provider?.close();
    }
});

test('real Pi receives a topic post while a model request is in flight', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    let provider: TopicsProvider | undefined;
    let server: PhiServer | undefined;
    try {
        provider = await startTopicsProvider({ holdSecond: true });
        let fixture: ReturnType<typeof seedTopicsPi> | undefined;
        server = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                fixture = seedTopicsPi(dir, provider!.port);
            },
        });
        if (!fixture) throw new Error('topics Pi fixture was not seeded');
        await observe(page);
        const paneID = await spawnPi(request, server);
        await page.goto(server.url);
        await page.locator(`.tab[data-pane-id="${paneID}"]`).click();
        await expect
            .poll(
                async () => {
                    const r = await request.get(`${server!.url}/api/terminals`);
                    const tabs = (await r.json()) as Array<{
                        id: string;
                        pi_bridge?: { capabilities?: string[] };
                    }>;
                    return tabs.find((tab) => tab.id === paneID)?.pi_bridge
                        ?.capabilities;
                },
                { timeout: 30_000 },
            )
            .toEqual(expect.arrayContaining(['pi.syncboard.topics.v1']));
        await expect
            .poll(() => readTopicsObserver(fixture!.observerPath), {
                timeout: 30_000,
            })
            .toContainEqual(expect.objectContaining({ available: true }));

        const prompt = await request.post(
            `${server.url}/api/terminals/${paneID}/input`,
            {
                data: {
                    text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
                },
            },
        );
        expect(prompt.status()).toBe(204);
        await provider.waitForRequestCount(2, 30_000);
        await provider.waitForSecondHeld();
        expect(provider.requestCount()).toBe(2);

        const value = { marker: TOPICS_MARKER, text: TOPICS_LARGE };
        const posted = await request.post(`${server.url}/api/sync/messages`, {
            data: { key: TOPICS_KEY, value },
        });
        expect(posted.ok()).toBe(true);
        expect(provider.requestCount()).toBe(2);
        provider.releaseSecond();

        await provider.waitForRequestCount(3, 30_000);
        await provider.waitForResult(30_000);
        await expect
            .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
            .toBe(true);
        expect(provider.error()).toBe('');
        expect(provider.bodies()[2]).toContain(TOPICS_MARKER);
        expect(provider.bodies()[2]).toContain('TOPICS_END_4c2e');
        await expect
            .poll(() => terminalText(page, paneID), { timeout: 30_000 })
            .toContain('Topic delivery verified.');
    } finally {
        await server?.stop();
        await provider?.close();
    }
});
