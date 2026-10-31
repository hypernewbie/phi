import { realpathSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    readSyncboardObserver,
    seedSyncboardPi,
    startSyncboardProvider,
    SYNCBOARD_KEY,
    SYNCBOARD_MODEL,
    SYNCBOARD_PROVIDER,
    type SyncboardProvider,
} from './_pi-syncboard.js';

interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
    generation?: string;
    capabilities?: string[];
}

const OWNER_A_VALUE = {
    marker: 'PHI_SYNCBOARD_OWNER_A_91d4',
    count: 3,
};
const OWNER_B_VALUE = {
    marker: 'PHI_SYNCBOARD_OWNER_B_3a62',
    count: 8,
};

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

async function spawnPi(
    request: APIRequestContext,
    owner: PhiServer,
    title: string,
): Promise<string> {
    const response = await request.post(`${owner.url}/api/terminals`, {
        data: { coder: 'pi', cwd: realpathSync(owner.dir), title },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { pane_id: string }).pane_id;
}

async function waitForTool(
    request: APIRequestContext,
    owner: PhiServer,
    paneID: string,
    observerPath: string,
): Promise<void> {
    await expect
        .poll(() => paneBridge(request, owner.url, paneID), { timeout: 30_000 })
        .toMatchObject({
            state: 'managed',
            connected: true,
            model: `${SYNCBOARD_PROVIDER}/${SYNCBOARD_MODEL}`,
            capabilities: expect.arrayContaining(['pi.syncboard.v1']),
        });
    await expect
        .poll(() => readSyncboardObserver(observerPath), { timeout: 30_000 })
        .toContainEqual(expect.objectContaining({ available: true }));
}

function expectedMessage(value: unknown) {
    return {
        key: SYNCBOARD_KEY,
        value: JSON.stringify(value),
        created_at: expect.any(String),
        updated_at: expect.any(String),
    };
}

test('each real Pi session routes the same key to its owning coordinator', async ({
    request,
}) => {
    test.setTimeout(180_000);
    const providers: SyncboardProvider[] = [];
    const servers: PhiServer[] = [];
    let fixtureA: ReturnType<typeof seedSyncboardPi> | undefined;
    let fixtureB: ReturnType<typeof seedSyncboardPi> | undefined;
    try {
        const providerA = await startSyncboardProvider({
            value: OWNER_A_VALUE,
        });
        providers.push(providerA);
        const providerB = await startSyncboardProvider({
            value: OWNER_B_VALUE,
        });
        providers.push(providerB);

        const coordinatorA = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        });
        servers.push(coordinatorA);
        const coordinatorB = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        });
        servers.push(coordinatorB);
        const ownerA = await startPhi({
            config: {
                auto_reconnect: 'off',
                sync_coordinator: coordinatorA.url,
            },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                fixtureA = seedSyncboardPi(dir, providerA.port);
            },
        });
        servers.push(ownerA);
        const ownerB = await startPhi({
            config: {
                auto_reconnect: 'off',
                sync_coordinator: coordinatorB.url,
            },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                fixtureB = seedSyncboardPi(dir, providerB.port);
            },
        });
        servers.push(ownerB);
        if (!fixtureA || !fixtureB)
            throw new Error('Syncboard Pi fixture was not seeded');

        const identities = [
            coordinatorA.identity,
            coordinatorB.identity,
            ownerA.identity,
            ownerB.identity,
        ];
        expect(new Set(identities.map((identity) => identity.pid)).size).toBe(
            4,
        );
        expect(new Set(identities.map((identity) => identity.port)).size).toBe(
            4,
        );
        expect(new Set(identities.map((identity) => identity.dir)).size).toBe(
            4,
        );

        const [paneA, paneB] = await Promise.all([
            spawnPi(request, ownerA, 'Pi Syncboard owner A'),
            spawnPi(request, ownerB, 'Pi Syncboard owner B'),
        ]);
        await Promise.all([
            waitForTool(request, ownerA, paneA, fixtureA.observerPath),
            waitForTool(request, ownerB, paneB, fixtureB.observerPath),
        ]);
        const initialBridgeB = await paneBridge(request, ownerB.url, paneB);
        expect(initialBridgeB).toMatchObject({
            state: 'managed',
            connected: true,
            capabilities: expect.arrayContaining(['pi.syncboard.v1']),
        });

        const [promptA, promptB] = await Promise.all([
            request.post(`${ownerA.url}/api/terminals/${paneA}/input`, {
                data: { text: `Upsert ${SYNCBOARD_KEY}, then list Syncboard.` },
            }),
            request.post(`${ownerB.url}/api/terminals/${paneB}/input`, {
                data: { text: `Upsert ${SYNCBOARD_KEY}, then list Syncboard.` },
            }),
        ]);
        expect(promptA.status()).toBe(204);
        expect(promptB.status()).toBe(204);
        await Promise.all([
            providerA.waitForRequestCount(3, 30_000),
            providerB.waitForRequestCount(3, 30_000),
        ]);
        await expect
            .poll(() => providerA.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ upsert: true, list: true, error: '' });
        await expect
            .poll(() => providerB.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ upsert: true, list: true, error: '' });
        expect(providerA.requestCount()).toBe(3);
        expect(providerB.requestCount()).toBe(3);

        const changedKey = 'pi-native-syncboard-owner-a-after-switch';
        const changedValue = {
            marker: 'PHI_SYNCBOARD_AFTER_COORDINATOR_SWITCH_6f2c',
            count: 5,
        };
        providerA.queueFollowup([
            {
                operation: 'list',
                expectedKey: SYNCBOARD_KEY,
                expectedValue: OWNER_B_VALUE,
            },
            {
                operation: 'upsert',
                key: changedKey,
                value: changedValue,
                expectedKey: changedKey,
                expectedValue: changedValue,
            },
            {
                operation: 'get',
                key: changedKey,
                expectedKey: changedKey,
                expectedValue: changedValue,
            },
            {
                operation: 'get',
                key: `${changedKey}-missing`,
                expectedKey: `${changedKey}-missing`,
                expectedFound: false,
            },
            {
                operation: 'delete',
                key: changedKey,
                expectedKey: changedKey,
                expectedAlreadyAbsent: false,
            },
            {
                operation: 'delete',
                key: changedKey,
                expectedKey: changedKey,
                expectedAlreadyAbsent: true,
            },
        ]);
        const beforeChange = await paneBridge(request, ownerA.url, paneA);
        expect(beforeChange).toMatchObject({
            state: 'managed',
            connected: true,
            capabilities: expect.arrayContaining(['pi.syncboard.v1']),
        });
        expect(beforeChange?.generation).toBeTruthy();
        const configChange = await request.post(
            `${ownerA.url}/api/config/sync-coordinator`,
            {
                data: { sync_coordinator: coordinatorB.url },
            },
        );
        expect(configChange.status()).toBe(200);
        const effectiveConfig = await request.get(`${ownerA.url}/api/config`);
        expect(effectiveConfig.status()).toBe(200);
        const effectiveConfigBody = (await effectiveConfig.json()) as Record<
            string,
            unknown
        >;
        expect(effectiveConfigBody['sync_coordinator']).toBe(coordinatorB.url);
        await expect
            .poll(() => paneBridge(request, ownerA.url, paneA), {
                timeout: 10_000,
            })
            .toMatchObject({
                state: beforeChange?.state,
                connected: beforeChange?.connected,
                model: beforeChange?.model,
                generation: beforeChange?.generation,
                capabilities: expect.arrayContaining(['pi.syncboard.v1']),
            });
        const switchedPrompt = await request.post(
            `${ownerA.url}/api/terminals/${paneA}/input`,
            {
                data: {
                    text: 'List the current Syncboard board, then upsert my new owner key.',
                },
            },
        );
        expect(switchedPrompt.status()).toBe(204);
        await providerA.waitForRequestCount(10, 30_000);
        await expect
            .poll(() => providerA.resultChecks(), { timeout: 10_000 })
            .toMatchObject({
                followup: [true, true, true, true, true, true],
                error: '',
            });
        expect(providerA.requestCount()).toBe(10);
        expect(providerB.requestCount()).toBe(3);
        const [configBResponse, bridgeBAfterSwitch] = await Promise.all([
            request.get(`${ownerB.url}/api/config`),
            paneBridge(request, ownerB.url, paneB),
        ]);
        expect(configBResponse.status()).toBe(200);
        expect(
            ((await configBResponse.json()) as Record<string, unknown>)[
                'sync_coordinator'
            ],
        ).toBe(coordinatorB.url);
        expect(bridgeBAfterSwitch).toMatchObject({
            state: initialBridgeB?.state,
            connected: initialBridgeB?.connected,
            model: initialBridgeB?.model,
            generation: initialBridgeB?.generation,
            capabilities: expect.arrayContaining(['pi.syncboard.v1']),
        });

        const [remoteA, remoteB, localA, localB] = await Promise.all([
            request.get(`${coordinatorA.url}/api/sync/messages`),
            request.get(`${coordinatorB.url}/api/sync/messages`),
            request.get(`${ownerA.url}/api/sync/messages`),
            request.get(`${ownerB.url}/api/sync/messages`),
        ]);
        expect([remoteA.ok(), remoteB.ok(), localA.ok(), localB.ok()]).toEqual([
            true,
            true,
            true,
            true,
        ]);
        const remoteMessagesA = (await remoteA.json()) as Array<{
            key: string;
        }>;
        const remoteMessagesB = (await remoteB.json()) as Array<{
            key: string;
        }>;
        const localMessagesA = (await localA.json()) as Array<{ key: string }>;
        const localMessagesB = (await localB.json()) as Array<{ key: string }>;
        expect(remoteMessagesA).toEqual([expectedMessage(OWNER_A_VALUE)]);
        expect(remoteMessagesB).toEqual([expectedMessage(OWNER_B_VALUE)]);
        expect(
            remoteMessagesA.some((message) => message.key === changedKey),
        ).toBe(false);
        expect(
            localMessagesA.some(
                (message) =>
                    message.key === SYNCBOARD_KEY || message.key === changedKey,
            ),
        ).toBe(false);
        expect(
            localMessagesB.some(
                (message) =>
                    message.key === SYNCBOARD_KEY || message.key === changedKey,
            ),
        ).toBe(false);

        await test.info().attach('syncboard-routing-evidence.json', {
            body: Buffer.from(
                JSON.stringify(
                    {
                        coordinatorA: coordinatorA.identity,
                        coordinatorB: coordinatorB.identity,
                        ownerA: ownerA.identity,
                        ownerB: ownerB.identity,
                        capability: 'pi.syncboard.v1',
                        piToolAvailabilityA: readSyncboardObserver(
                            fixtureA.observerPath,
                        ),
                        piToolAvailabilityB: readSyncboardObserver(
                            fixtureB.observerPath,
                        ),
                        providerCalls: {
                            ownerA: providerA.requestCount(),
                            ownerB: providerB.requestCount(),
                        },
                        configAfterOwnerASwitch:
                            effectiveConfigBody['sync_coordinator'],
                        toolResults: {
                            ownerA: providerA.resultChecks(),
                            ownerB: providerB.resultChecks(),
                        },
                        coordinatorMessagesA: remoteMessagesA,
                        coordinatorMessagesB: remoteMessagesB,
                        ownerLocalMessagesA: localMessagesA,
                        ownerLocalMessagesB: localMessagesB,
                    },
                    null,
                    2,
                ),
            ),
            contentType: 'application/json',
        });
    } finally {
        try {
            await Promise.all(servers.reverse().map((server) => server.stop()));
        } finally {
            await Promise.all(providers.map((provider) => provider.close()));
        }
    }
});
