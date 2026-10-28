// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    decodeNotificationDir,
    initMdView,
    mdEventMatchesPath,
    mdEventRetryDelay,
} from '../web/md-view.js';
import { installToken, __test__ } from '../web/auth.js';
import { Notification } from '../web/proto/events.js';

// Pure helpers of the standalone markdown viewer (web-src/md-view.ts).
// No DOM needed: importing md-view.js is side-effect-free by design
// (initMdView is only called from md.html).

function encodeNotification(kind) {
    return Notification.encode(
        Notification.fromPartial(kind === undefined ? {} : { kind }),
    ).finish();
}

describe('decodeNotificationDir', () => {
    it('returns the dir of a markdown notification (round-trip)', () => {
        const bytes = encodeNotification({
            $case: 'markdownChanged',
            value: { dir: '/tmp/docs' },
        });
        expect(decodeNotificationDir(bytes)).toBe('/tmp/docs');
    });

    it('returns null for other notification kinds', () => {
        const sync = encodeNotification({
            $case: 'syncChanged',
            value: { action: 'upsert', key: 'k' },
        });
        expect(decodeNotificationDir(sync)).toBeNull();
        const shutdown = encodeNotification({
            $case: 'shutdown',
            value: { reason: 'restart' },
        });
        expect(decodeNotificationDir(shutdown)).toBeNull();
    });

    it('decodes and ignores a large sync notification', () => {
        // Sync values can exceed the server's inbound 4 KiB events cap. The
        // viewer must keep ignoring them without treating the frame as fatal.
        const sync = encodeNotification({
            $case: 'syncChanged',
            value: { action: 'upsert', key: 'k'.repeat(8 * 1024) },
        });
        expect(sync.byteLength).toBeGreaterThan(4096);
        expect(decodeNotificationDir(sync)).toBeNull();
    });

    it('returns null for empty and undecodable payloads', () => {
        expect(decodeNotificationDir(encodeNotification(undefined))).toBeNull();
        expect(decodeNotificationDir(new Uint8Array([0x82, 0xff]))).toBeNull();
    });
});

describe('mdEventMatchesPath', () => {
    it('matches a file inside the event dir', () => {
        expect(mdEventMatchesPath('/a/docs', '/a/docs/x.md')).toBe(true);
    });

    it('does not match a sibling dir sharing a prefix', () => {
        expect(mdEventMatchesPath('/a/docs', '/a/docs2/x.md')).toBe(false);
    });

    it('matches (refreshes anyway) when dir is unknown', () => {
        expect(mdEventMatchesPath('', '/a/docs/x.md')).toBe(true);
        expect(mdEventMatchesPath(null, '/a/docs/x.md')).toBe(true);
    });

    it('handles a trailing-slash dir', () => {
        expect(mdEventMatchesPath('/a/docs/', '/a/docs/x.md')).toBe(true);
    });

    it('matches Windows backslash paths', () => {
        expect(mdEventMatchesPath('C:\\ws', 'C:\\ws\\x.md')).toBe(true);
    });
});

// initMdView renders either a whitelisted static page or one workspace file.
// md.html decides whether to bootstrap first; these tests pin what each branch
// touches so a public help page can never start a login or a protected call.
function mdHarness() {
    document.body.innerHTML = '<main id="md-view-body"></main>';
    const sockets = [];
    vi.stubGlobal(
        'WebSocket',
        class {
            constructor(url) {
                this.url = url;
                this.binaryType = '';
                sockets.push(this);
            }
            send() {}
            close() {}
        },
    );
    const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '# page',
        json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    return { sockets, fetchSpy };
}

afterEach(() => {
    window.history.replaceState({}, '', '/md.html');
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    __test__.resetAccessState();
});

