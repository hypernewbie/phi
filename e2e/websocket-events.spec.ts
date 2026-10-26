import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Notification } from '../web/proto/events.js';
import type {
    MessageFns,
    Notification as NotificationMessage,
} from '../web-src/proto/events.js';
import { startPhi, type PhiServer } from './_server.js';

// The served bundle carries no types; bind its runtime codec to the
// generated declarations so spec-side decoding is fully checked.
const EventsCodec: MessageFns<NotificationMessage> =
    Notification as unknown as MessageFns<NotificationMessage>;

// M2 events gate: a real fswatch-driven markdown change flows through
// the events socket as a bare Notification and refreshes the
// standalone viewer, and a reconnect refreshes content that changed
// while disconnected.

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

test('watcher-driven markdown change and reconnect refresh the viewer', async ({
    page,
    request,
}) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const url = new URL(msg.location().url || phi.url);
        // The isolated home has no OpenCode database or update checker.
        // These unrelated optional services already fail without this
        // flow (same filter as terminal-history-floor.spec.ts).
        if (url.pathname === '/api/update/status' && msg.text().includes('503'))
            return;
        if (
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode' &&
            msg.text().includes('500')
        )
            return;
        consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (req) => failedRequests.push(req.url()));

    // The watcher follows live pane cwds: a pane rooted in the docs
    // dir keeps the note under watch.
    const docs = join(phi.dir, 'docs');
    mkdirSync(docs, { recursive: true });
    const note = join(docs, 'note.md');
    writeFileSync(note, '# Note\n\nMARKER-1\n');
    const created = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd: docs, title: 'Events' },
    });
    expect(created.ok()).toBe(true);

    // Binary capture with passthrough. Installed before navigation.
    const notifications: string[] = [];
    const sockets: { close(): Promise<void> }[] = [];
    await page.routeWebSocket('**/ws/md-events', (socket) => {
        sockets.push(socket);
        const backend = socket.connectToServer();
        socket.onMessage((message) => backend.send(message));
        backend.onMessage((message) => {
            if (Buffer.isBuffer(message)) {
                const decoded = EventsCodec.decode(new Uint8Array(message));
                const kind = decoded.kind;
                if (kind) {
                    notifications.push(
                        kind.$case === 'markdownChanged'
                            ? `md:${kind.value.dir ?? ''}`
                            : kind.$case,
                    );
                }
            }
            socket.send(message);
        });
    });

    await page.goto(
        `${phi.url}/md.html?path=${encodeURIComponent(note)}&cwd=${encodeURIComponent(docs)}`,
    );
    const body = page.locator('#md-view-body');
    await expect(body).toBeVisible();
    await expect
        .poll(() => body.textContent(), { timeout: 20_000 })
        .toContain('MARKER-1');
    await expect.poll(() => sockets.length).toBe(1);

    // Admission: the events token is selected, a tokenless dial fails.
    const admission = await page.evaluate(async (base: string) => {
        const wsUrl = `${base.replace(/^http/, 'ws')}/ws/md-events`;
        const open = (protocols?: string): Promise<string> =>
            new Promise((resolve) => {
                const ws = new WebSocket(wsUrl, protocols);
                ws.onopen = () => {
                    const negotiated = ws.protocol;
                    ws.close();
                    resolve(`open:${negotiated}`);
                };
                ws.onerror = () => resolve('rejected');
            });
        return {
            token: await open('phi.events.protobuf.v1'),
            bare: await open(),
        };
    }, phi.url);
    expect(admission.token).toBe('open:phi.events.protobuf.v1');
    expect(admission.bare).toBe('rejected');
    // The rejected probe dial logs a handshake error by design; the
    // assertions below cover only the viewer flow from here on.
    consoleErrors.length = 0;
    pageErrors.length = 0;
    failedRequests.length = 0;

    // A real watcher-driven change: the viewer refreshes without input.
    writeFileSync(note, '# Note\n\nMARKER-2\n');
    await expect
        .poll(() => body.textContent(), { timeout: 20_000 })
        .toContain('MARKER-2');
    await expect
        .poll(() => notifications.some((n) => n.startsWith('md:')), {
            timeout: 20_000,
        })
        .toBe(true);
    const mdDir = notifications.find((n) => n.startsWith('md:'))!.slice(3);
    expect(note.startsWith(mdDir)).toBe(true);

    // Reconnect refresh: content written while disconnected renders
    // when the viewer redials (10s backoff) without a page reload.
    // (The admission probes above opened their own routed sockets, so
    // count relative growth rather than an absolute total.)
    const routedBefore = sockets.length;
    await sockets[0].close();
    writeFileSync(note, '# Note\n\nMARKER-3\n');
    await expect
        .poll(() => body.textContent(), { timeout: 30_000 })
        .toContain('MARKER-3');
    await expect.poll(() => sockets.length).toBe(routedBefore + 1);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});
