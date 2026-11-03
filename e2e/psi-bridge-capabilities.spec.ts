import {
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    startAttachmentProvider,
    type AttachmentProvider,
} from './_pi-attachment-provider.js';
import { startPhi, type PhiServer } from './_server.js';

// The native psi build under test. There is no fallback to an installed
// binary: a stale psi would silently verify the wrong code.
const PSI_BIN = process.env.PSI_E2E_BIN ?? '';

type PaneBridge = {
    state: string;
    connected?: boolean;
    model?: string;
    provider?: string;
    thinking_level?: string;
    telemetry_revision?: string;
    generation?: string;
    compact_idle?: boolean;
    compact_active?: boolean;
    compact_pending?: boolean;
    compact_queued?: boolean;
    context_tokens?: number;
    context_window?: number;
    context_percent?: number;
    capabilities?: string[];
};

// sessionRecords counts one record type across the fixture's psi sessions.
function sessionRecords(dir: string, needle: string): number {
    const root = join(dir, 'psi-sessions');
    let count = 0;
    for (const entry of readdirSync(root, { recursive: true })) {
        const path = join(root, entry.toString());
        if (!path.endsWith('.jsonl')) continue;
        const text = readFileSync(path, 'utf8');
        for (const line of text.split('\n')) {
            if (line.includes(needle)) count++;
        }
    }
    return count;
}

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

async function spawnPsi(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
): Promise<string> {
    const response = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', pi_psi: true, cwd, title },
    });
    expect(response.ok()).toBe(true);
    const pane = ((await response.json()) as { pane_id: string }).pane_id;
    await expect
        .poll(() => paneBridge(request, url, pane), { timeout: 30_000 })
        .toMatchObject({ state: 'managed', connected: true });
    return pane;
}

type Fixture = {
    provider: AttachmentProvider;
    phi: PhiServer;
    work: string;
};