describe('initMdView', () => {
    it('loads a static page without auth or a socket', async () => {
        const { sockets, fetchSpy } = mdHarness();
        window.history.replaceState({}, '', '/md.html?page=help');
        initMdView();
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(fetchSpy.mock.calls[0][0]).toBe('help.md');
        expect(sockets).toHaveLength(0);
        expect(
            fetchSpy.mock.calls.some(([url]) =>
                String(url).startsWith('/api/auth/'),
            ),
        ).toBe(false);
    });

    it('loads a workspace file and dials the events socket', async () => {
        const { sockets, fetchSpy } = mdHarness();
        window.history.replaceState({}, '', '/md.html?path=a.md&cwd=/w');
        initMdView();
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        expect(String(fetchSpy.mock.calls[0][0])).toContain(
            '/api/markdown/file?',
        );
        const url = new URL(sockets[0].url);
        expect(url.pathname).toBe('/ws/md-events');
        expect(url.searchParams.get('token')).toBeNull();
    });

    it('carries the v2 token on the events socket', async () => {
        const { sockets } = mdHarness();
        installToken('jwt-a');
        window.history.replaceState({}, '', '/md.html?path=a.md&cwd=/w');
        initMdView();
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        expect(new URL(sockets[0].url).searchParams.get('token')).toBe('jwt-a');
    });

    it('keeps the images of an unchanged render when a refresh lands first', async () => {
        // An authenticated image is fetched after the Markdown render. A
        // second, identical refresh must not revoke the object URLs that the
        // content still on screen owns.
        document.body.innerHTML = '<main id="md-view-body"></main>';
        const sockets = [];
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor(url) {
                    this.url = url;
                    this.binaryType = '';
                    sockets.push(this);
                }
                send() {}
                close() {}
            },
        );
        const raw = '<img src="pic.png">\n';
        vi.stubGlobal('marked', { parse: (s) => s });
        vi.stubGlobal('DOMPurify', { sanitize: (html) => html });
        let releaseSecond = () => {};
        const fetchSpy = vi.fn(async () => {
            if (fetchSpy.mock.calls.length === 1) {
                return { ok: true, status: 200, text: async () => raw };
            }
            await new Promise((resolve) => {
                releaseSecond = resolve;
            });
            return { ok: true, status: 200, text: async () => raw };
        });
        vi.stubGlobal('fetch', fetchSpy);
        const original = window.phiAccessAuth.assetURL;
        const revoke = vi.fn();
        let releaseAsset = () => {};
        window.phiAccessAuth.assetURL = () =>
            new Promise((resolve) => {
                releaseAsset = () => resolve({ url: 'blob:pic', revoke });
            });
        try {
            window.history.replaceState({}, '', '/md.html?path=a.md&cwd=/w');
            initMdView();
            const notReady = releaseAsset;
            await vi.waitFor(() => expect(releaseAsset).not.toBe(notReady));
            const img = document.querySelector('.md-rendered img');
            expect(img.getAttribute('src')).toBeNull();

            // The events socket refreshes while the image is in flight.
            sockets[0].onopen();
            await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
            releaseSecond();
            releaseAsset();
            await vi.waitFor(() =>
                expect(img.getAttribute('src')).toBe('blob:pic'),
            );
            expect(revoke).not.toHaveBeenCalled();
        } finally {
            window.phiAccessAuth.assetURL = original;
        }
    });
});

describe('mdEventRetryDelay', () => {
    it('keeps every retry above the floor so a flapping server is not hot-looped', () => {
        for (let attempt = 1; attempt <= 12; attempt += 1) {
            expect(mdEventRetryDelay(attempt, () => 0)).toBe(500);
        }
    });

    it('grows exponentially and caps at 20s plus the floor', () => {
        expect(mdEventRetryDelay(1, () => 1)).toBe(1500);
        expect(mdEventRetryDelay(2, () => 1)).toBe(2500);
        expect(mdEventRetryDelay(3, () => 1)).toBe(4500);
        expect(mdEventRetryDelay(9, () => 1)).toBe(20500);
        expect(mdEventRetryDelay(40, () => 1)).toBe(20500);
    });

    it('applies full jitter inside the capped window', () => {
        expect(mdEventRetryDelay(4, () => 0.5)).toBe(4500);
        // Attempt 0 or a negative attempt cannot invert the exponent.
        expect(mdEventRetryDelay(0, () => 0)).toBe(500);
    });
});

describe('md events reconnect', () => {
    it('retries a closed events socket on bounded backoff, not a fixed 10s', async () => {
        vi.useFakeTimers();
        try {
            const { sockets } = mdHarness();
            window.history.replaceState({}, '', '/md.html?path=a.md&cwd=/w');
            initMdView();
            await vi.waitFor(() => expect(sockets).toHaveLength(1));

            // Maximum jitter makes the schedule deterministic: attempt 1 waits
            // floor + 1000, attempt 2 waits floor + 2000.
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
            sockets[0].onclose();
            await vi.advanceTimersByTimeAsync(1499);
            expect(sockets).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(sockets).toHaveLength(2);

            sockets[1].onclose();
            await vi.advanceTimersByTimeAsync(2499);
            expect(sockets).toHaveLength(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(sockets).toHaveLength(3);
            randomSpy.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    it('dials synchronously when no refresh is due', async () => {
        // A v1 cookie session has no in-memory token, so refreshAccessIfDue
        // returns undefined and the dial must not be deferred by a microtask.
        const { sockets } = mdHarness();
        window.history.replaceState({}, '', '/md.html?path=a.md&cwd=/w');
        initMdView();
        expect(sockets).toHaveLength(1);
    });
});
