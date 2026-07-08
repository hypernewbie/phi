import { afterEach, vi } from 'vitest';

// Shared harness for jsdom-environment tests. Import and call setupDomHarness()
// at the top of a `// @vitest-environment jsdom` test file.
//
// Discipline (per architecture review): fake the `this`, real the DOM, spy the
// collaborators, mock the boundaries. Node's fetch/WebSocket are REAL globals,
// so we stub them defensively to keep tests off the network, and we reset DOM
// + globals + localStorage after every test to avoid order-dependent leakage.

export function setupDomHarness() {
    afterEach(() => {
        document.body.innerHTML = '';
        if (typeof localStorage !== 'undefined') localStorage.clear();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
}

// mockFetch installs a fetch stub. `handler(url, options)` returns either:
//   - an object with an `ok` key -> used as the response shape
//     ({ ok, status?, json?, text? }), or
//   - any other value -> treated as the JSON body of an ok:200 response.
// Returns the vi.fn so tests can assert on calls.
export function mockFetch(handler) {
    const fn = vi.fn(async (url, options) => {
        const raw = handler ? handler(String(url), options) : undefined;
        const val = raw instanceof Promise ? await raw : raw;
        if (val && typeof val === 'object' && 'ok' in val) {
            return {
                ok: val.ok,
                status: val.status ?? (val.ok ? 200 : 500),
                json: async () => val.json,
                text: async () => val.text ?? '',
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => val,
            text: async () => (typeof val === 'string' ? val : JSON.stringify(val)),
        };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

// stubWebSocket replaces the global WebSocket with an inert stub so accidental
// construction never opens a real connection.
export function stubWebSocket() {
    class FakeWebSocket {
        constructor() {
            this.readyState = 0;
            this.binaryType = '';
        }
        send() {}
        close() {}
        addEventListener() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    return FakeWebSocket;
}