// One isolated Phi process with a psi binary that can only reach the local
// provider fixture. No real profile, credential, or external call.
async function startPsiCapabilityPhi(): Promise<Fixture> {
    const provider = await startAttachmentProvider();
    const phi = await startPhi({
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
            // One real skill so dispatch exercises discovery, expansion, and
            // provenance instead of a stub.
            mkdirSync(join(agent, 'skills', 'bridge-echo'), { recursive: true });
            writeFileSync(
                join(agent, 'skills', 'bridge-echo', 'SKILL.md'),
                '---\nname: bridge-echo\ndescription: Echo the bridge fixture marker\n---\nBRIDGE_SKILL_BODY_MARKER\n',
            );
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProvider: 'anthropic',
                    defaultModel: 'bridge-a',
                    defaultThinkingLevel: 'off',
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    compaction: {
                        enabled: false,
                        // A small retained budget keeps the compaction
                        // gate reachable with short turns, so the spec never
                        // has to push 30 KiB through the pane input.
                        keepRecentTokens: 2000,
                    },
                    retry: { enabled: false },
                }),
            );
            writeFileSync(
                join(agent, 'models.json'),
                JSON.stringify({
                    providers: {
                        anthropic: {
                            baseUrl: `http://127.0.0.1:${provider.port}`,
                            api: 'anthropic-messages',
                            apiKey: 'psi-bridge-fixture-key',
                            models: [
                                {
                                    id: 'bridge-a',
                                    name: 'Bridge A',
                                    reasoning: true,
                                    contextWindow: 32_000,
                                    maxTokens: 16384,
                                },
                                {
                                    id: 'bridge-b',
                                    name: 'Bridge B',
                                    reasoning: true,
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
    return { provider, phi, work: realpathSync(join(phi.dir, 'work')) };
}

test('M0 psi pane attaches natively without new capabilities claimed', async ({
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    const { provider, phi, work } = await startPsiCapabilityPhi();
    try {
        const pane = await spawnPsi(request, phi.url, work, 'psi attach');
        const view = await paneBridge(request, phi.url, pane);
        expect(view?.state).toBe('managed');
        expect(view?.connected).toBe(true);
        // A capability is only advertised once its handler answers every path.
        expect(view?.capabilities).toEqual(
            expect.arrayContaining(['pi.lifecycle.v1', 'pi.state.v2']),
        );
    } finally {
        await provider.close();
        await phi.stop();
    }
});

test('M1 models list and switch reach the real psi session', async ({
    page,
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(240_000);
    const { provider, phi, work } = await startPsiCapabilityPhi();
    try {
        const pane = await spawnPsi(request, phi.url, work, 'psi models');
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                model: 'anthropic/bridge-a',
                capabilities: expect.arrayContaining(['pi.models.v1']),
            });

        // The catalog comes from psi's own resolved configuration.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/models?pane=${encodeURIComponent(pane)}`,
        );
        expect(listResponse.ok()).toBe(true);
        const catalog = (await listResponse.json()) as {
            models: Array<{ provider: string; id: string }>;
            truncated: boolean;
            unavailable: boolean;
        };
        expect(catalog.unavailable).toBe(false);
        expect(catalog.models).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ provider: 'anthropic', id: 'bridge-a' }),
                expect.objectContaining({ provider: 'anthropic', id: 'bridge-b' }),
            ]),
        );

        // The picker renders those rows before any switch.
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        const trigger = page.locator(
            '#presets-container button.pi-rpc-model-trigger',
        );
        await expect(trigger).toContainText('Model:', { timeout: 15_000 });
        await trigger.click();
        const dropup = page.locator('#pi-rpc-model-dropup');
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        await expect(
            dropup.locator('.pi-rpc-model-row', { hasText: 'bridge-b' }),
        ).toBeVisible({ timeout: 10_000 });
        await page.keyboard.press('Escape');

        // Switching persists in the session and is acknowledged.
        const switchResponse = await request.post(
            `${phi.url}/api/pi-bridge/model`,
            { data: { pane, provider: 'anthropic', model: 'bridge-b' } },
        );
        expect(switchResponse.ok()).toBe(true);
        const ack = (await switchResponse.json()) as {
            ok: boolean;
            reason: string;
        };
        expect(ack).toEqual({ ok: true, reason: '' });
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 15_000 })
            .toMatchObject({ model: 'anthropic/bridge-b' });

        // A real prompt must reach the local provider as bridge-b and settle.
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await page.locator('#input-textarea').fill('bridge probe one');
        const before = provider.requests.length;
        await page.locator('#input-textarea').press('Enter');
        await provider.waitForRequests(before + 1, 60_000);
        const sent = provider.requests[before];
        expect(sent?.body.model).toBe('bridge-b');
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 60_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                model: 'anthropic/bridge-b',
            });
    } finally {
        await provider.close();
        await phi.stop();
    }
});

test('M2 thinking, context, and recall follow the live psi session', async ({
    page,
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(240_000);
    const { provider, phi, work } = await startPsiCapabilityPhi();
    try {
        const pane = await spawnPsi(request, phi.url, work, 'psi thinking');
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.thinking.v1',
                    'pi.context.v1',
                    'pi.history.v1',
                ]),
            });

        // The level list describes the live model, not a static table.
        const levelsResponse = await request.get(
            `${phi.url}/api/pi-bridge/thinking-levels?pane=${encodeURIComponent(pane)}`,
        );
        expect(levelsResponse.ok()).toBe(true);
        const levels = (await levelsResponse.json()) as {
            levels: string[];
            provider: string;
            model: string;
            unavailable: boolean;
            process_id: string;
            generation: string;
        };
        expect(levels.unavailable).toBe(false);
        expect(levels.provider).toBe('anthropic');
        expect(levels.model).toBe('bridge-a');
        expect(levels.levels).toEqual(expect.arrayContaining(['off']));

        // A supported level persists and reaches the bridge snapshot.
        const target = levels.levels.find((level) => level !== 'off');
        expect(target).toBeTruthy();
        const setResponse = await request.post(
            `${phi.url}/api/pi-bridge/thinking`,
            {
                data: {
                    pane,
                    process_id: levels.process_id,
                    generation: levels.generation,
                    level: target,
                    provider: levels.provider,
                    model: levels.model,
                },
            },
        );
        expect(setResponse.ok()).toBe(true);
        expect(await setResponse.json()).toEqual({ ok: true, reason: '' });
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 15_000,
            })
            .toMatchObject({ thinking_level: target });

        // Two real turns give the editor recall something to report.
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        for (const prompt of ['recall first prompt', 'recall second prompt']) {
            const before = provider.requests.length;
            await page.locator('#input-textarea').fill(prompt);
            await page.locator('#input-textarea').press('Enter');
            await provider.waitForRequests(before + 1, 60_000);
            await expect
                .poll(
                    async () =>
                        (
                            await request.get(
                                `${phi.url}/api/pi-bridge/attachments/context?pane=${encodeURIComponent(pane)}`,
                            )
                        ).status(),
                    { timeout: 60_000 },
                )
                .toBe(200);
        }

        const historyResponse = await request.get(
            `${phi.url}/api/pi-history?pane=${encodeURIComponent(pane)}`,
        );
        expect(historyResponse.ok()).toBe(true);
        const history = (await historyResponse.json()) as {
            entries: string[];
            unavailable: boolean;
        };
        expect(history.unavailable).toBe(false);
        expect(history.entries[0]).toBe('recall second prompt');
        expect(history.entries[1]).toBe('recall first prompt');

        // Context telemetry is a measurement, present only when known.
        await expect
            .poll(async () => {
                const view = await paneBridge(request, phi.url, pane);
                return view && typeof view.context_tokens === 'number';
            }, { timeout: 30_000 })
            .toBe(true);
        const view = await paneBridge(request, phi.url, pane);
        expect(view?.context_window).toBe(32_000);
        expect(view?.context_tokens).toBeGreaterThan(0);
        expect(view?.context_percent).toBeCloseTo(
            (100 * (view?.context_tokens ?? 0)) / 32_000,
            5,
        );
    } finally {
        await provider.close();
        await phi.stop();
    }
});

