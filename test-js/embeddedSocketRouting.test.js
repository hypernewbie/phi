// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setEmbeddedBackend } from '../web/util.js';
import { PTYWebSocket } from '../web/ws.js';
import { connectControl } from '../web/chat-pi/client.js';
import { initMdView } from '../web/md-view.js';

// The embedded desktop view loads the page from phi-app://app and carries the
// real backend in the `origin` query parameter. Every socket must dial that
// backend through wsUrl(); dialing the page origin instead connects to
// nothing, so each transport is checked separately here.

const backend = 'https://phi.example:8443';

function stubSocket() {
    const seen = [];
    vi.stubGlobal(
        'WebSocket',
        class {
            constructor(url, protocols) {
                this.url = url;
                this.protocols = protocols;
                this.readyState = 0;
                seen.push([url, protocols]);
            }
            send() {}
            close() {}
        },
    );
    return seen;
}

afterEach(() => {
    vi.unstubAllGlobals();
    setEmbeddedBackend('', '');
});

describe('embedded view dials the configured backend', () => {
    it('terminal pane socket', () => {
        const seen = stubSocket();
        setEmbeddedBackend('profile-a', backend);

        const pty = new PTYWebSocket('pane-1', () => {});

        expect(pty.url).toBe(`${backend}/ws/pane/pane-1?state=ansi-v1`);
        expect(seen[0][1]).toBe('phi.terminal.protobuf.v1');
        pty.close();
    });

    it('chat control socket', () => {
        const seen = stubSocket();
        setEmbeddedBackend('profile-a', backend);

        const client = connectControl();

        expect(seen[0][0]).toBe(`${backend}/ws/control`);
        expect(seen[0][1]).toBe('phi.control.protobuf.v1');
        client.close();
    });

    it('markdown events socket', () => {
        const seen = stubSocket();
        setEmbeddedBackend('profile-a', backend);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => '# heading\n',
            })),
        );
        window.history.replaceState({}, '', '/md.html?path=/w/a.md&cwd=/w');
        document.body.innerHTML = '<div id="md-view-body"></div>';

        initMdView();

        expect(seen[0][0]).toBe(`${backend}/ws/md-events`);
        expect(seen[0][1]).toBe('phi.events.protobuf.v1');
    });
});
