import { readdirSync, realpathSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { join } from 'node:path';
import { startBridgeProxy, type BridgeProxy } from './_pi-bridge-proxy.js';
import { startPhi, type PhiServer } from './_server.js';
import {
    readSyncboardObserver,
    seedSyncboardPi,
    startHeldSyncboardCoordinator,
    startSyncboardProvider,
    SYNCBOARD_KEY,
    SYNCBOARD_MODEL,
    SYNCBOARD_PROVIDER,
    SYNCBOARD_PROXY_NAME,
    SYNCBOARD_VALUE,
    type HeldSyncboardCoordinator,
    type SyncboardProvider,
} from './_pi-syncboard.js';

interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
    generation?: string;
    capabilities?: string[];
}

async function paneBridge(
    request: APIRequestContext,
    owner: PhiServer,
    paneID: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${owner.url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

async function startOwner(
    request: APIRequestContext,
    provider: SyncboardProvider,
    coordinator: HeldSyncboardCoordinator,
): Promise<{
    owner: PhiServer;
    proxy: BridgeProxy;
    paneID: string;
    observerPath: string;
}> {
    let fixture: ReturnType<typeof seedSyncboardPi> | undefined;
    const owner = await startPhi({
        config: {
            auto_reconnect: 'off',
            sync_coordinator: `http://127.0.0.1:${coordinator.port}`,
        },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            fixture = seedSyncboardPi(dir, provider.port, { viaProxy: true });
        },
    });
    if (!fixture) {
        await owner.stop();
        throw new Error('Syncboard Pi fixture was not seeded');
    }
    const runTmp = join(owner.dir, 't');
    const upstreams = readdirSync(runTmp, { withFileTypes: true })
        .filter(
            (entry) => entry.isDirectory() && entry.name.startsWith('phi-pi-'),
        )
        .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
    expect(upstreams).toHaveLength(1);
    const proxy = await startBridgeProxy(
        owner.dir,
        upstreams[0] as string,
        join(runTmp, SYNCBOARD_PROXY_NAME),
    );
    const spawned = await request.post(`${owner.url}/api/terminals`, {
        data: {
            coder: 'pi',
            cwd: realpathSync(owner.dir),
            title: 'Pi Syncboard uncertainty',
        },
    });
    expect(spawned.ok()).toBe(true);
    return {
        owner,
        proxy,
        paneID: ((await spawned.json()) as { pane_id: string }).pane_id,
        observerPath: fixture.observerPath,
    };
}

async function waitForConnectedTool(
    request: APIRequestContext,
    owner: PhiServer,
    paneID: string,
    observerPath: string,
): Promise<string> {
    await expect
        .poll(() => paneBridge(request, owner, paneID), { timeout: 30_000 })
        .toMatchObject({
            state: 'managed',
            connected: true,
            model: `${SYNCBOARD_PROVIDER}/${SYNCBOARD_MODEL}`,
            capabilities: expect.arrayContaining(['pi.syncboard.v1']),
        });
    await expect
        .poll(() => readSyncboardObserver(observerPath), { timeout: 30_000 })
        .toContainEqual(expect.objectContaining({ available: true }));
    return (await paneBridge(request, owner, paneID))?.generation ?? '';
}

async function sendPrompt(
    request: APIRequestContext,
    owner: PhiServer,
    paneID: string,
    text: string,
): Promise<void> {
    const response = await request.post(
        `${owner.url}/api/terminals/${paneID}/input`,
        {
            data: { text },
        },
    );
    expect(response.status()).toBe(204);
}

async function assertReconnectAndRead(
    request: APIRequestContext,
    provider: SyncboardProvider,
    coordinator: HeldSyncboardCoordinator,
    owner: PhiServer,
    proxy: BridgeProxy,
    paneID: string,
    generation: string,
): Promise<void> {
    provider.queueFollowup([
        {
            operation: 'get',
            key: SYNCBOARD_KEY,
            expectedKey: SYNCBOARD_KEY,
            expectedValue: SYNCBOARD_VALUE,
        },
    ]);
    await proxy.resume();
    await expect
        .poll(
            async () => {
                const view = await paneBridge(request, owner, paneID);
                return (
                    view?.connected === true &&
                    view.generation === generation &&
                    proxy.forwarded() >= 2
                );
            },
            { timeout: 30_000 },
        )
        .toBe(true);
    await sendPrompt(
        request,
        owner,
        paneID,
        'Read the Syncboard key to confirm its saved value.',
    );
    await provider.waitForRequestCount(4, 30_000);
    await expect
        .poll(() => provider.resultChecks(), { timeout: 10_000 })
        .toMatchObject({ followup: [true], error: '' });
    expect(coordinator.requestCount()).toBe(2);
    expect(coordinator.mutationCount()).toBe(1);
    expect(coordinator.message(SYNCBOARD_KEY)).toMatchObject({
        key: SYNCBOARD_KEY,
        value: JSON.stringify(SYNCBOARD_VALUE),
    });
}

test('committed upsert reports unknown after bridge loss and is not replayed', async ({
    request,
}) => {
    test.setTimeout(180_000);
    let provider: SyncboardProvider | undefined;
    let coordinator: HeldSyncboardCoordinator | undefined;
    let owner: PhiServer | undefined;
    let proxy: BridgeProxy | undefined;
    try {
        provider = await startSyncboardProvider({ expectUnknownUpsert: true });
        coordinator = await startHeldSyncboardCoordinator();
        const fixture = await startOwner(request, provider, coordinator);
        owner = fixture.owner;
        proxy = fixture.proxy;
        const generation = await waitForConnectedTool(
            request,
            owner,
            fixture.paneID,
            fixture.observerPath,
        );
        await sendPrompt(
            request,
            owner,
            fixture.paneID,
            `Upsert ${SYNCBOARD_KEY} to Syncboard.`,
        );
        await coordinator.waitForAppliedMutation();
        expect(coordinator.mutationCount()).toBe(1);
        expect(coordinator.message(SYNCBOARD_KEY)?.value).toBe(
            JSON.stringify(SYNCBOARD_VALUE),
        );

        await proxy.drop();
        await expect
            .poll(() => paneBridge(request, owner!, fixture.paneID), {
                timeout: 10_000,
            })
            .toMatchObject({ connected: false });
        await provider.waitForRequestCount(2, 30_000);
        await expect
            .poll(() => provider!.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ unknownUpsert: true, error: '' });
        expect(provider.resultChecks().upsertResult).toContain(
            'Outcome unknown. Do not retry automatically.',
        );

        coordinator.releaseResponse();
        await assertReconnectAndRead(
            request,
            provider,
            coordinator,
            owner,
            proxy,
            fixture.paneID,
            generation,
        );
    } finally {
        await proxy?.close();
        await owner?.stop();
        await coordinator?.close();
        await provider?.close();
    }
});

