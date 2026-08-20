// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import createDOMPurify from 'dompurify';
import { renderMarkdownSafe } from '../web/md-render.js';

// marked is not an npm dependency — stub it. Identity is faithful for the
// XSS cases: marked passes raw HTML through by default.
const identityMarked = { parse: (s) => s };

beforeEach(() => {
    vi.stubGlobal('DOMPurify', createDOMPurify(window));
    vi.stubGlobal('marked', identityMarked);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('renderMarkdownSafe', () => {
    it('keeps benign tags through sanitization', () => {
        vi.stubGlobal('marked', {
            parse: () => '<h1>hi</h1><p><code>code</code></p>',
        });
        const out = renderMarkdownSafe('# hi');
        expect(out).toContain('<h1');
        expect(out).toContain('<code');
    });

    it('strips <script>', () => {
        const out = renderMarkdownSafe('<script>window.pwned=1</script>');
        expect(out).not.toContain('<script');
    });

    it('strips onerror attributes', () => {
        const out = renderMarkdownSafe('<img src=x onerror="window.pwned=1">');
        expect(out).not.toContain('onerror');
    });

    it('strips <iframe>', () => {
        const out = renderMarkdownSafe('<iframe src="https://x"></iframe>');
        expect(out).not.toContain('<iframe');
    });

    it('falls back to escaped <pre> when DOMPurify is missing', () => {
        vi.stubGlobal('DOMPurify', undefined);
        const out = renderMarkdownSafe('<script>window.pwned=1</script>');
        expect(out.startsWith('<pre>')).toBe(true);
        expect(out.endsWith('</pre>')).toBe(true);
        expect(out).toContain('&lt;script&gt;');
        expect(out).not.toContain('<script>');
    });

    it('returns empty string for empty and null input', () => {
        expect(renderMarkdownSafe('')).toBe('');
        expect(renderMarkdownSafe(null)).toBe('');
    });
});
