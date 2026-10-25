import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const managedDraft = 'UNSENT draft — preserve this exactly\nsecond line';

function observerExtension(draft: string): string {
    return `import { createServer } from 'node:http';
import { unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const key = Symbol.for('phi.reload.e2e.observer');
const state = globalThis[key] ??= { generation: 0, inputs: 0, blockedInputs: 0, fallthrough: 0, agentStarts: 0 };
const argv = process.argv;
const role = argv.some((arg, index) => arg === '--extension' && basename(argv[index + 1] ?? '') === 'pi-phi-extension.cjs') ? 'managed' : 'plain';
const infoPath = join(process.env.HOME, \`reload-observer-\${process.pid}.json\`);
const draft = ${JSON.stringify(draft)};
function save() { writeFileSync(join(process.env.HOME, \`reload-observer-\${process.pid}.state.json\`), JSON.stringify(state)); }
export default function (pi) {
    let server;
    pi.on('input', (event) => {
        state.inputs++;
        state.blockedInputs++;
        if (event.text === '/phi-bridge-reload' || event.text.startsWith('/phi-bridge-reload ')) state.fallthrough++;
        save();
        return { action: 'handled' };
    });
    pi.on('agent_start', () => { state.agentStarts++; save(); });
    pi.on('session_start', (_event, ctx) => {
        state.generation++;
        save();
        try { unlinkSync(infoPath); } catch {}
        server?.close();
        server = createServer((request, response) => {
            if (request.method === 'POST' && request.url === '/seed') {
                ctx.ui.setEditorText(draft);
                response.writeHead(204).end();
                return;
            }
            if (request.method !== 'GET' || request.url !== '/state') {
                response.writeHead(404).end();
                return;
            }
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ ...state, role, draft: ctx.ui.getEditorText() }));
        });
        server.listen(0, '127.0.0.1', () => {
            writeFileSync(infoPath, JSON.stringify({ role, url: \`http://127.0.0.1:\${server.address().port}\` }));
        });
        server.unref();
    });
    pi.on('session_shutdown', () => { server?.close(); });
}`;
}

function observerInfo(home: string, role: string) {
    for (const name of readdirSync(home).filter(
        (entry) =>
            entry.startsWith('reload-observer-') &&
            entry.endsWith('.json') &&
            !entry.endsWith('.state.json'),
    )) {
        try {
            const info = JSON.parse(readFileSync(join(home, name), 'utf8')) as {
                role: string;
                url: string;
            };
            if (info.role === role) return info;
        } catch {
            // A reload replaces the observer endpoint file atomically enough for polling.
        }
    }
    return null;
}

