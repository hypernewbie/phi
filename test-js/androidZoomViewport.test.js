// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';

setupDomHarness();

// The Android shell has no embedder-level zoom factor, so the zoom is
// applied through the page viewport. This is the asset the shell injects.
const SCRIPT = readFileSync(
    resolve(process.cwd(), 'android/app/src/main/assets/zoom.js'),
    'utf8',
);

function load() {
    // biome-ignore lint/security/noGlobalEval: the asset under test
    window.eval(SCRIPT);
    return window;
}

function viewportMeta() {
    return document.querySelector('meta[name=viewport]');
}

describe('android page zoom (viewport)', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    it('narrows the layout viewport to the zoomed width', () => {
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
        document.head.appendChild(meta);
        load().__phiZoomViewport(1024);
        expect(viewportMeta().getAttribute('content')).toBe('width=1024');
    });

    it('restores the original viewport byte for byte at 100 percent', () => {
        const original =
            'width=device-width, initial-scale=1.0, viewport-fit=cover';
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.setAttribute('content', original);
        document.head.appendChild(meta);
        const win = load();
        win.__phiZoomViewport(1024);
        win.__phiZoomViewport(0);
        expect(viewportMeta().getAttribute('content')).toBe(original);
    });

    it('removes a viewport it injected so desktop pages stay desktop', () => {
        const win = load();
        win.__phiZoomViewport(1024);
        expect(viewportMeta().getAttribute('content')).toBe('width=1024');
        win.__phiZoomViewport(0);
        expect(viewportMeta()).toBeNull();
    });

    it('keeps a page without a viewport untouched at 100 percent', () => {
        const win = load();
        win.__phiZoomViewport(0);
        expect(viewportMeta()).toBeNull();
    });

    it('survives repeated zoom steps without losing the original', () => {
        const original =
            'width=device-width, initial-scale=1.0, viewport-fit=cover';
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.setAttribute('content', original);
        document.head.appendChild(meta);
        const win = load();
        for (const width of [853, 731, 640, 512]) {
            win.__phiZoomViewport(width);
        }
        expect(viewportMeta().getAttribute('content')).toBe('width=512');
        win.__phiZoomViewport(0);
        expect(viewportMeta().getAttribute('content')).toBe(original);
    });

    it('never throws on a page it cannot change', () => {
        const win = load();
        expect(() => win.__phiZoomViewport(1024)).not.toThrow();
    });
});
