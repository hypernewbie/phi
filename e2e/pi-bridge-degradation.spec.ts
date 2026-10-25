import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
    type Request,
} from '@playwright/test';
import { startPhi } from './_server.js';

interface BridgeView {
    state?: string;
    connected?: boolean;
    capabilities?: string[];
}

interface TerminalView {
    id: string;
    coder: string;
    pi_bridge?: BridgeView;
}

async function terminals(request: APIRequestContext, url: string) {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return [] as TerminalView[];
    return (await response.json()) as TerminalView[];
}

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneId: string,
) {
    return (await terminals(request, url)).find((pane) => pane.id === paneId)
        ?.pi_bridge;
}

type ObservationPhase = 'initial-attach' | 'active';

// A tab burst can abort several fire-and-forget pin uploads; the cap only
// exists so a genuine retry loop cannot pass as expected noise.
const PIN_ABORT_LIMIT = 40;

interface FailedRequest {
    request: Request;
    requestPhase: ObservationPhase;
    failurePhase: ObservationPhase;
    errorText: string;
}

interface ResponseEvidence {
    status: number;
    contentLength: string | undefined;
    phase: ObservationPhase;
}

async function watchBrowser(page: Page, fixtureUrl: string, paneIds: string[]) {
    const origin = new URL(fixtureUrl).origin;
    const externalRequests: string[] = [];
    const failedRequests: FailedRequest[] = [];
    const httpFailures: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const requestPhases = new WeakMap<Request, ObservationPhase>();
    const responses = new Map<Request, ResponseEvidence>();
    const historyRequests: string[] = [];
    const modelSwitchRequests: string[] = [];
    let phase: ObservationPhase = 'initial-attach';
    let proxyInterceptions = 0;
    let updaterInterceptions = 0;

    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
        requestPhases.set(request, phase);
        const url = new URL(request.url());
        if (
            url.origin === origin &&
            request.method() === 'GET' &&
            url.pathname === '/api/pi-history'
        ) {
            historyRequests.push(request.url());
        }
        if (
            url.origin === origin &&
            request.method() === 'POST' &&
            url.pathname === '/api/pi-bridge/model'
        ) {
            modelSwitchRequests.push(request.url());
        }
    });
    page.on('response', (response) => {
        const request = response.request();
        const responsePhase = phase;
        const evidence = {
            status: response.status(),
            contentLength: response.headers()['content-length'],
            phase: responsePhase,
        };
        responses.set(request, evidence);
        if (evidence.status >= 400) {
            httpFailures.push(
                `${request.method()} ${request.url()}: HTTP ${evidence.status} (${responsePhase})`,
            );
        }
    });
    page.on('requestfailed', (request) =>
        failedRequests.push({
            request,
            requestPhase: requestPhases.get(request) ?? 'active',
            failurePhase: phase,
            errorText: request.failure()?.errorText ?? '',
        }),
    );

    // Register the broad guard first so the specific local routes below get
    // the first chance to fulfill their fixture-only requests.
    await page.route('**/*', (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== origin) {
            externalRequests.push(requestUrl.href);
            return route.abort();
        }
        return route.fallback();
    });
    await page.route('**/api/proxy?*', (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== origin) {
            externalRequests.push(requestUrl.href);
            return route.abort();
        }
        proxyInterceptions++;
        return route.fulfill({ json: [] });
    });
    await page.route('**/api/update/status*', (route) => {
        const request = route.request();
        const requestUrl = new URL(request.url());
        if (
            request.method() !== 'GET' ||
            requestUrl.origin !== origin ||
            requestUrl.pathname !== '/api/update/status' ||
            requestUrl.search !== ''
        ) {
            return route.fallback();
        }
        updaterInterceptions++;
        return route.fulfill({
            json: {
                current: 'dev',
                latest: '',
                update_available: false,
                install_method: 'unknown',
                instructions: '',
            },
        });
    });

    return {
        externalRequests,
        consoleErrors,
        pageErrors,
        historyRequests,
        modelSwitchRequests,
        proxyInterceptions: () => proxyInterceptions,
        updaterInterceptions: () => updaterInterceptions,
        finishInitialAttach: () => {
            phase = 'active';
        },
        networkEvidence() {
            const expectedPinAborts: Array<{
                paneId: string;
                phase: ObservationPhase;
                method: string;
                responseStatus: number | null;
                contentLength: string | undefined;
                errorText: string;
            }> = [];
            const unexpectedFailures: string[] = [];
            // Fire-and-forget pin posts can lose their connection after the
            // 200 lands. Callers never read that response, so up to two aborts
            // per pane and phase are accounted here instead of failing the
            // run; a third would mean a retry loop.
            const acceptedPinCounts = new Map<string, number>();

            for (const failure of failedRequests) {
                const request = failure.request;
                const url = new URL(request.url());
                const pin = /^\/api\/terminals\/([^/]+)\/pin$/.exec(
                    url.pathname,
                );
                const response = responses.get(request);
                const paneId = pin?.[1];
                const pinKey = `${paneId}:${failure.requestPhase}`;
                const seenCount = acceptedPinCounts.get(pinKey) ?? 0;
                // The pin handler answers before draining the tiny JSON body,
                // so Chromium reports aborted uploads whenever a burst of tab
                // activity outruns the drain. Each recorded response must
                // still be a 200 with an empty body, and the total is capped
                // so a real retry loop cannot hide here.
                const answeredCleanly =
                    response === undefined ||
                    (response.status === 200 && response.contentLength === '0');
                const isExpectedPinAbort =
                    url.origin === origin &&
                    request.method() === 'POST' &&
                    !!paneId &&
                    paneIds.includes(paneId) &&
                    expectedPinAborts.length < PIN_ABORT_LIMIT &&
                    answeredCleanly &&
                    failure.errorText === 'net::ERR_ABORTED';
                if (isExpectedPinAbort) {
                    acceptedPinCounts.set(pinKey, seenCount + 1);
                    expectedPinAborts.push({
                        paneId,
                        phase: failure.requestPhase,
                        method: request.method(),
                        responseStatus: response?.status ?? null,
                        contentLength: response?.contentLength,
                        errorText: failure.errorText,
                    });
                } else {
                    const why = [
                        `pane=${paneId ?? '?'}`,
                        `response=${response ? `${response.status}/${response.contentLength}` : 'none'}`,
                        `seen=${seenCount}`,
                        `accepted=${expectedPinAborts.length}`,
                        `limit=${PIN_ABORT_LIMIT}`,
                    ].join(',');
                    unexpectedFailures.push(
                        `${request.method()} ${request.url()}: ${failure.errorText} (${failure.failurePhase}) [${why}]`,
                    );
                }
            }

            return { expectedPinAborts, unexpectedFailures, httpFailures };
        },
    };
}