test('remote HTTP deadline settles as unknown within the caller budget and is not replayed', async ({
    request,
}) => {
    test.setTimeout(180_000);
    let provider: SyncboardProvider | undefined;
    let coordinator: HeldSyncboardCoordinator | undefined;
    let owner: PhiServer | undefined;
    let proxy: BridgeProxy | undefined;
    try {
        provider = await startSyncboardProvider({ expectUnknownUpsert: true });
        coordinator = await startHeldSyncboardCoordinator();
        const fixture = await startOwner(request, provider, coordinator);
        owner = fixture.owner;
        proxy = fixture.proxy;
        const generation = await waitForConnectedTool(
            request,
            owner,
            fixture.paneID,
            fixture.observerPath,
        );
        await sendPrompt(
            request,
            owner,
            fixture.paneID,
            `Upsert ${SYNCBOARD_KEY} to Syncboard.`,
        );
        await coordinator.waitForAppliedMutation();

        // The coordinator commits immediately but withholds its HTTP response.
        // The Phi HTTP deadline is 10s; the Pi tool caller allows 15s.
        await provider.waitForRequestCount(2, 20_000);
        await expect
            .poll(() => provider!.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ unknownUpsert: true, error: '' });
        expect(provider.resultChecks().upsertResult).toContain('timeout');
        expect(coordinator.mutationCount()).toBe(1);
        coordinator.releaseResponse();

        await proxy.drop();
        await expect
            .poll(() => paneBridge(request, owner!, fixture.paneID), {
                timeout: 10_000,
            })
            .toMatchObject({ connected: false });
        await assertReconnectAndRead(
            request,
            provider,
            coordinator,
            owner,
            proxy,
            fixture.paneID,
            generation,
        );
    } finally {
        await proxy?.close();
        await owner?.stop();
        await coordinator?.close();
        await provider?.close();
    }
});
