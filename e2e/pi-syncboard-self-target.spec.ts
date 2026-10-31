import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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
    capabilities?: string[];
}

const LOCAL_VALUE = {
    marker: 'PHI_SYNCBOARD_LOCAL_OWNER_4b8e',
    count: 11,
};

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

async function spawnPi(
    request: APIRequestContext,
    owner: PhiServer,
): Promise<string> {
    const response = await request.post(`${owner.url}/api/terminals`, {
        data: {
            coder: 'pi',
            cwd: realpathSync(owner.dir),
            title: 'Pi Syncboard self-target',
        },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { pane_id: string }).pane_id;
}

test('unset coordinator keeps real Pi Syncboard CRUD on the owning Phi store', async ({
    request,
}) => {
    test.setTimeout(150_000);
    let provider: SyncboardProvider | undefined;
    let owner: PhiServer | undefined;
    let fixture: ReturnType<typeof seedSyncboardPi> | undefined;
    try {
        provider = await startSyncboardProvider({ value: LOCAL_VALUE });
        owner = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                fixture = seedSyncboardPi(dir, provider!.port);
            },
        });
        if (!fixture) throw new Error('Syncboard Pi fixture was not seeded');
        const paneID = await spawnPi(request, owner);
        await expect
            .poll(() => paneBridge(request, owner!, paneID), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                model: `${SYNCBOARD_PROVIDER}/${SYNCBOARD_MODEL}`,
                capabilities: expect.arrayContaining(['pi.syncboard.v1']),
            });
        await expect
            .poll(() => readSyncboardObserver(fixture!.observerPath), {
                timeout: 30_000,
            })
            .toContainEqual(expect.objectContaining({ available: true }));

        const configResponse = await request.get(`${owner.url}/api/config`);
        expect(configResponse.status()).toBe(200);
        const config = (await configResponse.json()) as Record<string, unknown>;
        expect(
            readFileSync(
                join(owner.dir, 'home', '.phi', 'config.toml'),
                'utf8',
            ),
        ).toContain('sync_coordinator = ""');
        expect(config['sync_coordinator']).toBe(owner.url);

        const firstPrompt = await request.post(
            `${owner.url}/api/terminals/${paneID}/input`,
            {
                data: {
                    text: `Add ${SYNCBOARD_KEY} to Syncboard, then read the board.`,
                },
            },
        );
        expect(firstPrompt.status()).toBe(204);
        await provider.waitForRequestCount(3, 30_000);
        await expect
            .poll(() => provider!.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ upsert: true, list: true, error: '' });

        const localAfterUpsertResponse = await request.get(
            `${owner.url}/api/sync/messages`,
        );
        expect(localAfterUpsertResponse.status()).toBe(200);
        const localAfterUpsert =
            (await localAfterUpsertResponse.json()) as Array<{
                key: string;
                value: string;
            }>;
        expect(localAfterUpsert).toEqual([
            {
                key: SYNCBOARD_KEY,
                value: JSON.stringify(LOCAL_VALUE),
                created_at: expect.any(String),
                updated_at: expect.any(String),
            },
        ]);

        provider.queueFollowup([
            {
                operation: 'get',
                key: SYNCBOARD_KEY,
                expectedKey: SYNCBOARD_KEY,
                expectedValue: LOCAL_VALUE,
            },
            {
                operation: 'get',
                key: `${SYNCBOARD_KEY}-missing`,
                expectedKey: `${SYNCBOARD_KEY}-missing`,
                expectedFound: false,
            },
            {
                operation: 'delete',
                key: SYNCBOARD_KEY,
                expectedKey: SYNCBOARD_KEY,
                expectedAlreadyAbsent: false,
            },
            {
                operation: 'delete',
                key: SYNCBOARD_KEY,
                expectedKey: SYNCBOARD_KEY,
                expectedAlreadyAbsent: true,
            },
        ]);
        const secondPrompt = await request.post(
            `${owner.url}/api/terminals/${paneID}/input`,
            {
                data: {
                    text: 'Get the saved key, check one missing key, then delete the saved key twice.',
                },
            },
        );
        expect(secondPrompt.status()).toBe(204);
        await provider.waitForRequestCount(8, 30_000);
        await expect
            .poll(() => provider!.resultChecks(), { timeout: 10_000 })
            .toMatchObject({ followup: [true, true, true, true], error: '' });

        const localAfterDeleteResponse = await request.get(
            `${owner.url}/api/sync/messages`,
        );
        expect(localAfterDeleteResponse.status()).toBe(200);
        const localAfterDelete = await localAfterDeleteResponse.json();
        expect(localAfterDelete).toEqual([]);
        await test.info().attach('syncboard-self-target-evidence.json', {
            body: Buffer.from(
                JSON.stringify(
                    {
                        owner: owner.identity,
                        capability: 'pi.syncboard.v1',
                        coordinatorConfig: config['sync_coordinator'],
                        toolAvailability: readSyncboardObserver(
                            fixture.observerPath,
                        ),
                        providerRequests: provider.requestCount(),
                        toolResults: provider.resultChecks(),
                        localAfterUpsert,
                        localAfterDelete,
                    },
                    null,
                    2,
                ),
            ),
            contentType: 'application/json',
        });
    } finally {
        if (owner) await owner.stop();
        if (provider) await provider.close();
    }
});