test('native Pi bridge disable keeps the PTY and static Models on one pane', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const staticPreset = 'fixture/static-model';
    const settings = {
        defaultProjectTrust: 'never',
        quietStartup: true,
        enableInstallTelemetry: false,
        cacheWarming: 'off',
    };
    const phi = await startPhi({
        config: {
            auto_reconnect: 'off',
            model_presets: { pi: [staticPreset] },
        },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            ANTHROPIC_API_KEY: 'dummy-sentry-key-never-used',
        },
        setup(dir) {
            const agent = join(dir, 'home', '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify(settings),
            );
            const command = join(dir, 'native-pi');
            const binary = resolve('node_modules/.bin/pi');
            writeFileSync(
                command,
                `#!/bin/sh\nexec '${binary.replaceAll("'", "'\\''")}' --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                { mode: 0o755 },
            );
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
            writeFileSync(
                join(backends, 'opencode.json'),
                JSON.stringify({ id: 'opencode', session_source: 'none' }),
            );
        },
    });

    try {
        const cwd = phi.dir;
        const versionResponse = await request.get(`${phi.url}/api/version`);
        expect(versionResponse.status()).toBe(200);
        const version = (await versionResponse.json()) as {
            build_source?: string;
        };
        expect(version.build_source).toBe('source');

        const sessionsResponse = await request.get(
            `${phi.url}/api/sessions?coder=opencode&cwd=${encodeURIComponent(cwd)}`,
        );
        expect(sessionsResponse.status()).toBe(200);
        expect(await sessionsResponse.json()).toEqual([]);

        const spawnPi = async (title: string) => {
            const response = await request.post(`${phi.url}/api/terminals`, {
                data: { coder: 'pi', cwd, title },
            });
            expect(response.ok()).toBe(true);
            return ((await response.json()) as { pane_id: string }).pane_id;
        };
        const targetPane = await spawnPi('Disable target');
        const livePane = await spawnPi('Bridge remains live');
        for (const paneId of [targetPane, livePane]) {
            await expect
                .poll(() => paneBridge(request, phi.url, paneId), {
                    timeout: 30_000,
                })
                .toMatchObject({ state: 'managed', connected: true });
        }

        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);
        const browser = await watchBrowser(page, phi.url, [
            targetPane,
            livePane,
        ]);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await expect
            .poll(() => browser.updaterInterceptions())
            .toBeGreaterThan(0);
        test.info().annotations.push({
            type: 'optional-service-fixture-double',
            description: `Exact fixture GET /api/update/status interceptions: ${browser.updaterInterceptions()}; not updater correctness.`,
        });

        const targetTab = page.locator(`.tab[data-pane-id="${targetPane}"]`);
        const liveTab = page.locator(`.tab[data-pane-id="${livePane}"]`);
        await expect(targetTab).toBeVisible({ timeout: 15_000 });
        await expect(liveTab).toBeVisible({ timeout: 15_000 });
        for (const paneId of [targetPane, livePane]) {
            await expect(
                page.locator(`#term-${paneId} .tab-loader`),
            ).toBeHidden({ timeout: 30_000 });
        }
        browser.finishInitialAttach();
        await targetTab.click();

        const settingsPath = join(
            phi.dir,
            'home',
            '.pi',
            'agent',
            'settings.json',
        );
        writeFileSync(
            settingsPath,
            JSON.stringify({ ...settings, phiBridge: { enabled: false } }),
        );
        const staged = page.locator('#input-textarea');
        await staged.fill('/reload');
        await staged.press('Enter');
        await expect(staged).toHaveValue('', { timeout: 10_000 });
        await expect
            .poll(() => paneBridge(request, phi.url, targetPane), {
                timeout: 20_000,
            })
            .toMatchObject({ state: 'managed', connected: false });
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ state: 'managed', connected: true });

        const afterDisable = await terminals(request, phi.url);
        expect(
            afterDisable.filter((pane) =>
                [targetPane, livePane].includes(pane.id),
            ),
        ).toHaveLength(2);

        const modelsButton = page
            .locator('#presets-container')
            .getByRole('button', { name: /Models/ });
        await expect(modelsButton).toBeVisible();
        await expect(modelsButton).not.toHaveClass(/pi-rpc-model-trigger/);
        await modelsButton.click();
        const staticDropup = page.locator('#model-presets-dropup');
        await expect(staticDropup).toBeVisible();
        await expect(
            staticDropup.getByRole('button', {
                name: staticPreset,
                exact: true,
            }),
        ).toBeVisible();

        const marker = join(phi.dir, 'target-pty.marker');
        const markerText = 'target-pi-pty-executed';
        await staged.fill(
            `!printf '%s\\n' '${markerText}' > '${marker.replaceAll("'", "'\\''")}'`,
        );
        await staged.press('Enter');
        await expect(staged).toHaveValue('', { timeout: 10_000 });
        await expect
            .poll(
                () => (existsSync(marker) ? readFileSync(marker, 'utf8') : ''),
                { timeout: 15_000 },
            )
            .toContain(markerText);
        const afterCommand = await terminals(request, phi.url);
        expect(afterCommand.some((pane) => pane.id === targetPane)).toBe(true);

        const historyMarker = join(phi.dir, 'target-history.marker');
        const historyCommand =
            '!echo bridge-free-history >> target-history.marker';
        await staged.fill(historyCommand);
        await staged.press('Enter');
        await expect(staged).toHaveValue('', { timeout: 10_000 });
        await expect
            .poll(
                () =>
                    existsSync(historyMarker)
                        ? readFileSync(historyMarker, 'utf8')
                        : '',
                { timeout: 15_000 },
            )
            .toBe('bridge-free-history\n');
        await staged.press('ArrowUp');
        await expect(staged).toHaveValue('', { timeout: 5_000 });
        await staged.press('Enter');
        await expect(staged).toHaveValue('', { timeout: 10_000 });
        await expect
            .poll(
                () =>
                    existsSync(historyMarker)
                        ? readFileSync(historyMarker, 'utf8')
                        : '',
                { timeout: 15_000 },
            )
            .toBe('bridge-free-history\nbridge-free-history\n');
        expect(
            browser.historyRequests.filter(
                (url) => new URL(url).searchParams.get('pane') === targetPane,
            ),
        ).toEqual([]);

        await liveTab.click();
        const liveModelsButton = page
            .locator('#presets-container')
            .getByRole('button', { name: /Models/ });
        await expect(liveModelsButton).toHaveClass(/pi-rpc-model-trigger/);

        // Fixture double: the still-connected pane's catalog read returns
        // the server's own unavailable result. Its bridge stays live; only
        // the list result is affected.
        await page.route('**/api/pi-bridge/models*', (route) => {
            const requestUrl = new URL(route.request().url());
            if (
                requestUrl.origin !== phi.url ||
                requestUrl.pathname !== '/api/pi-bridge/models' ||
                requestUrl.searchParams.get('pane') !== livePane
            ) {
                return route.fallback();
            }
            return route.fulfill({
                json: { models: [], truncated: false, unavailable: true },
            });
        });
        const liveDropup = page.locator('#pi-rpc-model-dropup');
        const staticFallback = liveDropup.getByRole('button', {
            name: 'Use static presets',
            exact: true,
        });
        await liveModelsButton.click();
        await expect(liveDropup).toBeVisible();
        await expect(liveDropup.locator('.pi-rpc-dropup-message')).toHaveText(
            'Pi model list unavailable',
        );
        await expect(staticFallback).toBeVisible();
        await expect(liveModelsButton).toHaveClass(/pi-rpc-model-trigger/);

        await staticFallback.focus();
        await page.keyboard.press('Enter');
        await expect(liveDropup).toBeHidden();
        await expect(staticDropup).toBeVisible();
        await expect(
            staticDropup.getByRole('button', {
                name: staticPreset,
                exact: true,
            }),
        ).toBeVisible();

        // Closing the fallback and reopening after recovery reaches the
        // live catalog again. No list fallback ever switched a model.
        await page.unroute('**/api/pi-bridge/models*');
        await liveModelsButton.click();
        await expect(staticDropup).toBeHidden();
        await expect(liveDropup).toBeVisible();
        await expect(
            liveDropup.getByRole('searchbox', { name: 'Filter Pi models' }),
        ).toBeVisible();
        await expect(
            liveDropup.locator('.pi-rpc-model-row').first(),
        ).toBeVisible({ timeout: 15_000 });
        await expect(staticFallback).toBeHidden();

        // Keyboard dismissal of the changed RPC dropup, then narrow-layout
        // and theme-token checks on the static fallback. The diff panel from
        // the staged-input proof covers a narrow viewport and the narrow
        // layout hides the tab strip, so both happen before resizing. Visual
        // and touch review stay manual.
        await page.keyboard.press('Escape');
        await expect(liveDropup).toBeHidden();
        await page.locator('#close-diff-btn').click();
        await expect(page.locator('#diff-panel')).toBeHidden();
        await targetTab.click();
        await page.setViewportSize({ width: 390, height: 844 });
        await modelsButton.click();
        await expect(staticDropup).toBeVisible();
        const staticBox = await staticDropup.boundingBox();
        expect(staticBox).not.toBeNull();
        if (!staticBox) throw new Error('static presets dropup has no box');
        expect(staticBox.x).toBeGreaterThanOrEqual(0);
        expect(staticBox.x + staticBox.width).toBeLessThanOrEqual(391);
        const staticTokens = await staticDropup
            .getByRole('button', { name: staticPreset, exact: true })
            .evaluate((el) => {
                const style = getComputedStyle(el);
                return { color: style.color, font: style.fontFamily };
            });
        expect(staticTokens.color).not.toBe('');
        expect(staticTokens.color).not.toBe('rgba(0, 0, 0, 0)');
        expect(staticTokens.font).not.toBe('');
        await page.mouse.click(5, 300);
        await expect(staticDropup).toBeHidden();
        await page.setViewportSize({ width: 1440, height: 900 });

        await expect
            .poll(() => browser.proxyInterceptions())
            .toBeGreaterThan(0);
        expect(browser.externalRequests).toEqual([]);
        expect(browser.modelSwitchRequests).toEqual([]);
        const network = browser.networkEvidence();
        expect(network.unexpectedFailures).toEqual([]);
        expect(network.httpFailures).toEqual([]);
        expect(browser.consoleErrors).toEqual([]);
        expect(browser.pageErrors).toEqual([]);
        test.info().annotations.push({
            type: 'expected-initial-attach-pin-aborts',
            description: JSON.stringify(network.expectedPinAborts),
        });
    } finally {
        await phi.stop();
    }
});
