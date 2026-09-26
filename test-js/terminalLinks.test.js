// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
    openExternalLink,
    findTerminalLineLinks,
    installTerminalLinkProvider,
} from '../web/util.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { TabManager } from '../web/terminal.js';

let Terminal;

beforeAll(() => {
    Terminal = createHeadlessSandbox().Terminal;
});

describe('openExternalLink', () => {
    it('safely ignores falsy or non-string inputs', () => {
        const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
        openExternalLink('');
        openExternalLink(null);
        openExternalLink(undefined);
        openExternalLink(123);
        openExternalLink('   ');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('rejects unsafe protocols like javascript:, file:, data:', () => {
        const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
        openExternalLink('javascript:alert(1)');
        openExternalLink('file:///etc/passwd');
        openExternalLink('data:text/html,<script>alert(1)</script>');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('opens http, https, and mailto URLs with _blank and noopener,noreferrer', () => {
        const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
        openExternalLink('https://example.com/test');
        expect(spy).toHaveBeenCalledWith(
            'https://example.com/test',
            '_blank',
            'noopener,noreferrer',
        );

        openExternalLink('http://localhost:3000/api');
        expect(spy).toHaveBeenCalledWith(
            'http://localhost:3000/api',
            '_blank',
            'noopener,noreferrer',
        );

        openExternalLink('mailto:user@example.com?subject=hello');
        expect(spy).toHaveBeenCalledWith(
            'mailto:user@example.com?subject=hello',
            '_blank',
            'noopener,noreferrer',
        );
        spy.mockRestore();
    });

    it('prepends https:// to www. addresses', () => {
        const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
        openExternalLink('www.github.com/foo/bar');
        expect(spy).toHaveBeenCalledWith(
            'https://www.github.com/foo/bar',
            '_blank',
            'noopener,noreferrer',
        );
        spy.mockRestore();
    });
});

describe('findTerminalLineLinks', () => {
    it('returns empty array for invalid buffers or out-of-range line numbers', () => {
        expect(findTerminalLineLinks(null, 1)).toEqual([]);
        expect(findTerminalLineLinks({}, 1)).toEqual([]);
        expect(
            findTerminalLineLinks({ length: 5, getLine: () => null }, 0),
        ).toEqual([]);
        expect(
            findTerminalLineLinks({ length: 5, getLine: () => null }, 10),
        ).toEqual([]);
    });

    it('finds single-line URLs and strips trailing sentence punctuation', async () => {
        const term = new Terminal({ cols: 80, rows: 5 });
        await new Promise((r) =>
            term.write(
                'Check https://github.com/org/repo. And (https://example.com)!',
                r,
            ),
        );

        const links = findTerminalLineLinks(term.buffer.active, 1);
        expect(links.length).toBe(2);
        expect(links[0].text).toBe('https://github.com/org/repo');
        expect(links[0].range.start).toEqual({ x: 7, y: 1 });
        expect(links[0].range.end).toEqual({ x: 33, y: 1 });

        expect(links[1].text).toBe('https://example.com');
        expect(links[1].range.start).toEqual({ x: 41, y: 1 });
        expect(links[1].range.end).toEqual({ x: 59, y: 1 });
    });

    it('preserves balanced parentheses in URLs (e.g. Wikipedia links)', async () => {
        const term = new Terminal({ cols: 80, rows: 5 });
        await new Promise((r) =>
            term.write(
                'See https://en.wikipedia.org/wiki/File_(disambiguation) here\r\n',
                r,
            ),
        );

        const links = findTerminalLineLinks(term.buffer.active, 1);
        expect(links.length).toBe(1);
        expect(links[0].text).toBe(
            'https://en.wikipedia.org/wiki/File_(disambiguation)',
        );
    });

    it('seamlessly reconstructs links wrapped across multiple terminal lines', async () => {
        // cols = 15 forces wrapping across 3 lines
        const term = new Terminal({ cols: 15, rows: 5 });
        // 'https://example.com/very/long/url' has 33 chars: 15 on line 1, 15 on line 2, 3 on line 3
        await new Promise((r) =>
            term.write('https://example.com/very/long/url', r),
        );

        // Queried from line 1
        const links1 = findTerminalLineLinks(term.buffer.active, 1);
        expect(links1.length).toBe(1);
        expect(links1[0].text).toBe('https://example.com/very/long/url');
        expect(links1[0].range.start).toEqual({ x: 1, y: 1 });
        expect(links1[0].range.end).toEqual({ x: 3, y: 3 });

        // Queried from line 2 (middle of wrap)
        const links2 = findTerminalLineLinks(term.buffer.active, 2);
        expect(links2.length).toBe(1);
        expect(links2[0].text).toBe('https://example.com/very/long/url');
        expect(links2[0].range.start).toEqual({ x: 1, y: 1 });
        expect(links2[0].range.end).toEqual({ x: 3, y: 3 });

        // Queried from line 3 (end of wrap)
        const links3 = findTerminalLineLinks(term.buffer.active, 3);
        expect(links3.length).toBe(1);
        expect(links3[0].text).toBe('https://example.com/very/long/url');
        expect(links3[0].range.start).toEqual({ x: 1, y: 1 });
        expect(links3[0].range.end).toEqual({ x: 3, y: 3 });

        // Queried from line 4 (empty line after wrap)
        const links4 = findTerminalLineLinks(term.buffer.active, 4);
        expect(links4).toEqual([]);
    });

    it('correctly maps coordinates in lines with wide characters and hieroglyphs', async () => {
        const term = new Terminal({ cols: 40, rows: 5 });
        // '中' is width 2
        await new Promise((r) => term.write('foo 中 https://phi.dev bar', r));

        const links = findTerminalLineLinks(term.buffer.active, 1);
        expect(links.length).toBe(1);
        expect(links[0].text).toBe('https://phi.dev');
        // 'foo ' = 4 cols (1..4), '中' = 2 cols (5..6), ' ' = 1 col (7) -> 'https://phi.dev' starts at col 8
        expect(links[0].range.start).toEqual({ x: 8, y: 1 });
        expect(links[0].range.end).toEqual({ x: 22, y: 1 });
    });

    it('correctly maps coordinates when wide characters push link to wrap', async () => {
        const term = new Terminal({ cols: 20, rows: 5 });
        // 4 + 2 + 1 + 15 = 22 columns; with cols=20, link wraps onto line 2
        await new Promise((r) => term.write('foo 中 https://phi.dev bar', r));

        const links = findTerminalLineLinks(term.buffer.active, 1);
        expect(links.length).toBe(1);
        expect(links[0].text).toBe('https://phi.dev');
        expect(links[0].range.start).toEqual({ x: 8, y: 1 });
        expect(links[0].range.end).toEqual({ x: 2, y: 2 });
    });
});

describe('installTerminalLinkProvider', () => {
    it('registers a provider and triggers activation with openExternalLink', async () => {
        let registeredProvider = null;
        const mockTerm = {
            buffer: {
                active: {
                    length: 1,
                    getLine: () => ({
                        isWrapped: false,
                        length: 80,
                        translateToString: () =>
                            'Visit https://deepmind.google/ today!',
                        getCell: (x) => ({
                            getWidth: () => 1,
                            getChars: () =>
                                'Visit https://deepmind.google/ today!'[x] ||
                                ' ',
                        }),
                    }),
                },
            },
            registerLinkProvider: vi.fn((provider) => {
                registeredProvider = provider;
                return { dispose: vi.fn() };
            }),
        };

        let activated = null;
        const disposable = installTerminalLinkProvider(mockTerm, (url) => {
            activated = url;
        });

        expect(mockTerm.registerLinkProvider).toHaveBeenCalledTimes(1);
        expect(disposable).toBeDefined();
        expect(typeof disposable.dispose).toBe('function');

        let capturedLinks = null;
        registeredProvider.provideLinks(1, (links) => {
            capturedLinks = links;
        });

        expect(capturedLinks).toHaveLength(1);
        expect(capturedLinks[0].text).toBe('https://deepmind.google/');
        capturedLinks[0].activate(null, capturedLinks[0].text);
        expect(activated).toBe('https://deepmind.google/');

        disposable.dispose();
        expect(disposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('returns undefined gracefully when terminal lacks registerLinkProvider', () => {
        expect(installTerminalLinkProvider(null)).toBeUndefined();
        expect(installTerminalLinkProvider({})).toBeUndefined();
    });
});

describe('TabManager terminal link wiring', () => {
    it('installs link provider and registers OSC linkHandler', () => {
        const mockTerm = {
            registerLinkProvider: vi.fn(),
        };
        const tm = Object.create(TabManager.prototype);
        tm._installTerminalLinkProvider(mockTerm);
        expect(mockTerm.registerLinkProvider).toHaveBeenCalledTimes(1);
    });
});
