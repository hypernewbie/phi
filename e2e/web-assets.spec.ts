import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

function writeUI(dir: string, marker: string, color: string): void {
    writeFileSync(
        join(dir, 'index.html'),
        `<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script defer src="/app.js"></script></head><body><h1>${marker}</h1><p id="script">waiting</p></body></html>`,
    );
    writeFileSync(
        join(dir, 'app.js'),
        `document.getElementById('script').textContent = '${marker} script';`,
    );
    writeFileSync(
        join(dir, 'style.css'),
        `body { background-color: ${color}; }`,
    );
}

test('browser refresh loads disk edits without restarting Phi or changing its workspace', async ({
    page,
}) => {
    const phi = await startPhi({
        web: 'assets',
        setup(dir) {
            const assets = join(dir, 'assets');
            mkdirSync(assets);
            writeUI(assets, 'before', 'rgb(11, 22, 33)');
        },
    });
    try {
        await page.goto(phi.url);
        await expect(page.locator('h1')).toHaveText('before');
        await expect(page.locator('#script')).toHaveText('before script');
        await expect(page.locator('body')).toHaveCSS(
            'background-color',
            'rgb(11, 22, 33)',
        );
        const version = await (
            await page.request.get(`${phi.url}/api/version`)
        ).json();
        expect(typeof version.started_at).toBe('string');

        writeUI(join(phi.dir, 'assets'), 'after', 'rgb(44, 55, 66)');
        await page.reload();
        await expect(page.locator('h1')).toHaveText('after');
        await expect(page.locator('#script')).toHaveText('after script');
        await expect(page.locator('body')).toHaveCSS(
            'background-color',
            'rgb(44, 55, 66)',
        );
        const current = await (
            await page.request.get(`${phi.url}/api/version`)
        ).json();
        expect(current.started_at).toBe(version.started_at);

        const config = await (
            await page.request.get(`${phi.url}/api/config`)
        ).json();
        const workspace = realpathSync(phi.dir);
        expect(realpathSync(config.active_cwd)).toBe(workspace);
        const workspaces = config.workspaces.map((dir: string) =>
            realpathSync(dir),
        );
        expect(workspaces).toContain(workspace);
        expect(workspaces).not.toContain(realpathSync(join(phi.dir, 'assets')));
        expect(
            readFileSync(phi.logPath, 'utf8').match(
                /\[main\] Starting Phi in CWD:/g,
            ),
        ).toHaveLength(1);
    } finally {
        await phi.stop();
    }
});