test('Pi reload preset survives native reload with and without bridge injection', async ({
    page,
    request,
}) => {
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            ANTHROPIC_API_KEY: 'dummy-reload-key-never-used',
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
            const observer = join(dir, 'reload-observer.mjs');
            writeFileSync(observer, observerExtension(managedDraft));
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            writeFileSync(
                command,
                `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 --extension ${shellQuote(observer)} "$@"\n`,
                { mode: 0o755 },
            );
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            // Override only the executable; test the built-in presets.
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });

    try {
        const panes = async () => {
            const response = await request.get(`${phi.url}/api/terminals`);
            expect(response.ok()).toBe(true);
            return (await response.json()) as Array<{
                id: string;
                pi_bridge?: {
                    connected?: boolean;
                    generation?: string;
                    capabilities?: string[];
                };
            }>;
        };
        const spawn = async (title: string) => {
            const response = await request.post(`${phi.url}/api/terminals`, {
                data: { coder: 'pi', cwd: phi.dir, title },
            });
            expect(response.ok()).toBe(true);
            return (await response.json()).pane_id as string;
        };
        const home = join(phi.dir, 'home');
        const waitObserver = async (role: string) => {
            await expect
                .poll(() => observerInfo(home, role), { timeout: 20_000 })
                .toBeTruthy();
            const info = observerInfo(home, role);
            if (!info) throw new Error(`observer unavailable for ${role}`);
            return info;
        };
        const readObserver = async (role: string) => {
            const info = await waitObserver(role);
            const response = await request.get(`${info.url}/state`);
            expect(response.ok()).toBe(true);
            return (await response.json()) as {
                generation: number;
                draft: string;
                inputs: number;
                blockedInputs: number;
                fallthrough: number;
                agentStarts: number;
            };
        };
        const managed = await spawn('Pi managed reload');
        await expect
            .poll(
                async () =>
                    (await panes()).find((p) => p.id === managed)?.pi_bridge
                        ?.connected,
                {
                    timeout: 20_000,
                },
            )
            .toBe(true);
        expect(
            (await panes()).find((pane) => pane.id === managed)?.pi_bridge
                ?.capabilities,
        ).toContain('pi.reload.v1');
        const managedObserver = await waitObserver('managed');
        const seeded = await request.post(`${managedObserver.url}/seed`);
        expect(seeded.status()).toBe(204);
        await expect
            .poll(async () => (await readObserver('managed')).draft)
            .toBe(managedDraft);
        const disabled = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            {
                data: { enabled: true },
            },
        );
        expect(disabled.ok()).toBe(true);
        const plain = await spawn('Pi no-injection reload');
        await expect
            .poll(
                async () =>
                    (await panes()).find((pane) => pane.id === plain)?.pi_bridge
                        ?.connected,
                { timeout: 10_000 },
            )
            .toBe(false);
        expect((await readObserver('plain')).draft).toBe('');
        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            {
                data: { sync_coordinator: phi.url },
            },
        );
        expect(coordinator.ok()).toBe(true);
        const registryResponse = await request.get(`${phi.url}/api/coders`);
        expect(registryResponse.ok()).toBe(true);
        const { pi } = await registryResponse.json();
        expect(pi.presets.slice(0, 5)).toEqual(
            ['/quit', '/resume', '/reload', '/compact', '/copy'].map(
                (name) => ({ name, value: `${name}\r` }),
            ),
        );
        expect(
            pi.presets.some(
                (preset: { name: string }) => preset.name === '/model',
            ),
        ).toBe(false);

        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const externalRequests: string[] = [];
        const failedHTTP: string[] = [];
        const failedNetwork: string[] = [];
        const reloadNetwork: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('requestfailed', (req) => {
            const failure = `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`;
            failedNetwork.push(failure);
            if (req.url().includes('/api/pi-bridge/reload'))
                reloadNetwork.push(`failed ${failure}`);
        });
        page.on('requestfinished', (req) => {
            if (req.url().includes('/api/pi-bridge/reload'))
                reloadNetwork.push('finished');
        });
        page.on('response', (response) => {
            if (response.status() >= 400)
                failedHTTP.push(`${response.status()} ${response.url()}`);
            if (response.url().includes('/api/pi-bridge/reload'))
                reloadNetwork.push(`response ${response.status()}`);
        });
        await page.route('**/*', (route) => {
            const origin = new URL(route.request().url()).origin;
            if (origin === phi.url) return route.continue();
            externalRequests.push(origin);
            return route.abort();
        });
        const ptyInputs = new Map<string, string[]>([
            [managed, []],
            [plain, []],
        ]);
        for (const pane of [managed, plain]) {
            await page.routeWebSocket(`**/ws/pane/${pane}?*`, (socket) => {
                const backend = socket.connectToServer();
                socket.onMessage((message) => {
                    if (Buffer.isBuffer(message) && message[0] === 0x01) {
                        ptyInputs
                            .get(pane)!
                            .push(message.subarray(1).toString('utf8'));
                    }
                    backend.send(message);
                });
            });
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        for (const pane of [managed, plain]) {
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
            const buttons = page.locator('#presets-container button');
            expect((await buttons.allTextContents()).slice(0, 5)).toEqual([
                '/quit',
                '/resume',
                '/reload',
                '/compact',
                '/copy',
            ]);
            const recording = `${phi.url}/api/terminals/${pane}/recording`;
            const before = await request.get(
                `${recording}?from=0&through=18446744073709551615`,
            );
            expect(before.ok()).toBe(true);
            const body = await before.body();
            const offset: number = JSON.parse(
                body.subarray(4, 4 + body.readUInt32BE(0)).toString('utf8'),
            ).end;
            const generation = Number(
                (await panes()).find((p) => p.id === pane)?.pi_bridge
                    ?.generation,
            );
            const role = pane === managed ? 'managed' : 'plain';
            const observerBefore = await readObserver(role);
            expect(observerBefore.draft).toBe(
                pane === managed ? managedDraft : '',
            );
            const inputOffset = ptyInputs.get(pane)!.length;
            await page
                .locator('#presets-container')
                .getByRole('button', { name: '/reload', exact: true })
                .click();
            await expect
                .poll(
                    async () => {
                        const response = await request.get(
                            `${recording}?from=${offset}&through=18446744073709551615`,
                        );
                        expect(response.ok()).toBe(true);
                        const bytes = await response.body();
                        return stripVTControlCharacters(
                            bytes
                                .subarray(4 + bytes.readUInt32BE(0))
                                .toString('utf8'),
                        );
                    },
                    { timeout: 20_000 },
                )
                .toContain(
                    'Reloaded keybindings, extensions, skills, prompts, themes, and context files',
                );
            if (pane === managed) {
                await expect
                    .poll(
                        async () => {
                            const bridge = (await panes()).find(
                                (p) => p.id === pane,
                            )?.pi_bridge;
                            return (
                                bridge?.connected === true &&
                                Number(bridge.generation) > generation
                            );
                        },
                        { timeout: 20_000 },
                    )
                    .toBe(true);
            } else {
                expect(
                    (await panes()).find((p) => p.id === pane)?.pi_bridge
                        ?.connected,
                ).toBe(false);
            }
            const observerAfter = await readObserver(role);
            if (pane === managed) {
                expect(observerAfter.generation).toBeGreaterThan(
                    observerBefore.generation,
                );
                expect(observerAfter.draft).toBe(managedDraft);
            } else {
                expect(observerAfter.draft).toBe('');
            }
            expect(observerAfter.inputs).toBe(0);
            expect(observerAfter.blockedInputs).toBe(0);
            expect(observerAfter.fallthrough).toBe(0);
            expect(observerAfter.agentStarts).toBe(0);
            const reloadInputs = ptyInputs
                .get(pane)!
                .slice(inputOffset)
                .filter((payload) => payload.includes('/reload'));
            expect(reloadInputs).toEqual(
                pane === managed ? [] : ['\x1b[200~/reload\x1b[201~\r'],
            );
            const models = page.locator(
                '#presets-container .model-trigger-btn',
                { hasText: '🤖 Models' },
            );
            await expect(models).toBeEnabled();
            if (pane === managed)
                await expect(models).toHaveClass(/pi-rpc-model-trigger/);
            else await expect(models).not.toHaveClass(/pi-rpc-model-trigger/);
            await models.click();
            const dropup = page.locator(
                pane === managed
                    ? '#pi-rpc-model-dropup'
                    : '#model-presets-dropup',
            );
            await expect(dropup).toBeVisible();
            await models.click();
            await expect(dropup).toBeHidden();
            expect((await panes()).map((p) => p.id)).toEqual(
                expect.arrayContaining([managed, plain]),
            );
        }
        expect(pageErrors).toEqual([]);
        expect(externalRequests).toEqual([]);
        console.log('B1 reload network events', JSON.stringify(reloadNetwork));
        expect(
            failedHTTP.filter((entry) =>
                entry.includes('/api/pi-bridge/reload'),
            ),
        ).toEqual([]);
        expect(
            failedNetwork.filter((entry) =>
                entry.includes('/api/pi-bridge/reload'),
            ),
        ).toEqual([]);
        console.log(
            'B1 browser diagnostics',
            JSON.stringify({
                pageErrors,
                consoleErrors,
                externalRequests,
                failedHTTP,
                failedNetwork,
                ptyInputs: Object.fromEntries(ptyInputs),
            }),
        );
        await expect(
            page
                .locator('.toast')
                .filter({ hasText: /Reload failed|input not sent/i }),
        ).toHaveCount(0);
    } finally {
        await phi.stop();
    }
});
