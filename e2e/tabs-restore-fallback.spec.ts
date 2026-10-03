import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

test('invalid native resume becomes a fresh live tab without blocking another backend', async ({
    page,
    request,
}) => {
    const phi = await startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms' },
        setup(dir) {
            const home = join(dir, 'home'),
                cwd = realpathSync(dir),
                command = join(dir, 'codex-fallback');
            writeFileSync(
                command,
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/fallback-args.txt"\ncase "$*" in *resume*) exit 2;; esac\nprintf "fresh ready\\r\\n"\nexec cat\n',
                { mode: 0o755 },
            );
            mkdirSync(join(home, '.phi', 'backends'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'backends', 'codex.json'),
                JSON.stringify({ id: 'codex', command }),
            );
            writeFileSync(
                join(home, '.phi', 'tabs.json'),
                JSON.stringify([
                    {
                        id: 'stale-tab',
                        coder: 'codex',
                        session_id: 'stale-native',
                        cwd,
                        title: 'Keep this tab',
                        pinned: true,
                    },
                    {
                        id: 'other-tab',
                        coder: 'bash',
                        cwd,
                        title: 'Other backend',
                    },
                ]),
            );
            mkdirSync(join(home, '.codex'), { recursive: true });
            const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'));
            db.exec(
                'CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,source TEXT,archived INTEGER)',
            );
            db.prepare(
                "INSERT INTO threads VALUES (?,?,?,1790000000,'cli',0)",
            ).run('stale-native', 'Invalid resume fixture', cwd);
            db.close();
        },
    });
    try {
        await page.goto(phi.url);
        await expect(page.locator('#tabs-container .tab')).toHaveCount(2);
        const panes = await (
            await request.get(`${phi.url}/api/terminals`)
        ).json();
        expect(
            readFileSync(join(phi.dir, 'home', 'fallback-args.txt'), 'utf8'),
        ).toBe('--no-alt-screen resume stale-native\n--no-alt-screen\n');
        expect(
            panes.find((pane: { id: string }) => pane.id === 'stale-tab'),
        ).toMatchObject({
            id: 'stale-tab',
            coder: 'codex',
            session_id: '',
            title: 'Keep this tab',
            pinned: true,
        });
        await page.locator('.tab[data-pane-id="stale-tab"]').click();
        await expect(page.locator('#term-stale-tab .xterm')).toBeVisible();
        await expect(
            page.locator('#term-stale-tab .reconnect-overlay'),
        ).toHaveCount(0);
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
    } catch (error) {
        console.error(readFileSync(phi.logPath, 'utf8'));
        throw error;
    } finally {
        await phi.stop();
    }
});

test('corrupt saved tabs do not abort Phi startup and Shell still launches', async ({
    page,
}) => {
    const phi = await startPhi({
        setup(dir) {
            mkdirSync(join(dir, 'home', '.phi'), { recursive: true });
            writeFileSync(
                join(dir, 'home', '.phi', 'tabs.json'),
                'broken saved state',
            );
        },
    });
    try {
        await page.goto(phi.url);
        const response = page.waitForResponse(
            (reply) =>
                reply.url().endsWith('/api/terminals') &&
                reply.request().method() === 'POST',
        );
        await page
            .locator('#coder-selector .coder-tab[data-coder="bash"]')
            .click();
        expect((await response).ok()).toBe(true);
        await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
        await expect(
            page.getByText('Fresh start', { exact: true }),
        ).toHaveCount(0);
    } finally {
        await phi.stop();
    }
});
