import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';
import { startSkillProvider } from './_pi-skill-provider.js';

// Real pinned Pi, one fixture skill, and a loopback provider: no
// credential, no network, no model call outside the fixture.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const MARKER = 'PHI_SKILL_MARKER_9f2a';
const SKILL_NAME = 'demo-skill';
const SKILL_DESCRIPTION = 'Demo skill for the phi bridge skills spec.';

interface BridgeView {
    state: string;
    connected?: boolean;
    capabilities?: string[];
}

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

// The recorded body is JSON: the skill body lives in a message text
// field, so the assertion reads the decoded text, not the raw bytes.
function requestText(body: string): string {
    const parsed = JSON.parse(body) as {
        messages?: Array<{ content?: Array<{ text?: string }> }>;
    };
    return (parsed.messages ?? [])
        .map((message) =>
            (message.content ?? []).map((part) => part.text ?? '').join('\n'),
        )
        .join('\n');
}

test('bridge-live Pi lists and sends skills, bridge-absent keeps the composer', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const provider = await startSkillProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
        },
        setup(dir) {
            const agent = join(dir, 'home', '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                }),
            );
            // The fixture provider: a loopback Anthropic-Messages
            // endpoint, so Pi needs no real credential.
            writeFileSync(
                join(agent, 'models.json'),
                JSON.stringify({
                    providers: {
                        'phi-fixture': {
                            baseUrl: `http://127.0.0.1:${provider.port}`,
                            api: 'anthropic-messages',
                            apiKey: 'fixture-key',
                            models: [{ id: 'fixture-model' }],
                        },
                    },
                }),
            );

            const skillDir = join(dir, 'skills', SKILL_NAME);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(
                join(skillDir, 'SKILL.md'),
                [
                    '---',
                    `name: ${SKILL_NAME}`,
                    `description: ${SKILL_DESCRIPTION}`,
                    '---',
                    '',
                    '# Demo skill',
                    '',
                    `Follow the demo instructions. ${MARKER}`,
                    '',
                ].join('\n'),
            );

            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            // --no-extensions blocks user extensions; Phi still appends
            // its explicit --extension bundle for managed panes. Skills
            // stay enabled and the fixture skill is loaded explicitly.
            writeFileSync(
                command,
                `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-prompt-templates --no-context-files --no-approve --skill ${shellQuote(join(dir, 'skills'))} --model phi-fixture/fixture-model "$@"\n`,
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

    try {
        const cwd = realpathSync(phi.dir);

        const liveSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi live' },
        });
        expect(liveSpawn.ok()).toBe(true);
        const livePane = ((await liveSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining(['pi.skills.v1']),
            });

        // The list endpoint serves the live session's skills.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/skills?pane=${encodeURIComponent(livePane)}`,
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
        expect(list.skills.map((s) => s.name)).toContain(SKILL_NAME);
        const entry = list.skills.find((s) => s.name === SKILL_NAME);
        expect(entry?.description).toBe(SKILL_DESCRIPTION);
        // The answer names the peer that served it: a click must carry
        // that origin.
        expect(list.process_id).not.toBe('');
        expect(list.generation).not.toBe('');

        // Absent pane: disable injection, then spawn.
        const noInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(noInject.ok()).toBe(true);
        const absentSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi absent' },
        });
        expect(absentSpawn.ok()).toBe(true);
        const absentPane = ((await absentSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, absentPane), {
                timeout: 20_000,
            })
            .toMatchObject({ connected: false });

        const pageErrors: string[] = [];
        const failures: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (req) => {
            if (req.url().includes('/api/pi-bridge/')) failures.push(req.url());
        });
        page.on('response', (response) => {
            if (
                response.url().includes('/api/pi-bridge/') &&
                response.status() >= 400
            )
                failures.push(`${response.status()} ${response.url()}`);
        });
        const skillsFetches: string[] = [];
        await page.route('**/api/pi-bridge/skills?*', (route) => {
            skillsFetches.push(route.request().url());
            return route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();

        const trigger = page.locator(
            '#presets-container button.pi-rpc-skills-trigger',
        );
        await expect(trigger).toBeVisible({ timeout: 15_000 });

        const dropup = page.locator('#pi-rpc-skills-dropup');
        await trigger.click();
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        await expect(dropup).toContainText(SKILL_NAME, { timeout: 10_000 });
        await expect(dropup).toContainText(SKILL_DESCRIPTION);

        // The filter narrows the list, and Escape clears it.
        const filter = dropup.locator('.pi-rpc-model-search');
        await filter.fill('no-such-skill');
        await expect(dropup.locator('.dropup-model-btn')).toHaveCount(0);
        await filter.press('Escape');
        await expect(dropup.locator('.dropup-model-btn')).toHaveCount(1);

        // Narrow layout keeps the open picker with no horizontal
        // overflow.
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        await page.setViewportSize({ width: 1440, height: 900 });

        // Clicking the skill dispatches it to Pi, and the provider
        // request Pi sends carries the expanded skill body.
        await dropup.locator('.dropup-model-btn').first().click();
        await expect(dropup).toBeHidden({ timeout: 10_000 });
        const [sent] = await provider.waitForRequests(1);
        const sentText = requestText(sent!);
        expect(sentText).toContain(`<skill name="${SKILL_NAME}"`);
        expect(sentText).toContain(MARKER);

        // A click that carries a stale origin is refused before any
        // dispatch: the skill never reaches the session.
        const stale = await request.post(`${phi.url}/api/pi-bridge/skill`, {
            data: {
                pane: livePane,
                name: SKILL_NAME,
                process_id: list.process_id,
                generation: '999',
            },
        });
        expect(stale.ok()).toBe(true);
        expect(await stale.json()).toEqual({
            ok: false,
            reason: 'unavailable',
        });
        await page.waitForTimeout(500);
        expect(provider.requests).toHaveLength(1);

        // Bridge-absent pane: no skills control, no skills request.
        await page.locator(`.tab[data-pane-id="${absentPane}"]`).click();
        await expect(
            page.locator('#presets-container button.pi-rpc-skills-trigger'),
        ).toHaveCount(0);
        const fetchesBefore = skillsFetches.length;
        await page.waitForTimeout(500);
        expect(
            skillsFetches
                .slice(fetchesBefore)
                .filter((url) => url.includes(absentPane)),
        ).toEqual([]);

        expect(pageErrors).toEqual([]);
        expect(failures).toEqual([]);
    } finally {
        await phi.stop();
        await provider.close();
    }
});

