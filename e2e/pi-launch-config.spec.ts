import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// What this proves: the Settings control persists a default on the server, and
// a real `pi` process selection follows it in both directions, including the
// opposite-agent menu action. The stub executables are the only binaries on the
// isolated PATH, so a record's executable path names the agent that ran.

interface ChildRecord {
    pid: number;
    executable: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
}

const isWindows = process.platform === 'win32';
const exeName = (name: string) => (isWindows ? `${name}.exe` : name);

function buildStub(dir: string): string {
    const out = join(dir, 'fixture', exeName('agent'));
    mkdirSync(join(dir, 'fixture'), { recursive: true });
    const build = spawnSync(
        'go',
        ['build', '-o', out, './e2e/fixtures/pi-launch'],
        { cwd: process.cwd(), encoding: 'utf8' },
    );
    if (build.status !== 0)
        throw new Error(
            `fixture build failed: ${build.stderr || build.stdout}`,
        );
    return out;
}

function copyStub(source: string, target: string): void {
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(source, target);
    if (!isWindows) chmodSync(target, 0o755);
}

function childRecords(server: PhiServer): ChildRecord[] {
    const dir = join(server.dir, 'children');
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((name) => name.startsWith('child-') && name.endsWith('.json'))
        .sort()
        .map((name) => {
            try {
                return JSON.parse(readFileSync(join(dir, name), 'utf8'));
            } catch {
                return null;
            }
        })
        .filter((record): record is ChildRecord => !!record);
}

// recordsFor filters by executable basename so a stale record from another
// launch can never satisfy the assertion.
function recordsFor(server: PhiServer, name: string): ChildRecord[] {
    return childRecords(server).filter(
        (record) =>
            record.executable.replace(/\\/g, '/').split('/').at(-1) === name,
    );
}

