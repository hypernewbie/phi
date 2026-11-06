// Native Reload fixture helpers: session-start counting, host
// selection, bridge/replay readers, and the review hold. Real
// pinned Pi plus the compact loopback stub; no mocks.
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    type APIRequestContext,
    type Page,
    type TestInfo,
} from '@playwright/test';
import {
    COMPACT_SESSION_ID,
    seedCompactFixture,
    startCompactStub,
    type CompactSeed,
    type CompactStub,
} from './_pi-context-compact.js';

import { readReplay } from './_terminal-replay.js';

export { COMPACT_SESSION_ID, startCompactStub };
export type { CompactStub };

const RELOAD_EVIDENCE_DIR = join(
    process.cwd(),
    'test-results',
    'legacy',
    'pi-reload-acceptance',
);

export async function saveReloadEvidence(
    testInfo: TestInfo,
    name: string,
    body: string | Buffer,
    contentType: string,
): Promise<void> {
    mkdirSync(RELOAD_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(RELOAD_EVIDENCE_DIR, name), body);
    await testInfo.attach(name, { body, contentType });
}

export interface ReloadSeed extends CompactSeed {
    markerFile: string;
}

// One-pixel PNG for the real paste handler (stages one upload).
const PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Seed the compact agent/provider/session fixture, then append a
// session-start counting extension to the native-pi wrapper and
// honor PI_RELOAD_HOST_BIN for packaged-host runs. Every Pi process
// appends one line per session start to the shared marker file.
export function seedReloadFixture(dir: string, stubPort: number): ReloadSeed {
    const seed = seedCompactFixture(dir, stubPort);
    const markerFile = join(dir, 'reload-starts.log');
    const extension = join(dir, 'reload-markers.mjs');
    writeFileSync(
        extension,
        `import { appendFileSync } from 'node:fs';\n` +
            `const file = ${JSON.stringify(markerFile)};\n` +
            `export default function (pi) {\n` +
            `  pi.on('session_start', () => { appendFileSync(file, 'start\\n'); });\n` +
            `}\n`,
    );
    const wrapper = join(dir, 'native-pi');
    const body = readFileSync(wrapper, 'utf8');
    if (!body.includes('"$@"')) throw new Error('wrapper marker missing');
    let patched = body.replace('"$@"', `--extension '${extension}' "$@"`);
    const hostBin = process.env.PI_RELOAD_HOST_BIN;
    if (hostBin) {
        const hostExec = /^exec '[^']*'/m;
        if (!hostExec.test(patched))
            throw new Error('host wrapper marker missing');
        const quotedHostBin = hostBin.replaceAll("'", "'\\''");
        patched = patched.replace(hostExec, `exec '${quotedHostBin}'`);
    }
    writeFileSync(wrapper, patched);
    return { ...seed, markerFile };
}

export function countStarts(markerFile: string): number {
    if (!existsSync(markerFile)) return 0;
    return readFileSync(markerFile, 'utf8')
        .split('\n')
        .filter((line) => line === 'start').length;
}

export interface ReloadBridgeView {
    state: string;
    connected?: boolean;
    generation?: string;
    telemetry_revision?: string;
    process_id?: string;
    run_id?: string;
    context_revision?: string;
    capabilities?: string[];
    reload_idle?: boolean;
    reload_queued?: boolean;
    reload_pending?: boolean;
    reload_high_water?: string;
}

