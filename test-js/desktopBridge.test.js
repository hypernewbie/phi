// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tryNative } from '../web/desktop.js';

const ORIGINAL_HREF = window.location.href;

afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_HREF);
    delete window.__phiDesktop;
    vi.restoreAllMocks();
});

describe('tryNative (desktop bridge)', () => {
    it('returns false and calls nothing when window.__phiDesktop is absent', () => {
        // Plain browser: no injected bridge, no chrome.webview.
        expect(window.__phiDesktop).toBeUndefined();
        expect(tryNative('markdown', { path: 'x', cwd: '.' })).toBe(false);
    });

    it('returns true and delegates to __phiDesktop.request when the host is present', () => {
        const request = vi.fn();
        window.__phiDesktop = { request };

        expect(tryNative('markdown', { path: 'x', cwd: '.' })).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
        // Same {kind, payload} the host's ParseIntent expects (message.go
        // parses {k, p}; the injected bridge stringifies it, not us).
        expect(request).toHaveBeenCalledWith('markdown', {
            path: 'x',
            cwd: '.',
        });
    });

    it('returns false when the bridge exists but exposes no request()', () => {
        window.__phiDesktop = {};
        expect(tryNative('config', {})).toBe(false);
    });

    describe('?desktop=1 marker without a bridge', () => {
        const popouts = [
            ['config', '/config.html', 'phi-config'],
            ['help', '/md.html?page=help', 'phi-help'],
            ['changelog', '/md.html?page=changelog', 'phi-changelog'],
        ];

        it.each(popouts)(
            'opens %s in its named popout window',
            (kind, url, target) => {
                window.history.replaceState(null, '', '/?desktop=1');
                const open = vi
                    .spyOn(window, 'open')
                    .mockReturnValue({ opener: null });

                expect(tryNative(kind, {})).toBe(true);
                expect(open).toHaveBeenCalledTimes(1);
                expect(open).toHaveBeenCalledWith(
                    url,
                    target,
                    'width=860,height=1000',
                );
            },
        );

        it('returns false for unknown kinds without calling window.open', () => {
            window.history.replaceState(null, '', '/?desktop=1');
            const open = vi.spyOn(window, 'open');

            expect(tryNative('export', {})).toBe(false);
            expect(open).not.toHaveBeenCalled();
        });
    });
});
