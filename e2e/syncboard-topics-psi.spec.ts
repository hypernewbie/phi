import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    startTopicsProvider,
    TOPICS_KEY,
    TOPICS_LARGE,
    TOPICS_MARKER,
    TOPICS_MODEL,
    TOPICS_PROVIDER,
    type TopicsProvider,
} from './_pi-syncboard-topics.js';

const PSI_BIN = process.env.PSI_E2E_BIN ?? '';

type PaneBridge = {
    state: string;
    connected?: boolean;
    capabilities?: string[];
};

async function paneBridge(
    request: APIRequestContext,
    url: string,
    pane: string,
): Promise<PaneBridge | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: PaneBridge;
    }>;
    return tabs.find((tab) => tab.id === pane)?.pi_bridge;
}

test('real Psi receives an external topic post after one subscribe', async ({
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(180_000);
    let provider: TopicsProvider | undefined;
    let server: PhiServer | undefined;
    try {
        provider = await startTopicsProvider();
        server = await startPhi({
            config: { auto_reconnect: 'off', psi_command: PSI_BIN },
            env: (dir) => ({
                PSI_CODING_AGENT_DIR: join(dir, 'psi-agent'),
                PI_CODING_AGENT_SESSION_DIR: join(dir, 'psi-sessions'),
                PI_OFFLINE: '1',
                PI_SKIP_VERSION_CHECK: '1',
            }),
            setup(dir) {
                const agent = join(dir, 'psi-agent');
                const work = join(dir, 'work');
                mkdirSync(agent, { recursive: true });
                mkdirSync(work, { recursive: true });
                writeFileSync(
                    join(agent, 'settings.json'),
                    JSON.stringify({
                        defaultProvider: TOPICS_PROVIDER,
                        defaultModel: TOPICS_MODEL,
                        defaultThinkingLevel: 'off',
                        defaultProjectTrust: 'never',
                        quietStartup: true,
                        compaction: { enabled: false },
                        retry: { enabled: false },
                    }),
                );
                writeFileSync(
                    join(agent, 'models.json'),
                    JSON.stringify({
                        providers: {
                            [TOPICS_PROVIDER]: {
                                baseUrl: `http://127.0.0.1:${provider!.port}`,
                                api: 'anthropic-messages',
                                apiKey: 'syncboard-topics-psi-fixture-key',
                                models: [
                                    {
                                        id: TOPICS_MODEL,
                                        name: 'Topics fixture',
                                        contextWindow: 64_000,
                                        maxTokens: 16384,
                                    },
                                ],
                            },
                        },
                    }),
                );
            },
        });
        const work = realpathSync(join(server.dir, 'work'));
        const created = await request.post(`${server.url}/api/terminals`, {
            data: { coder: 'pi', pi_psi: true, cwd: work, title: 'Topics Psi' },
        });
        expect(created.ok()).toBe(true);
        const pane = ((await created.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridge(request, server!.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.syncboard.topics.v1',
                    'pi.syncboard.v1',
                ]),
            });

        const prompt = await request.post(
            `${server.url}/api/terminals/${pane}/input`,
            {
                data: {
                    text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
                },
            },
        );
        expect(prompt.status()).toBe(204);
        await provider.waitForRequestCount(2, 30_000);
        await provider.waitForResult(30_000);
        expect(provider.resultChecked()).toBe(true);

        const value = { marker: TOPICS_MARKER, text: TOPICS_LARGE };
        const posted = await request.post(`${server.url}/api/sync/messages`, {
            data: { key: TOPICS_KEY, value },
        });
        expect(posted.ok()).toBe(true);
        await provider.waitForRequestCount(3, 30_000);
        await expect
            .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
            .toBe(true);
        expect(provider.error()).toBe('');
    } finally {
        await server?.stop();
        await provider?.close();
    }
});

test('real Psi receives a topic post while a model request is in flight', async ({
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(180_000);
    let provider: TopicsProvider | undefined;
    let server: PhiServer | undefined;
    try {
        provider = await startTopicsProvider({ holdSecond: true });
        server = await startPhi({
            config: { auto_reconnect: 'off', psi_command: PSI_BIN },
            env: (dir) => ({
                PSI_CODING_AGENT_DIR: join(dir, 'psi-agent'),
                PI_CODING_AGENT_SESSION_DIR: join(dir, 'psi-sessions'),
                PI_OFFLINE: '1',
                PI_SKIP_VERSION_CHECK: '1',
            }),
            setup(dir) {
                const agent = join(dir, 'psi-agent');
                const work = join(dir, 'work');
                mkdirSync(agent, { recursive: true });
                mkdirSync(work, { recursive: true });
                writeFileSync(
                    join(agent, 'settings.json'),
                    JSON.stringify({
                        defaultProvider: TOPICS_PROVIDER,
                        defaultModel: TOPICS_MODEL,
                        defaultThinkingLevel: 'off',
                        defaultProjectTrust: 'never',
                        quietStartup: true,
                        compaction: { enabled: false },
                        retry: { enabled: false },
                    }),
                );
                writeFileSync(
                    join(agent, 'models.json'),
                    JSON.stringify({
                        providers: {
                            [TOPICS_PROVIDER]: {
                                baseUrl: `http://127.0.0.1:${provider!.port}`,
                                api: 'anthropic-messages',
                                apiKey: 'syncboard-topics-psi-fixture-key',
                                models: [
                                    {
                                        id: TOPICS_MODEL,
                                        name: 'Topics fixture',
                                        contextWindow: 64_000,
                                        maxTokens: 16384,
                                    },
                                ],
                            },
                        },
                    }),
                );
            },
        });
        const work = realpathSync(join(server.dir, 'work'));
        const created = await request.post(`${server.url}/api/terminals`, {
            data: { coder: 'pi', pi_psi: true, cwd: work, title: 'Topics Psi' },
        });
        expect(created.ok()).toBe(true);
        const pane = ((await created.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridge(request, server!.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.syncboard.topics.v1',
                    'pi.syncboard.v1',
                ]),
            });

        const prompt = await request.post(
            `${server.url}/api/terminals/${pane}/input`,
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
    } finally {
        await server?.stop();
        await provider?.close();
    }
});
