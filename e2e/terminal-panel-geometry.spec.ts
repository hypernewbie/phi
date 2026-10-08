import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

interface Fit {
    proposeDimensions?(): { cols: number; rows: number } | undefined;
}
interface Term {
    element?: HTMLElement;
    cols: number;
    rows: number;
    fit?: Fit;
    loadAddon(addon: Fit): void;
    buffer: {
        active: {
            baseY: number;
            getLine(
                n: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}
interface GeometryWindow {
    Terminal: new (options: Record<string, unknown>) => Term;
    geometryTerms: Term[];
    observedPanels: string[];
}

test('actual panel CSS resize, tab activation and refresh synchronize backend dimensions', async ({
    page,
}) => {
    const one = 'panel-one',
        two = 'panel-two';
    const recordings = new Map<string, Buffer>([
        [one, Buffer.alloc(0)],
        [two, Buffer.alloc(0)],
    ]);
    const sizes = new Map<string, { cols: number; rows: number }[]>([
        [one, []],
        [two, []],
    ]);
    await page.addInitScript(() => {
        const w = window as unknown as GeometryWindow;
        w.geometryTerms = [];
        w.observedPanels = [];
        let ctor: typeof w.Terminal;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: typeof w.Terminal) => {
                ctor = class extends base {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.geometryTerms.push(this);
                    }
                    loadAddon(addon: Fit) {
                        if (addon.proposeDimensions) this.fit = addon;
                        super.loadAddon(addon);
                    }
                };
            },
        });
        const NativeObserver = window.ResizeObserver;
        window.ResizeObserver = class extends NativeObserver {
            observe(target: Element, options?: ResizeObserverOptions) {
                if (target.id.startsWith('term-panel-'))
                    w.observedPanels.push(target.id);
                super.observe(target, options);
            }
        };
    });
    await page.route('**/api/terminals', (route) =>
        route.fulfill({
            json: [one, two].map((id) => ({
                id,
                title: id,
                coder: 'bash',
                cwd: phi.dir,
                workspace: phi.dir,
                session_id: '',
                pinned: false,
            })),
        }),
    );
    await page.route('**/api/terminals/panel-*/**', (route) =>
        route.fulfill({ json: {} }),
    );
    await page.route('**/api/terminals/panel-*/recording?*', (route) => {
        const url = new URL(route.request().url()),
            id = url.pathname.split('/')[3];
        const source = recordings.get(id)!;
        const start = Number(url.searchParams.get('from')),
            end = Math.min(
                Number(url.searchParams.get('through')),
                source.length,
            );
        const hdr = Buffer.from(
            JSON.stringify({ epoch: 7, start, end, resizes: [] }),
        );
        const length = Buffer.alloc(4);
        length.writeUInt32BE(hdr.length);
        return route.fulfill({
            contentType: 'application/octet-stream',
            body: Buffer.concat([length, hdr, source.subarray(start, end)]),
        });
    });
    await page.routeWebSocket('**/ws/pane/panel-*?*', (socket) => {
        const id = new URL(socket.url()).pathname.split('/').at(-1)!;
        const header = Buffer.from(
            JSON.stringify({
                epoch: 7,
                oldest: 0,
                head: recordings.get(id)!.length,
            }),
        );
        const size = Buffer.alloc(5);
        size[0] = 0x08;
        size.writeUInt32BE(header.length, 1);
        socket.send(Buffer.concat([size, header]));
        socket.onMessage((message) => {
            if (
                !Buffer.isBuffer(message) ||
                message.length !== 5 ||
                message[0] !== 0x02
            )
                return;
            const cols = message.readUInt16BE(1),
                rows = message.readUInt16BE(3);
            sizes.get(id)!.push({ cols, rows });
            // Backend redraw depends on the received PTY dimensions, not browser
            // knowledge. Wrong or missing resize leaves an observable stale grid.
            const paint = Buffer.from(
                `\x1b[2J\x1b[HGRID ${cols}x${rows}\x1b[${rows};1HEDGE`,
            );
            const before = recordings.get(id)!;
            recordings.set(id, Buffer.concat([before, paint]));
            const frame = Buffer.alloc(9);
            frame[0] = 0x09;
            frame.writeBigUInt64BE(BigInt(before.length), 1);
            socket.send(Buffer.concat([frame, paint]));
        });
    });
    const probe = () =>
        page.evaluate((id) => {
            const w = window as unknown as GeometryWindow;
            const term = w.geometryTerms.find(
                (t) =>
                    t.element?.closest('.term-container')?.id === `term-${id}`,
            );
            if (!term) return null;
            return {
                cols: term.cols,
                rows: term.rows,
                proposed: term.fit?.proposeDimensions?.(),
                edge: term.buffer.active
                    .getLine(term.buffer.active.baseY + term.rows - 1)
                    ?.translateToString(true),
            };
        }, one);
    const synced = async () => {
        const state = await probe(),
            sent = sizes.get(one)!.at(-1);
        return (
            !!state &&
            !!sent &&
            state.cols === sent.cols &&
            state.rows === sent.rows &&
            state.proposed?.cols === sent.cols &&
            state.proposed.rows === sent.rows &&
            state.edge === 'EDGE'
        );
    };
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${one}"]`).click();
    await expect.poll(synced).toBe(true);
    await expect
        .poll(() =>
            page.evaluate(() =>
                (window as unknown as GeometryWindow).observedPanels.includes(
                    'term-panel-one',
                ),
            ),
        )
        .toBe(true);
    const before = await probe();
    // No window resize or controller call: content-box observation owns it.
    await page.locator(`#term-${one}`).evaluate((node) => {
        node.style.setProperty('width', '520px', 'important');
        node.style.setProperty('height', '360px', 'important');
    });
    await expect.poll(synced).toBe(true);
    const after = await probe();
    expect([after?.cols, after?.rows]).not.toEqual([
        before?.cols,
        before?.rows,
    ]);
    await page.locator(`.tab[data-pane-id="${two}"]`).click();
    const count = sizes.get(one)!.length;
    await page.locator(`.tab[data-pane-id="${one}"]`).click();
    await expect.poll(() => sizes.get(one)!.length > count).toBe(true);
    await expect.poll(synced).toBe(true);
    const refreshCount = sizes.get(one)!.length;
    await page.locator('#refresh-console-btn').dispatchEvent('click');
    await expect.poll(() => sizes.get(one)!.length > refreshCount).toBe(true);
    await expect.poll(synced).toBe(true);
});
