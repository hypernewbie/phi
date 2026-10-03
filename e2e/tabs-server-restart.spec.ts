import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
const uuids = {
    claude: '123e4567-e89b-42d3-a456-426614174001',
    pi: '123e4567-e89b-42d3-a456-426614174002',
    agy: '123e4567-e89b-42d3-a456-426614174003',
    codex: '123e4567-e89b-42d3-a456-426614174004',
};
const rows = [
    { id: 'claude-pane', coder: 'claude', session_id: uuids.claude },
    { id: 'pi-pane', coder: 'pi', session_id: uuids.pi },
    { id: 'agy-pane', coder: 'agy', session_id: uuids.agy },
    { id: 'codex-pane', coder: 'codex', session_id: uuids.codex },
    {
        id: 'full-pane',
        coder: 'opencode',
        session_id: 'ses_full',
        opencode_mode: 'tui',
    },
    {
        id: 'mini-pane',
        coder: 'opencode',
        session_id: 'ses_mini',
        opencode_mode: 'mini',
    },
    {
        id: 'legacy-pane',
        coder: 'opencode',
        session_id: 'ses_legacy',
        opencode_mode: 'legacy',
    },
    { id: 'shell-pane', coder: 'bash', session_id: '' },
    { id: 'pwsh-pane', coder: 'pwsh', session_id: '' },
];
const put = (path: string, data: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
};

test.beforeAll(async () => {
    phi = await startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const cwd = realpathSync(dir),
                home = join(dir, 'home');
            for (const id of [
                'claude',
                'pi',
                'agy',
                'codex',
                'opencode',
                'opencode-v1',
                'bash',
                'pwsh',
            ]) {
                const command = join(dir, `fixture-${id}`);
                writeFileSync(
                    command,
                    `#!/bin/sh
case "$1" in
  --version) case "$0" in *-v1) printf '1.18.34\\n';; *) printf '2.0.21\\n';; esac; exit 0;;
  debug) printf '%s\\n' "$HOME/.local/share/opencode/opencode.db"; exit 0;;
esac
printf '%s: %s\\n' "${id}" "$*" >> "$HOME/launch.log"
printf 'ready ${id}\\r\\n'
exec cat
`,
                    { mode: 0o755 },
                );
                if (id !== 'opencode-v1')
                    put(
                        join(home, '.phi', 'backends', `${id}.json`),
                        JSON.stringify({ id, command }),
                    );
            }
            put(
                join(home, '.phi', 'config.json'),
                JSON.stringify({
                    workspaces: [cwd],
                    opencode_legacy_command: join(dir, 'fixture-opencode-v1'),
                }),
            );
            put(
                join(home, '.phi', 'tabs.json'),
                JSON.stringify(
                    rows.map((row) => ({
                        ...row,
                        cwd,
                        title: `Saved ${row.id}`,
                        workspace: cwd,
                        pinned: true,
                        marked: row.id === 'codex-pane',
                    })),
                ),
            );
            const claudeProject = cwd.replace(/[^a-zA-Z0-9]/g, '-');
            put(
                join(
                    home,
                    '.claude',
                    'projects',
                    claudeProject,
                    `${uuids.claude}.jsonl`,
                ),
                JSON.stringify({
                    type: 'user',
                    cwd,
                    aiTitle: 'Claude fixture',
                }) + '\n',
            );
            const piProject = `--${cwd
                .replace(/^\/+|\/+$/g, '')
                .replace(/:/g, '-')
                .replace(/\//g, '-')}--`;
            put(
                join(
                    home,
                    '.pi',
                    'agent',
                    'sessions',
                    piProject,
                    `2026-10-01_${uuids.pi}.jsonl`,
                ),
                JSON.stringify({
                    type: 'session',
                    version: 3,
                    id: uuids.pi,
                    cwd,
                    timestamp: '2026-10-01T10:00:00Z',
                }) + '\n',
            );
            put(
                join(
                    home,
                    '.gemini',
                    'antigravity-cli',
                    'conversations',
                    `${uuids.agy}.pb`,
                ),
                '',
            );
            put(
                join(
                    home,
                    '.gemini',
                    'antigravity-cli',
                    'brain',
                    uuids.agy,
                    '.system_generated',
                    'logs',
                    'transcript.jsonl',
                ),
                JSON.stringify({ Cwd: cwd }) + '\n',
            );
            mkdirSync(join(home, '.codex'), { recursive: true });
            const codex = new DatabaseSync(
                join(home, '.codex', 'state_5.sqlite'),
            );
            codex.exec(
                'CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,source TEXT,archived INTEGER)',
            );
            codex
                .prepare(
                    "INSERT INTO threads VALUES (?,?,?,1790000000,'cli',0)",
                )
                .run(uuids.codex, 'Codex fixture', cwd);
            codex.close();
            mkdirSync(join(home, '.local', 'share', 'opencode'), {
                recursive: true,
            });
            const oc = new DatabaseSync(
                join(home, '.local', 'share', 'opencode', 'opencode.db'),
            );
            oc.exec(
                'CREATE TABLE project (id TEXT,worktree TEXT); CREATE TABLE session_v2 (id TEXT,title TEXT,slug TEXT,directory TEXT,project_id TEXT,time_updated INTEGER,parent_id TEXT,time_archived INTEGER); CREATE TABLE session (id TEXT,title TEXT,directory TEXT,project_id TEXT,time_updated INTEGER,parent_id TEXT,time_archived INTEGER)',
            );
            for (const id of ['ses_full', 'ses_mini'])
                oc.prepare(
                    'INSERT INTO session_v2 VALUES (?,?,?, ?,NULL,1790000000,NULL,NULL)',
                ).run(id, id, id, cwd);
            oc.prepare(
                'INSERT INTO session VALUES (?,?,?,NULL,1790000000,NULL,NULL)',
            ).run('ses_legacy', 'Legacy fixture', cwd);
            oc.close();
        },
    });
});
test.afterAll(async () => {
    await phi.stop();
});

