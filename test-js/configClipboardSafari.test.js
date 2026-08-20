// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Config copy worked in Chrome but did nothing in Safari on macOS.
//
// Safari only honours a clipboard write that is *initiated* in the same task
// as the click. The old code did:
//
//     const res = await fetch(url);      // transient user activation expires
//     const data = await res.json();
//     await navigator.clipboard.writeText(data.config);   // NotAllowedError
//
// Chrome tolerates this; Safari does not. The fix registers the write
// synchronously via ClipboardItem, which accepts a Promise for the data.
//
// The property under test is therefore an ORDERING one: the clipboard write
// must be requested before the network response is available. Asserting only
// "the right text ends up on the clipboard" would pass against the broken
// version too.

setupDomHarness();

function makeBtn() {
    const btn = document.createElement('button');
    btn.innerHTML = '<span>CONFIG</span>';
    document.body.appendChild(btn);
    return btn;
}

let resolveFetch;
let writeCalls;
let writeTextCalls;

beforeEach(() => {
    writeCalls = [];
    writeTextCalls = [];

    // A fetch that stays pending until we release it, so "was the clipboard
    // write requested first?" is directly observable.
    global.fetch = vi.fn(
        () =>
            new Promise((res) => {
                resolveFetch = () =>
                    res({
                        ok: true,
                        json: async () => ({ config: 'PHICONFIG:abc123' }),
                    });
            }),
    );

    global.ClipboardItem = class ClipboardItem {
        constructor(items) {
            this.items = items;
        }
    };

    global.navigator.clipboard = {
        write: vi.fn(async (items) => {
            writeCalls.push(items);
        }),
        writeText: vi.fn(async (t) => {
            writeTextCalls.push(t);
        }),
    };
});

describe('config export survives Safari clipboard rules', () => {
    it('requests the clipboard write before the fetch resolves', async () => {
        const btn = makeBtn();
        const p = App.prototype._doExportConfig.call(
            {},
            '/api/config/export',
            btn,
        );

        // Let the synchronous part run. The network has NOT responded yet.
        await Promise.resolve();
        await Promise.resolve();

        expect(
            navigator.clipboard.write,
            'clipboard.write must be called while the user gesture is still live',
        ).toHaveBeenCalled();
        expect(writeTextCalls).toHaveLength(0);

        resolveFetch();
        await p;
    });

    it('puts the exported config on the clipboard', async () => {
        const btn = makeBtn();
        const p = App.prototype._doExportConfig.call(
            {},
            '/api/config/export',
            btn,
        );
        await Promise.resolve();
        resolveFetch();
        await p;

        expect(writeCalls).toHaveLength(1);
        const blob = await writeCalls[0][0].items['text/plain'];
        expect(await blob.text()).toBe('PHICONFIG:abc123');
    });

    it('falls back to writeText when ClipboardItem is unavailable', async () => {
        delete global.ClipboardItem;
        const btn = makeBtn();
        const p = App.prototype._doExportConfig.call(
            {},
            '/api/config/export',
            btn,
        );
        await Promise.resolve();
        resolveFetch();
        await p;

        expect(writeTextCalls).toEqual(['PHICONFIG:abc123']);
    });

    it('does not refetch when the ClipboardItem write is rejected', async () => {
        navigator.clipboard.write = vi.fn(async () => {
            throw new Error('NotAllowedError');
        });
        const btn = makeBtn();
        const p = App.prototype._doExportConfig.call(
            {},
            '/api/config/export',
            btn,
        );
        await Promise.resolve();
        resolveFetch();
        await p;

        // One request only: the in-flight promise is reused by the fallback.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(writeTextCalls).toEqual(['PHICONFIG:abc123']);
    });
});