test('a busy agent queues the skill as a follow-up', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const provider = await startSkillProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
        },
        setup(dir) {
            const agent = join(dir, 'home', '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                }),
            );
            writeFileSync(
                join(agent, 'models.json'),
                JSON.stringify({
                    providers: {
                        'phi-fixture': {
                            baseUrl: `http://127.0.0.1:${provider.port}`,
                            api: 'anthropic-messages',
                            apiKey: 'fixture-key',
                            models: [{ id: 'fixture-model' }],
                        },
                    },
                }),
            );
            const skillDir = join(dir, 'skills', SKILL_NAME);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(
                join(skillDir, 'SKILL.md'),
                [
                    '---',
                    `name: ${SKILL_NAME}`,
                    `description: ${SKILL_DESCRIPTION}`,
                    '---',
                    '',
                    '# Demo skill',
                    '',
                    `Follow the demo instructions. ${MARKER}`,
                    '',
                ].join('\n'),
            );
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            writeFileSync(
                command,
                `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-prompt-templates --no-context-files --no-approve --skill ${shellQuote(join(dir, 'skills'))} --model phi-fixture/fixture-model "$@"\n`,
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

    try {
        const cwd = realpathSync(phi.dir);
        const liveSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi busy' },
        });
        expect(liveSpawn.ok()).toBe(true);
        const livePane = ((await liveSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining(['pi.skills.v1']),
            });

        // Keep the first answer open so the agent stays busy while the
        // skill is sent.
        const release = provider.hold();
        const prompt = await request.post(
            `${phi.url}/api/terminals/${livePane}/input`,
            { data: { text: 'hello fixture' } },
        );
        expect(prompt.ok()).toBe(true);
        await provider.waitForRequests(1);

        // The list names the peer that served it; the invoke carries
        // that origin so a moved session refuses the click.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/skills?pane=${encodeURIComponent(livePane)}`,
        );
        expect(listResponse.ok()).toBe(true);
        const list = (await listResponse.json()) as {
            process_id: string;
            generation: string;
        };
        const invoke = await request.post(`${phi.url}/api/pi-bridge/skill`, {
            data: {
                pane: livePane,
                name: SKILL_NAME,
                process_id: list.process_id,
                generation: list.generation,
            },
        });
        expect(invoke.ok()).toBe(true);
        expect(await invoke.json()).toEqual({ ok: true, reason: '' });

        // The queued follow-up leaves after the current turn ends.
        release();
        const requests = await provider.waitForRequests(2);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        const lastText = requestText(requests[requests.length - 1]!);
        expect(lastText).toContain(`<skill name="${SKILL_NAME}"`);
        expect(lastText).toContain(MARKER);
    } finally {
        await phi.stop();
        await provider.close();
    }
});