test('M3 skills dispatch once and search reads visible text', async ({
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(240_000);
    const { provider, phi, work } = await startPsiCapabilityPhi();
    try {
        const pane = await spawnPsi(request, phi.url, work, 'psi skills');
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.skills.v1',
                    'pi.transcript-search.v2',
                ]),
            });

        // The list is live session metadata, never the skill body.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/skills?pane=${encodeURIComponent(pane)}`,
        );
        expect(listResponse.ok()).toBe(true);
        const list = (await listResponse.json()) as {
            skills: Array<{ name: string; description: string }>;
            truncated: boolean;
            unavailable: boolean;
            process_id: string;
            generation: string;
        };
        expect(list.unavailable).toBe(false);
        const skill = list.skills.find((entry) => entry.name === 'bridge-echo');
        expect(skill?.description).toBe('Echo the bridge fixture marker');
        expect(JSON.stringify(list)).not.toContain('BRIDGE_SKILL_BODY_MARKER');

        // One dispatch produces exactly one provider request carrying the
        // expanded body.
        const before = provider.requests.length;
        const invokeResponse = await request.post(
            `${phi.url}/api/pi-bridge/skill`,
            {
                data: {
                    pane,
                    name: 'bridge-echo',
                    process_id: list.process_id,
                    generation: list.generation,
                },
            },
        );
        expect(invokeResponse.ok()).toBe(true);
        expect(await invokeResponse.json()).toMatchObject({ ok: true });
        await provider.waitForRequests(before + 1, 60_000);
        const sent = provider.requests[before];
        expect(JSON.stringify(sent?.body.messages)).toContain(
            'BRIDGE_SKILL_BODY_MARKER',
        );

        // An unknown name is refused before anything reaches the session.
        const unknown = await request.post(`${phi.url}/api/pi-bridge/skill`, {
            data: {
                pane,
                name: 'no-such-skill',
                process_id: list.process_id,
                generation: list.generation,
            },
        });
        expect(await unknown.json()).toMatchObject({
            ok: false,
            reason: 'unknown-skill',
        });

        // Search reads the visible branch that produced those turns.
        const view = await paneBridge(request, phi.url, pane);
        const searchResponse = await request.post(
            `${phi.url}/api/pi-bridge/transcript-search`,
            {
                data: {
                    pane,
                    query: 'BRIDGE_SKILL_BODY_MARKER',
                    generation: view?.generation,
                    initial: true,
                },
            },
        );
        expect(searchResponse.ok()).toBe(true);
        const page = (await searchResponse.json()) as {
            matches: Array<{ role: string; snippet: string }>;
            complete: boolean;
            unavailable: boolean;
            anchor_leaf_id: string;
            next_index: number;
        };
        expect(page.unavailable).toBe(false);
        expect(page.complete).toBe(true);
        expect(page.anchor_leaf_id).not.toBe('');
        const hit = page.matches.find((match) => match.role === 'user');
        expect(hit?.snippet).toContain('BRIDGE_SKILL_BODY_MARKER');

        // A query that only matches skill frontmatter stays empty: the file
        // header is not transcript text.
        const frontmatter = await request.post(
            `${phi.url}/api/pi-bridge/transcript-search`,
            {
                data: {
                    pane,
                    query: 'description: Echo the bridge fixture marker',
                    generation: view?.generation,
                    initial: true,
                },
            },
        );
        expect(frontmatter.ok()).toBe(true);
        expect(
            (await frontmatter.json()) as { matches: unknown[] },
        ).toMatchObject({ matches: [] });
    } finally {
        await provider.close();
        await phi.stop();
    }
});

