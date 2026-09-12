// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { kindFor } from '../web/file-viewer.js';

describe('file-viewer kindFor', () => {
    it('classifies image extensions', () => {
        for (const ext of [
            '.png',
            '.jpg',
            '.jpeg',
            '.gif',
            '.webp',
            '.svg',
            '.avif',
            '.bmp',
            '.ico',
        ]) {
            expect(kindFor(ext)).toBe('image');
        }
    });

    it('classifies video extensions', () => {
        for (const ext of ['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mkv']) {
            expect(kindFor(ext)).toBe('video');
        }
    });

    it('classifies audio extensions', () => {
        for (const ext of [
            '.mp3',
            '.m4a',
            '.ogg',
            '.oga',
            '.wav',
            '.flac',
            '.opus',
        ]) {
            expect(kindFor(ext)).toBe('audio');
        }
    });

    it('classifies PDF', () => {
        expect(kindFor('.pdf')).toBe('pdf');
    });

    it('classifies markdown', () => {
        expect(kindFor('.md')).toBe('markdown');
        expect(kindFor('.markdown')).toBe('markdown');
    });

    it('classifies code languages by hljs grammar', () => {
        const cases = [
            ['.ts', 'typescript'],
            ['.js', 'javascript'],
            ['.py', 'python'],
            ['.go', 'go'],
            ['.rs', 'rust'],
            ['.sh', 'bash'],
            ['.yaml', 'yaml'],
            ['.toml', 'ini'],
            ['.html', 'xml'],
            ['.css', 'css'],
            ['.diff', 'diff'],
        ];
        for (const [ext] of cases) {
            expect(kindFor(ext)).toBe('code');
        }
    });

    it('classifies JSON', () => {
        expect(kindFor('.json')).toBe('json');
        expect(kindFor('.jsonc')).toBe('json');
        expect(kindFor('.json5')).toBe('json');
    });

    it('falls back to download for unknown extensions', () => {
        expect(kindFor('.zip')).toBe('download');
        expect(kindFor('.exe')).toBe('download');
        expect(kindFor('.unknown')).toBe('download');
    });

    it('classifies PDF to the pdf kind (vendored PDF.js wrapper)', () => {
        // The dispatcher mounts vendor/pdfjs/wrapper.html?file=... for
        // PDF files. A regression here would silently break PDF preview
        // by routing .pdf through the wrong mount function.
        expect(kindFor('.pdf')).toBe('pdf');
    });

    it('is case-insensitive on extension', () => {
        expect(kindFor('.PNG')).toBe('image');
        expect(kindFor('.MP4')).toBe('video');
        expect(kindFor('.JSON')).toBe('json');
        expect(kindFor('.MD')).toBe('markdown');
    });

    it('never returns image/video/audio for HTML/JS/CSS/WASM', () => {
        // The server forces text/plain on these so they never render as
        // active content. The dispatcher must NOT route them to image/
        // video/audio/pdf viewers even if the user clicks them, because
        // a malicious or accidentally-named file must not bypass the
        // server-side guard by being routed through the wrong renderer.
        // .html/.js/.css/.mjs/.xml are routed to code (hljs shows them
        // as text — neutral); .wasm is binary and routes to download.
        expect(kindFor('.html')).toBe('code');
        expect(kindFor('.js')).toBe('code');
        expect(kindFor('.css')).toBe('code');
        expect(kindFor('.wasm')).toBe('download');
        expect(kindFor('.mjs')).toBe('code');
        expect(kindFor('.xml')).toBe('code');
    });
});