export async function paneBridgeReload(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<ReloadBridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: ReloadBridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

export async function paneRecording(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<string> {
    return (await readReplay(url, paneID)).data.toString('utf8');
}

// Stage one synthetic image through the real paste handler and wait
// for its chip. Mirrors the compact mobile attachment flow.
export async function stageReloadAttachment(page: Page): Promise<void> {
    await page.evaluate(
        ([pixels]) => {
            const bytes = Uint8Array.from(atob(pixels), (c) => c.charCodeAt(0));
            const file = new File([bytes], 'reload-fixture.png', {
                type: 'image/png',
            });
            const data = new DataTransfer();
            data.items.add(file);
            const event = new Event('paste', {
                bubbles: true,
                cancelable: true,
            });
            Object.defineProperty(event, 'clipboardData', { value: data });
            document.getElementById('input-textarea')?.dispatchEvent(event);
        },
        [PIXEL_PNG_BASE64],
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
        const chips = await page
            .locator('#attachment-strip .attachment-chip')
            .count();
        if (chips === 1) return;
        if (Date.now() > deadline)
            throw new Error(`attachment chip never staged (count ${chips})`);
        await page.waitForTimeout(250);
    }
}

// Record every raw pane-WebSocket frame a page sends, so the spec can
// prove a native menu action emitted no PTY reload input. Text lands
// verbatim; callers search the joined bytes for the command.
export function recordPaneInput(page: Page): { frames: string[] } {
    const frames: string[] = [];
    page.on('websocket', (socket) => {
        socket.on('framesent', (payload: unknown) => {
            const data =
                payload &&
                typeof payload === 'object' &&
                'payload' in (payload as Record<string, unknown>)
                    ? (payload as Record<string, unknown>).payload
                    : payload;
            if (typeof data === 'string') frames.push(data);
            else if (data instanceof Buffer) frames.push(data.toString('utf8'));
            else if (data instanceof ArrayBuffer)
                frames.push(Buffer.from(data).toString('utf8'));
            else if (data instanceof Uint8Array)
                frames.push(Buffer.from(data).toString('utf8'));
        });
    });
    return { frames };
}

export interface ReloadHttpCall {
    status: number;
    body: unknown;
}

// Capture native reload HTTP round trips issued from the page.
export function recordReloadCalls(page: Page): {
    calls: ReloadHttpCall[];
    dispatched: () => ReloadHttpCall[];
} {
    const calls: ReloadHttpCall[] = [];
    page.on('response', (response) => {
        if (
            !response.url().endsWith('/api/pi-bridge/reload') ||
            response.request().method() !== 'POST'
        )
            return;
        void response
            .json()
            .catch(() => null)
            .then((body) => {
                calls.push({ status: response.status(), body });
            });
    });
    return {
        calls,
        // Refusals are HTTP-visible too. A 'stale' refusal dispatches
        // nothing, so only these count as native reload work.
        dispatched: () => calls.filter((call) => call.status === 202),
    };
}

// Click the Cmds Reload entry with the keyboard and wait for the
// menu to close.
export async function clickReloadDesktop(page: Page): Promise<void> {
    const menu = page.locator('#quick-commands-dropup');
    await menu.getByRole('button', { name: '/reload' }).focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
}

// Mark the toasts already on screen, then wait for an unmarked one
// with the text. Counting before the click races the toast that
// dismisses while the new one appears: the replacement takes the
// index the count promised, and an index wait never sees it.
export async function expectNewToast(
    page: Page,
    text: string,
    click: () => Promise<void>,
): Promise<void> {
    const existing = page.locator('.toast', { hasText: text });
    const before = await existing.count();
    for (let index = 0; index < before; index++) {
        await existing
            .nth(index)
            .evaluate((toast) => toast.setAttribute('data-toast-seen', ''));
    }
    await click();
    await expect(
        page.locator('.toast:not([data-toast-seen])', { hasText: text }),
    ).toBeVisible({ timeout: 60_000 });
}

// Press Reload and require the "requested" receipt, tolerating the one
// safe refusal. A 'stale' refusal means the page's Pi bridge snapshot had
// not reached the pane yet: the host was never invoked and no request ID
// was allocated, so pressing again after it lands cannot double-dispatch.
// Every other outcome is final, and the retries are bounded so a broken
// path still fails loudly.
export async function expectReloadRequested(
    page: Page,
    openAndClick: () => Promise<void>,
    attempts = 3,
): Promise<void> {
    const REQUESTED = 'Reload requested — check Pi';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const seen = page.locator('.toast', { hasText: 'Reload' });
        const before = await seen.count();
        for (let index = 0; index < before; index++) {
            await seen
                .nth(index)
                .evaluate((toast) => toast.setAttribute('data-toast-seen', ''));
        }

        await openAndClick();

        const requested = page.locator('.toast:not([data-toast-seen])', {
            hasText: REQUESTED,
        });
        const refused = page.locator('.toast:not([data-toast-seen])', {
            hasText: 'Reload refused',
        });
        const deadline = Date.now() + 30_000;
        let refusedText: string | null = null;
        while (Date.now() < deadline) {
            if (await requested.count()) return;
            if (await refused.count()) {
                refusedText = (await refused.first().textContent()) ?? '';
                break;
            }
            await page.waitForTimeout(100);
        }
        if (refusedText === null)
            throw new Error(
                `Reload produced no receipt toast (attempt ${attempt}/${attempts})`,
            );
        if (!refusedText.includes('stale'))
            throw new Error(`Reload refused: ${refusedText}`);
        await page.waitForTimeout(750);
    }
    throw new Error(
        'Reload kept refusing as stale: the page never picked up the pane snapshot',
    );
}

// Review hold for PHI_RELOAD_REVIEW=1: print the owned server and
// accept local marker files (hold-next, release, finish) inside the
// fixture dir. Each hold lasts at most ten minutes. Bundle-safe.
export async function reloadReviewHold(
    dir: string,
    url: string,
    panes: Record<string, string>,
    controls: { holdNext: () => void; release: () => void },
    log: (message: string) => void,
): Promise<void> {
    const hold = join(dir, 'reload-review-hold-next');
    const release = join(dir, 'reload-review-release');
    const finish = join(dir, 'reload-review-finish');
    log(`PHI_RELOAD_REVIEW server: ${url}`);
    log(`PHI_RELOAD_REVIEW dir: ${dir}`);
    for (const [name, pane] of Object.entries(panes))
        log(`PHI_RELOAD_REVIEW pane ${name}: ${pane}`);
    log(`PHI_RELOAD_REVIEW markers: ${hold} ${release} ${finish}`);
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
        if (existsSync(hold)) {
            rmSync(hold);
            controls.holdNext();
            log('PHI_RELOAD_REVIEW held next completion');
        }
        if (existsSync(release)) {
            rmSync(release);
            controls.release();
            log('PHI_RELOAD_REVIEW released completions');
        }
        if (existsSync(finish)) {
            rmSync(finish);
            log('PHI_RELOAD_REVIEW finished by marker');
            return;
        }
        if (Date.now() > deadline)
            throw new Error('PHI_RELOAD_REVIEW hold expired');
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
