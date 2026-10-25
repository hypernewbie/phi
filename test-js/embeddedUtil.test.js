// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getEmbeddedBackendOrigin,
    getEmbeddedProfileId,
    serverKey,
    setEmbeddedBackend,
    wsUrl,
} from '../web/util.js';

describe('embedded web/util: wsUrl and serverKey', () => {
    beforeEach(() => {
        setEmbeddedBackend('', '');
    });

    afterEach(() => {
        setEmbeddedBackend('', '');
        vi.unstubAllGlobals();
    });

    it('defaults wsUrl to window.location.origin in normal mode', () => {
        expect(getEmbeddedProfileId()).toBe('');
        expect(getEmbeddedBackendOrigin()).toBe('');

        const url = wsUrl('/ws/pane/p1?term_proto=hot-v1');
        expect(url).toBe(
            `${window.location.origin}/ws/pane/p1?term_proto=hot-v1`,
        );
    });

    it('uses embedded backend origin when configured via setEmbeddedBackend', () => {
        setEmbeddedBackend('prof1', 'http://127.0.0.1:8080');
        expect(getEmbeddedProfileId()).toBe('prof1');
        expect(getEmbeddedBackendOrigin()).toBe('http://127.0.0.1:8080');

        const url = wsUrl('/ws/control');
        expect(url).toBe('http://127.0.0.1:8080/ws/control');
    });

    it('namespaces keys with serverKey only when embedded profile is set', () => {
        expect(serverKey('terminal-active-pane')).toBe('terminal-active-pane');
        expect(serverKey('tabs_order')).toBe('tabs_order');

        setEmbeddedBackend('serverA');
        expect(serverKey('terminal-active-pane')).toBe(
            'terminal-active-pane:serverA',
        );
        expect(serverKey('tabs_order')).toBe('tabs_order:serverA');

        setEmbeddedBackend('serverB');
        expect(serverKey('terminal-active-pane')).toBe(
            'terminal-active-pane:serverB',
        );

        setEmbeddedBackend(null);
        expect(serverKey('terminal-active-pane')).toBe('terminal-active-pane');
    });

    it('falls back to http://localhost when window is undefined', () => {
        const origWindow = globalThis.window;
        try {
            // @ts-ignore
            delete globalThis.window;
            setEmbeddedBackend('', '');
            const url = wsUrl('/ws/pane/1');
            expect(url).toBe('http://localhost/ws/pane/1');
        } finally {
            globalThis.window = origWindow;
        }
    });
});
