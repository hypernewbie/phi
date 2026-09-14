import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { expect, test } from '@playwright/test';

// 1x1 transparent PNG.
const PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

const PREVIEW_JS = [
    'vendor/viewerjs/viewer.min.js',
    'vendor/plyr/plyr.polyfilled.js',
    'vendor/json-viewer/json-viewer.bundle.js',
];

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

async function waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (res.ok) return;
        } catch {
            // Server still compiling/starting.
        }
        if (Date.now() > deadline) throw new Error('phi server never came up');
        await new Promise((r) => setTimeout(r, 500));
    }
}

let dir = '';
let server: ChildProcess | undefined;
let baseURL = '';

function run(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`${cmd} exited ${code}`)),
        );
    });
}

test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'phi-e2e-'));
    writeFileSync(join(dir, 'e2e.png'), PIXEL_PNG);
    // Clean HOME so the server starts with no access password (open API).
    mkdirSync(join(dir, 'home'), { recursive: true });

    const port = await freePort();
    baseURL = `http://127.0.0.1:${port}`;
    // Build once, then run the binary with cwd inside the tmp dir so
    // the file tree is rooted there (and only there).
    const root = process.cwd();
    const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
    await run('go', ['build', '-o', bin, '.'], root);
    server = spawn(bin, ['--port', String(port), '--ip', '127.0.0.1'], {
        cwd: dir,
        env: {
            ...process.env,
            HOME: join(dir, 'home'),
            USERPROFILE: join(dir, 'home'),
            APPDATA: join(dir, 'home'),
        },
        stdio: 'ignore',
    });
    await waitForHealth(port);
});

test.afterAll(async () => {
    if (server && server.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
            server?.once('exit', () => resolve()),
        );
        server.kill();
        await Promise.race([
            exited,
            new Promise((r) => setTimeout(r, 5_000)),
        ]);
    }
    // Best-effort: the binary can stay briefly locked on Windows.
    if (dir) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Tmp dirs are reaped by the OS; never fail the run on cleanup.
        }
    }
});

test('preview vendor JS loads on first open, not on page load', async ({
    page,
}) => {
    const vendorHits: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (PREVIEW_JS.some((v) => url.endsWith(v))) vendorHits.push(url);
    });

    await page.goto(baseURL);
    // The file tree lives in the diff panel's files tab. The panel
    // starts open on wide viewports, so only toggle when hidden.
    const panelHidden = await page
        .locator('#diff-panel')
        .evaluate((el) => el.classList.contains('hidden'));
    if (panelHidden) await page.locator('#header-diff-toggle-btn').click();
    await page.locator('.diff-tab-btn[data-tab="files"]').click();
    const row = page.locator('#file-tree-list .md-file-row', {
        hasText: 'e2e.png',
    });
    await expect(row).toContainText('e2e.png', { timeout: 30_000 });

    // Settle: no preview vendor bundle may load just from viewing the page.
    await page.waitForTimeout(2_000);
    expect(vendorHits).toEqual([]);
    expect(await page.evaluate(() => (window as any).Viewer)).toBeUndefined();

    const openPreview = async () => {
        await row.locator('.md-file-action-btn').click();
        await page
            .locator('.md-context-label', { hasText: 'Preview' })
            .click();
        await expect(page.locator('#md-modal-body img.file-viewer-image')).toBeVisible({
            timeout: 30_000,
        });
    };

    await openPreview();
    expect(vendorHits.filter((u) => u.endsWith('viewer.min.js'))).toHaveLength(1);
    expect(await page.evaluate(() => typeof (window as any).Viewer)).toBe(
        'function',
    );

    // Second open reuses the loaded bundle: still exactly one fetch.
    await page.locator('#md-modal-close').click();
    await openPreview();
    expect(vendorHits.filter((u) => u.endsWith('viewer.min.js'))).toHaveLength(1);
});
