// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tryNative } from '../web/desktop.js';

const ORIGINAL_HREF = window.location.href;

afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_HREF);
    delete window.__phiDesktop;
    delete document.documentElement.dataset.phiDesktopFullscreen;
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

    it('binds encoded embedded config popouts to their owner and editing view', () => {
        const origin = 'http://a.test:7070',
            profile = 'profile /A';
        window.history.replaceState(
            null,
            '',
            `/?${new URLSearchParams({ desktop: '1', embedded: '1', profile, origin })}`,
        );
        const popup = { opener: {} };
        const open = vi.spyOn(window, 'open').mockReturnValue(popup);
        expect(tryNative('config', { page: 'mobile' })).toBe(true);
        const [path, name, geometry] = open.mock.calls[0];
        const url = new URL(path, location.origin);
        expect(url.searchParams.get('profile')).toBe(profile);
        expect(url.searchParams.get('origin')).toBe(origin);
        expect(url.searchParams.get('embedded')).toBe('1');
        expect(url.searchParams.get('desktop-popout')).toBe('1');
        expect(url.searchParams.get('page')).toBe('mobile');
        expect(name).toBe(
            `phi-config-${encodeURIComponent(profile)}-${encodeURIComponent(origin)}`,
        );
        expect(geometry).toBe('width=860,height=1000');
        expect(popup.opener).toBeNull();
    });

    it('keeps Settings in-page in fullscreen even if a named popup already exists', () => {
        window.history.replaceState(null, '', '/?desktop=1');
        const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null });
        expect(tryNative('config', {})).toBe(true);
        document.documentElement.dataset.phiDesktopFullscreen = 'true';
        expect(tryNative('config', {})).toBe(false);
        expect(open).toHaveBeenCalledTimes(1);
        document.documentElement.dataset.phiDesktopFullscreen = 'false';
        expect(tryNative('config', {})).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
    });

    it('keeps ownerless and legacy-bridge embedded config requests in-page', () => {
        window.history.replaceState(null, '', '/?desktop=1&embedded=1');
        const open = vi.spyOn(window, 'open');
        expect(tryNative('config', {})).toBe(false);
        expect(open).not.toHaveBeenCalled();
        window.__phiDesktop = { request: vi.fn() };
        expect(tryNative('config', {})).toBe(false);
        expect(window.__phiDesktop.request).not.toHaveBeenCalled();
    });

    describe('?desktop=1 marker without a bridge', () => {
        const popouts = [
            ['config', '/config.html?desktop-popout=1', 'phi-config'],
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