test('M4 one compact request creates one durable compaction', async ({
    page,
    request,
}) => {
    test.skip(!PSI_BIN, 'PSI_E2E_BIN must name the built psi binary');
    test.setTimeout(240_000);
    const { provider, phi, work } = await startPsiCapabilityPhi();
    try {
        const pane = await spawnPsi(request, phi.url, work, 'psi compact');
        await expect
            .poll(() => paneBridge(request, phi.url, pane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining(['pi.compact.v1']),
            });

        // Real history, so the compaction has something to rewrite.
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        const before = provider.requests.length;
        // Two short turns: with the fixture's small retained budget the
        // oldest already falls outside it, which is what makes a native
        // compaction eligible. The send button is the repo's reliable
        // submit path for programmatic turns.
        const send = page.locator('#send-input-btn');
        for (const [index, size] of [8_000, 8_000].entries()) {
            await page
                .locator('#input-textarea')
                .fill(`compact turn ${index} ${'x'.repeat(size)}`);
            await send.click();
            // The editor clears after a submit; only then is the next turn's
            // input guaranteed to land in an editor that accepts it.
            await expect
                .poll(
                    async () =>
                        (await page.locator('#input-textarea').inputValue()) ===
                        '',
                    { timeout: 60_000 },
                )
                .toBe(true);
            await provider.waitForRequests(before + index + 1, 60_000);
            await expect
                .poll(
                    async () =>
                        (
                            await paneBridge(request, phi.url, pane)
                        )?.compact_idle,
                    { timeout: 60_000 },
                )
                .toBe(true);
        }
        await expect
            .poll(async () => (await paneBridge(request, phi.url, pane))?.compact_idle, {
                timeout: 60_000,
            })
            .toBe(true);

        // The published revision settles a moment after the run, so a press
        // waits for it and retries the way a second click would.
        await new Promise((resolve) => setTimeout(resolve, 500));
        let pressStatus = 0;
        let pressBody = '';
        let lastView = '';
        for (let attempt = 0; attempt < 10; attempt++) {
            const view = await paneBridge(request, phi.url, pane);
            lastView = JSON.stringify(view);
            const press = await request.post(`${phi.url}/api/pi-bridge/compact`, {
                data: {
                    pane,
                    generation: view?.generation,
                    telemetry_revision: view?.telemetry_revision,
                },
            });
            pressStatus = press.status();
            pressBody = await press.text();
            if (
                pressStatus !== 409 ||
                !/"(stale|busy)"/.test(pressBody)
            )
                break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(
            pressStatus,
            `compact press ${pressStatus}: ${pressBody} view ${lastView}`,
        ).toBe(200);
        expect(JSON.parse(pressBody)).toMatchObject({ outcome: 'completed' });

        // Durability: exactly one compaction record reached the session.
        const compactions = sessionRecords(phi.dir, '"type":"compaction"');
        expect(compactions).toBe(1);

        // A second press with the same identity cannot repeat the operation.
        const stale = await request.post(`${phi.url}/api/pi-bridge/compact`, {
            data: {
                pane,
                generation: (await paneBridge(request, phi.url, pane))?.generation,
                telemetry_revision: '1',
            },
        });
        expect(stale.status()).toBe(409);
        expect(sessionRecords(phi.dir, '"type":"compaction"')).toBe(1);
    } finally {
        await provider.close();
        await phi.stop();
    }
});