test('close/restart preserves every backend, exact session, pane identity, flags, order, active tab, and drafts', async ({
    page,
    request,
}) => {
    await page.goto(phi.url);
    await expect(page.locator('#tabs-container .tab')).toHaveCount(rows.length);
    await page.locator('.tab[data-pane-id="codex-pane"]').click();
    await page
        .locator('#input-textarea')
        .fill('unsent draft\twith source spaces  ');
    const order = rows.map((row) => row.id).reverse();
    await page.evaluate((ids) => {
        localStorage.setItem('phi_tab_order', JSON.stringify(ids));
        localStorage.setItem('phi_active_pane', 'codex-pane');
    }, order);
    await phi.restart();
    await page.reload();
    await expect(page.locator('#tabs-container .tab')).toHaveCount(rows.length);
    const running = await (
        await request.get(`${phi.url}/api/terminals`)
    ).json();
    if (running.some((pane: {id: string; session_id: string}) => rows.find(row => row.id === pane.id)?.session_id !== pane.session_id)) {
        console.error(readFileSync(phi.logPath, 'utf8'));
    }
    for (const row of rows) {
        const pane = running.find(
            (entry: { id: string }) => entry.id === row.id,
        );
        expect(pane).toMatchObject({
            id: row.id,
            coder: row.coder,
            session_id: row.session_id,
            title: `Saved ${row.id}`,
            pinned: true,
            marked: row.id === 'codex-pane',
        });
        if ('opencode_mode' in row)
            expect(pane.opencode_mode).toBe(row.opencode_mode);
        await expect(
            page.locator(`.tab[data-pane-id="${row.id}"]`),
        ).toBeVisible();
    }
    expect(
        await page
            .locator('#tabs-container .tab')
            .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute('data-pane-id')),
            ),
    ).toEqual(order);
    await expect(page.locator('.tab.active')).toHaveAttribute(
        'data-pane-id',
        'codex-pane',
    );
    await expect(page.getByText('Fresh start', { exact: true })).toHaveCount(0);
    await expect(page.locator('#input-textarea')).toHaveValue(
        'unsent draft\twith source spaces  ',
    );
    const log = readFileSync(join(phi.dir, 'home', 'launch.log'), 'utf8');
    for (const [coder, id] of Object.entries(uuids))
        expect(log).toContain(
            `${coder}: ${coder === 'codex' ? '--no-alt-screen resume' : coder === 'claude' ? '--resume' : coder === 'pi' ? '--session' : '--conversation'} ${id}`,
        );
    expect(log).toContain('opencode: --session ses_full');
    expect(log).toContain('opencode: mini --session ses_mini');
    expect(log).toContain('opencode-v1: --session ses_legacy');
    // A second close/restart must not erase the restored intent.
    await phi.restart();
    const second = await (await request.get(`${phi.url}/api/terminals`)).json();
    expect(second.map((pane: { id: string }) => pane.id).sort()).toEqual(
        rows.map((row) => row.id).sort(),
    );
});