async function openSettings(page: Page): Promise<void> {
    // Click the pill's own label, not an export/import button inside it: the
    // pill handler ignores clicks that land on those.
    await page.locator('#header-config-pill .pill-label').click();
    await expect(page.locator('.settings-pi-launch select')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
    await page.locator('.settings-overlay .modal-close-btn').click();
    await expect(page.locator('.settings-overlay')).toHaveCount(0);
}

async function chooseDefault(page: Page, agent: 'Pi' | 'Psi', hint: string) {
    const select = page.locator('#settings-pi-default-mode');
    await select.selectOption(agent === 'Psi' ? 'psi' : 'pi');
    // The hint only says Saved once the server acknowledged this write.
    await expect(page.locator('.settings-pi-launch-status')).toContainText(
        hint,
    );
}

async function tabTitles(page: Page): Promise<string[]> {
    return page.locator('.tab-title').allInnerTexts();
}

test.describe('Pi launch default', () => {
    test.setTimeout(240_000);

    let server: PhiServer;

    test.beforeEach(async () => {
        server = await startPhi({
            // The startup Psi command is a relative path containing spaces, so
            // the save-time check and the launch both exercise the configured
            // executable rather than a PATH lookup.
            config: { psi_command: join('psi legacy dir', exeName('psi')) },
            setup: (dir) => {
                const stub = buildStub(dir);
                mkdirSync(join(dir, 'children'), { recursive: true });
                const bin = join(dir, 'bin');
                copyStub(stub, join(bin, exeName('pi')));
                copyStub(stub, join(bin, exeName('psi')));
                // A distinct executable for the configured path, so a record
                // proves which one the server actually ran.
                copyStub(stub, join(dir, 'psi legacy dir', exeName('psi')));
                // A distinct Pi executable, so a Pi launch can also be traced
                // to the configured path rather than the PATH stub.
                copyStub(stub, join(dir, 'pi custom dir', exeName('pi')));
            },
            env: (dir) => ({
                PATH: `${join(dir, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
                PHI_E2E_PI_LAUNCH_DIR: join(dir, 'children'),
            }),
        });
    });

    test.afterEach(async () => {
        await server?.stop();
    });

    test('the saved default decides which agent runs', async ({ page }) => {
        await page.goto(server.url);
        await page.locator('.coder-tab[data-coder="pi"]').click();
        await expect(page.locator('#new-session-btn')).toBeVisible();

        // Psi becomes the default through the real control.
        await openSettings(page);
        await chooseDefault(page, 'Psi', 'Saved');
        await closeSettings(page);

        const beforePsi = recordsFor(server, exeName('psi')).length;
        await page.locator('#new-session-btn').click();
        await expect
            .poll(() => recordsFor(server, exeName('psi')).length, {
                timeout: 60_000,
            })
            .toBe(beforePsi + 1);
        const psiRecord = recordsFor(server, exeName('psi')).at(-1)!;
        // The configured path is the one that ran, not the PATH copy.
        expect(psiRecord.executable.replace(/\\/g, '/')).toContain(
            'psi legacy dir/',
        );
        await expect.poll(() => tabTitles(page)).toContain('+ Psi');
        expect(psiRecord.argv).toContain('--session-id');

        // With a Psi default the menu offers the other agent.
        const beforePi = recordsFor(server, exeName('pi')).length;
        await page.locator('#new-session-btn').click({ button: 'right' });
        const menu = page.locator('.session-ctx-item');
        await expect(menu).toHaveText('Open with Pi');
        await menu.click();
        await expect
            .poll(() => recordsFor(server, exeName('pi')).length, {
                timeout: 60_000,
            })
            .toBe(beforePi + 1);
        await expect.poll(() => tabTitles(page)).toContain('+ Pi');

        // Reverse the default and the opposite action with it.
        await openSettings(page);
        await chooseDefault(page, 'Pi', 'Saved');
        await closeSettings(page);
        const beforePiAgain = recordsFor(server, exeName('pi')).length;
        await page.locator('#new-session-btn').click();
        await expect
            .poll(() => recordsFor(server, exeName('pi')).length, {
                timeout: 60_000,
            })
            .toBe(beforePiAgain + 1);

        const beforePsiAgain = recordsFor(server, exeName('psi')).length;
        await page.locator('#new-session-btn').click({ button: 'right' });
        await expect(page.locator('.session-ctx-item')).toHaveText(
            'Open with Psi',
        );
        await page.locator('.session-ctx-item').click();
        await expect
            .poll(() => recordsFor(server, exeName('psi')).length, {
                timeout: 60_000,
            })
            .toBe(beforePsiAgain + 1);
    });

    test('the configured path, arguments, and env reach the process', async ({
        page,
    }) => {
        await page.goto(server.url);
        await page.locator('.coder-tab[data-coder="pi"]').click();
        await expect(page.locator('#new-session-btn')).toBeVisible();
        await openSettings(page);
        await chooseDefault(page, 'Psi', 'Saved');

        // The fields live in the same Behavior group as the default.
        const command = page.locator('#settings-pi-command');
        const args = page.locator('#settings-pi-args');
        const env = page.locator('#settings-pi-env');
        const hint = page.locator('.settings-pi-launch-status');
        const psiPath = join(server.dir, 'psi legacy dir', exeName('psi'));
        await command.fill(psiPath);
        await command.blur();
        await args.fill('--model\nspace value');
        await env.fill('PHI_E2E_AGENT_MARK=marked');
        await expect(hint).toContainText('Saved');
        await closeSettings(page);

        const before = recordsFor(server, exeName('psi')).length;
        await page.locator('#new-session-btn').click();
        await expect
            .poll(() => recordsFor(server, exeName('psi')).length, {
                timeout: 60_000,
            })
            .toBe(before + 1);
        const record = recordsFor(server, exeName('psi')).at(-1)!;
        expect(record.executable).toBe(psiPath);
        // One entry per line, spaces inside a line preserved, no shell split.
        expect(record.argv.slice(1, 3)).toEqual(['--model', 'space value']);
        expect(record.argv.filter((arg) => arg === '--model')).toHaveLength(1);
        expect(record.argv).toContain('--session-id');
        expect(record.env.PHI_E2E_AGENT_MARK).toBe('marked');

        // Clearing every field returns the launch to PATH psi with no extras.
        await openSettings(page);
        await command.fill('');
        await command.blur();
        await args.fill('');
        await env.fill('');
        await expect(hint).toContainText('Saved');
        await closeSettings(page);

        const beforeClear = recordsFor(server, exeName('psi')).length;
        await page.locator('#new-session-btn').click();
        await expect
            .poll(() => recordsFor(server, exeName('psi')).length, {
                timeout: 60_000,
            })
            .toBe(beforeClear + 1);
        const cleared = recordsFor(server, exeName('psi')).at(-1)!;
        expect(cleared.executable).toBe(
            join(server.dir, 'bin', exeName('psi')),
        );
        expect(cleared.argv.slice(1)).toEqual([
            '--session-id',
            expect.any(String),
        ]);
        // The override is gone, so the inherited value must not leak in.
        expect(cleared.env.PHI_E2E_AGENT_MARK).toBeUndefined();
    });

    test('invalid raw input survives reopening and reload without saving a valid prefix', async ({
        page,
        request,
    }) => {
        await page.goto(server.url);
        await openSettings(page);
        const env = page.locator('#settings-pi-env');
        const args = page.locator('#settings-pi-args');
        const rawEnv = 'FIRST=1\n\nBROKEN';
        const rawArgs = '--model\n\n  space value  \n';
        await env.fill(rawEnv);
        await args.fill(rawArgs);
        await expect(env).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#settings-pi-env-error')).toContainText(
            'Line 3',
        );
        await closeSettings(page);
        await openSettings(page);
        await expect(env).toHaveValue(rawEnv);
        await expect(args).toHaveValue(rawArgs);
        await page.reload();
        await openSettings(page);
        await expect(env).toHaveValue(rawEnv);
        await expect(args).toHaveValue(rawArgs);
        const before = await (
            await request.get(`${server.url}/api/config/pi-launch`)
        ).json();
        expect(before.revision).toBe(0);
        expect(before.pi_env).toEqual({});
        await env.fill('FIRST=1');
        await expect(page.locator('.settings-pi-launch-status')).toContainText(
            'Saved',
        );
        const after = await (
            await request.get(`${server.url}/api/config/pi-launch`)
        ).json();
        expect(after.pi_args).toEqual(['--model', '  space value  ']);
        expect(after.pi_env).toEqual({ FIRST: '1' });
    });

    test('a request without a mode uses the saved default', async ({
        request,
    }) => {
        // Another client that only knows the legacy shape still gets the
        // configured default. Set Psi here so the assertion cannot be
        // satisfied by the empty-config fallback.
        const current = await (
            await request.get(`${server.url}/api/config/pi-launch`)
        ).json();
        const saved = await request.post(`${server.url}/api/config/pi-launch`, {
            data: {
                revision: current.revision,
                fields: { pi_default_mode: 'psi' },
            },
        });
        expect(saved.status()).toBe(200);
        expect((await saved.json()).pi_default_mode).toBe('psi');

        const before = recordsFor(server, exeName('psi')).length;
        const response = await request.post(`${server.url}/api/terminals`, {
            data: { coder: 'pi', session_id: '', title: '' },
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.pi_mode).toBe('psi');
        expect(body.new_pane).toBe(true);
        await expect
            .poll(() => recordsFor(server, exeName('psi')).length, {
                timeout: 60_000,
            })
            .toBe(before + 1);
    });
});

test.describe('Pi launch fields', () => {
    test.setTimeout(240_000);

    let server: PhiServer;

    test.beforeEach(async () => {
        server = await startPhi({
            setup: (dir) => {
                const stub = buildStub(dir);
                mkdirSync(join(dir, 'children'), { recursive: true });
                const bin = join(dir, 'bin');
                copyStub(stub, join(bin, exeName('pi')));
                copyStub(stub, join(bin, exeName('psi')));
                copyStub(stub, join(dir, 'pi custom dir', exeName('pi')));
            },
            env: (dir) => ({
                PATH: `${join(dir, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
                PHI_E2E_PI_LAUNCH_DIR: join(dir, 'children'),
            }),
        });
    });

    test.afterEach(async () => {
        await server?.stop();
    });

    test('labels follow the default and each agent keeps its own fields', async ({
        page,
    }) => {
        await page.goto(server.url);
        await page.locator('.coder-tab[data-coder="pi"]').click();
        await expect(page.locator('#new-session-btn')).toBeVisible();
        await openSettings(page);
        const labels = page.locator('.settings-pi-launch label');
        const command = page.locator('#settings-pi-command');
        const args = page.locator('#settings-pi-args');
        const env = page.locator('#settings-pi-env');
        const hint = page.locator('.settings-pi-launch-status');

        // Pi is the migrated default, so the rows describe Pi.
        await expect(labels.nth(1)).toHaveText(
            'Pi executable (blank = pi on PATH)',
        );
        await expect(labels.nth(2)).toHaveText(
            'Extra Pi arguments (one per line)',
        );
        await expect(labels.nth(3)).toHaveText(
            'Extra Pi environment (KEY=VALUE per line)',
        );
        await expect(command).toHaveAttribute(
            'placeholder',
            '/usr/local/bin/pi',
        );
        await expect(env).toHaveAttribute('placeholder', 'PI_LOG_LEVEL=debug');

        const piPath = join(server.dir, 'pi custom dir', exeName('pi'));
        await command.fill(piPath);
        await command.blur();
        await args.fill('--pi-flag\nspace value');
        await env.fill('PHI_E2E_SECOND_MARK=pi-mark');
        await expect(hint).toContainText('Saved');

        // Switching the default shows the other agent's own, still empty rows.
        await chooseDefault(page, 'Psi', 'Saved');
        await expect(labels.nth(1)).toHaveText(
            'Psi executable (blank = psi on PATH)',
        );
        await expect(labels.nth(2)).toHaveText(
            'Extra Psi arguments (one per line)',
        );
        await expect(labels.nth(3)).toHaveText(
            'Extra Psi environment (KEY=VALUE per line)',
        );
        await expect(command).toHaveValue('');
        await expect(args).toHaveValue('');
        await expect(env).toHaveValue('');

        // Back to Pi: the values saved before the switch are still there.
        await chooseDefault(page, 'Pi', 'Saved');
        await expect(labels.nth(1)).toHaveText(
            'Pi executable (blank = pi on PATH)',
        );
        await expect(command).toHaveValue(piPath);
        await expect(args).toHaveValue('--pi-flag\nspace value');
        await expect(env).toHaveValue('PHI_E2E_SECOND_MARK=pi-mark');
        await closeSettings(page);

        const before = recordsFor(server, exeName('pi')).length;
        await page.locator('#new-session-btn').click();
        await expect
            .poll(() => recordsFor(server, exeName('pi')).length, {
                timeout: 60_000,
            })
            .toBe(before + 1);
        const record = recordsFor(server, exeName('pi')).find(
            (entry) => entry.executable === piPath,
        )!;
        expect(record).toBeDefined();
        expect(record.argv.slice(1, 3)).toEqual(['--pi-flag', 'space value']);
        expect(record.env.PHI_E2E_SECOND_MARK).toBe('pi-mark');
        await expect.poll(() => tabTitles(page)).toContain('+ Pi');

        // The Psi launch still uses PATH psi with no Pi extras.
        await page.locator('#new-session-btn').click({ button: 'right' });
        await expect(page.locator('.session-ctx-item')).toHaveText(
            'Open with Psi',
        );
        await page.locator('.session-ctx-item').click();
        await expect
            .poll(
                () =>
                    recordsFor(server, exeName('psi')).filter((entry) =>
                        entry.executable.includes('bin'),
                    ).length,
                { timeout: 60_000 },
            )
            .toBeGreaterThan(0);
        const psiRecord = recordsFor(server, exeName('psi')).at(-1)!;
        expect(psiRecord.argv).not.toContain('--pi-flag');
        expect(psiRecord.env.PHI_E2E_SECOND_MARK).toBeUndefined();
    });
});
