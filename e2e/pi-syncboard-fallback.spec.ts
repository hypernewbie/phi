import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    readSyncboardObserver,
    seedSyncboardPi,
    startBuiltinReadProvider,
    startHeldSyncboardCoordinator,
    type BuiltinReadProvider,
    type HeldSyncboardCoordinator,
} from './_pi-syncboard.js';

const FALLBACK_FILE = 'syncboard-fallback.txt';
const FALLBACK_CONTENT = 'PHI_SYNCBOARD_FALLBACK_READ_OK';

async function exerciseBridgeFreeFallback(
    request: APIRequestContext,
    options: { injectionDisabled?: boolean; piBridgeDisabled?: boolean },
): Promise<void> {
    let provider: BuiltinReadProvider | undefined;
    let coordinator: HeldSyncboardCoordinator | undefined;
    let owner: PhiServer | undefined;
    let observerPath = '';
    let filePath = '';
    try {
        provider = await startBuiltinReadProvider(
            () => filePath,
            FALLBACK_CONTENT,
        );
        coordinator = await startHeldSyncboardCoordinator();
        owner = await startPhi({
            config: {
                auto_reconnect: 'off',
                sync_coordinator: `http://127.0.0.1:${coordinator.port}`,
                ...(options.injectionDisabled
                    ? { pi_bridge_no_inject: true }
                    : {}),
            },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                filePath = join(realpathSync(dir), FALLBACK_FILE);
                writeFileSync(filePath, FALLBACK_CONTENT);
                const fixture = seedSyncboardPi(dir, provider!.port, {
                    phiBridgeDisabled: options.piBridgeDisabled,
                });
                observerPath = fixture.observerPath;
            },
        });
        if (!observerPath || !filePath)
            throw new Error('fallback fixture was not seeded');

        const spawned = await request.post(`${owner.url}/api/terminals`, {
            data: {
                coder: 'pi',
                cwd: realpathSync(owner.dir),
                title: 'Pi bridge-free fallback',
            },
        });
        expect(spawned.ok()).toBe(true);
        const paneID = ((await spawned.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => readSyncboardObserver(observerPath), {
                timeout: 30_000,
            })
            .toContainEqual({ available: false, at: expect.any(Number) });

        const prompt = await request.post(
            `${owner.url}/api/terminals/${paneID}/input`,
            {
                data: {
                    text: `Read ${FALLBACK_FILE} and return its contents.`,
                },
            },
        );
        expect(prompt.status()).toBe(204);
        await provider.waitForRequestCount(2, 30_000);
        await expect
            .poll(
                () => ({
                    checked: provider!.resultChecked(),
                    error: provider!.error(),
                }),
                {
                    timeout: 10_000,
                },
            )
            .toEqual({ checked: true, error: '' });
        expect(provider.requestCount()).toBe(2);
        expect(coordinator.requestCount()).toBe(0);
        expect(coordinator.mutationCount()).toBe(0);
    } finally {
        await owner?.stop();
        await coordinator?.close();
        await provider?.close();
    }
}

for (const scenario of [
    { name: 'Phi bridge injection disabled', injectionDisabled: true },
    { name: 'Pi-side bridge disabled', piBridgeDisabled: true },
]) {
    test(`preserves built-in Pi tools when ${scenario.name.toLowerCase()}`, async ({
        request,
    }) => {
        test.setTimeout(180_000);
        await exerciseBridgeFreeFallback(request, scenario);
    });
}
