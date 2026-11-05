// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { BackendScope } from '../web/backend-scope.js';
import { PiLaunchStore, parsePsiArgs, parsePsiEnv } from '../web/pi-launch.js';

setupDomHarness();

const RECORD_PREFIX = 'phi:pi-launch-record:v1:';
const stores = [];

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// fixture wires a real store to a small in-memory server that enforces the
// same revision compare-and-swap as the Go handler.
function fixture(profile = 'a', origin = 'http://a.test') {
    const scope = new BackendScope(profile, origin);
    let server = {
        revision: 0,
        pi_default_mode: 'pi',
        psi_command: '',
        psi_args: [],
        psi_env: {},
    };
    const fetch = vi.fn(async (_url, init = {}) => {
        if (init.method === 'POST') {
            const body = JSON.parse(init.body);
            if (body.revision !== server.revision)
                return Response.json(server, { status: 409 });
            server = {
                ...server,
                revision: server.revision + 1,
                ...body.fields,
            };
        }
        return Response.json(server);
    });
    vi.stubGlobal('fetch', fetch);
    const store = new PiLaunchStore(scope);
    stores.push(store);
    return {
        store,
        fetch,
        scope,
        get server() {
            return server;
        },
        set server(value) {
            server = value;
        },
    };
}

const settleEdit = () => vi.advanceTimersByTimeAsync(301);
const posts = (fetch) =>
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('PiLaunchStore keeps edits usable before the network answers', () => {
    it('applies a choice locally, then saves it with a compare-and-swap', async () => {
        const f = fixture();
        await f.store.refresh();
        f.store.choose('psi');
        expect(f.store.mode).toBe('psi');
        expect(f.store.phase).toBe('pending');
        expect(posts(f.fetch)).toHaveLength(0);
        await settleEdit();
        expect(JSON.parse(posts(f.fetch)[0][1].body)).toEqual({
            revision: 0,
            fields: { pi_default_mode: 'psi' },
        });
        expect(f.store.phase).toBe('saved');
        expect(f.store.mode).toBe('psi');
        expect(f.store.pending).toBe(false);
        expect(f.server.pi_default_mode).toBe('psi');
    });

    it('does not dispatch when the attempt marker cannot be stored', async () => {
        const f = fixture();
        await f.store.refresh();
        const setItem = localStorage.setItem.bind(localStorage);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            function (key, value) {
                if (String(key).startsWith(RECORD_PREFIX))
                    throw new Error('quota exceeded');
                setItem(key, value);
            },
        );
        f.store.choose('psi');
        await settleEdit();
        // A write that could be replayed after a reload must not leave without
        // a durable dispatch marker.
        expect(posts(f.fetch)).toHaveLength(0);
        expect(f.store.mode).toBe('psi');
        expect(f.store.storageWarning).not.toBe('');
    });

    it('keeps a write with no answer visible and never resends it', async () => {
        const f = fixture();
        await f.store.refresh();
        f.fetch.mockImplementationOnce(async () => {
            throw new TypeError('network down');
        });
        f.store.choose('psi');
        await settleEdit();
        expect(f.store.phase).toBe('unknown');
        expect(f.store.mode).toBe('psi');
        await settleEdit();
        await settleEdit();
        expect(posts(f.fetch)).toHaveLength(1);
    });

    it('refuses to discard a draft while the write may still apply', async () => {
        const f = fixture();
        await f.store.refresh();
        f.fetch.mockImplementationOnce(async () => {
            throw new TypeError('network down');
        });
        f.store.choose('psi');
        await settleEdit();
        expect(f.store.useServerValues()).toBe(false);
        expect(f.store.mode).toBe('psi');
        expect(f.store.phase).toBe('unknown');
        // The recovery controls match the state: manual save offered, discard not.
        expect(f.store.needsManualSave).toBe(true);
        expect(f.store.canDiscard).toBe(false);
        // A GET at the same base proves nothing about the lost request.
        await f.store.refresh();
        expect(f.store.phase).toBe('unknown');
        expect(f.store.mode).toBe('psi');
    });
});

describe('PiLaunchStore reconciles unknown writes without guessing', () => {
    it('settles the attempt when a later revision already holds its value', async () => {
        const f = fixture();
        await f.store.refresh();
        f.fetch.mockImplementationOnce(async () => {
            throw new TypeError('timeout');
        });
        f.store.choose('psi');
        await settleEdit();
        f.server = { revision: 1, pi_default_mode: 'psi' };
        await f.store.refresh();
        expect(f.store.phase).toBe('saved');
        expect(f.store.pending).toBe(false);
        expect(posts(f.fetch)).toHaveLength(1);
    });

    it('conflicts instead of overwriting another editor', async () => {
        const f = fixture();
        await f.store.refresh();
        f.fetch.mockImplementationOnce(async () => {
            throw new TypeError('timeout');
        });
        f.store.choose('psi');
        await settleEdit();
        f.server = { revision: 1, pi_default_mode: 'pi' };
        await f.store.refresh();
        expect(f.store.phase).toBe('conflict');
        expect(f.store.mode).toBe('psi');
        expect(posts(f.fetch)).toHaveLength(1);
        // A conflict has no write in flight, so server values are an option.
        expect(f.store.needsManualSave).toBe(true);
        expect(f.store.canDiscard).toBe(true);
    });

    it('ignores an older 200 that arrives after newer confirmed state', async () => {
        const f = fixture();
        await f.store.refresh();
        let release;
        f.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        f.store.choose('psi');
        await settleEdit();
        f.server = { revision: 4, pi_default_mode: 'pi' };
        await f.store.refresh();
        release(Response.json({ revision: 1, pi_default_mode: 'psi' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.store.confirmed.revision).toBe(4);
        expect(f.store.mode).toBe('psi');
        expect(f.store.phase).toBe('conflict');
    });

    it('rebases only on an explicit save after a conflict', async () => {
        const f = fixture();
        await f.store.refresh();
        f.store.choose('psi');
        // Another editor advances the revision while this draft is unsaved.
        f.server = { revision: 2, pi_default_mode: 'pi' };
        await f.store.refresh();
        await settleEdit();
        expect(posts(f.fetch)).toHaveLength(0);
        expect(f.store.phase).toBe('conflict');
        await f.store.saveNow();
        expect(posts(f.fetch)).toHaveLength(1);
        expect(JSON.parse(posts(f.fetch)[0][1].body).revision).toBe(2);
        expect(f.store.phase).toBe('saved');
        expect(f.server.pi_default_mode).toBe('psi');
    });

    it('a stale rejection cannot mark newer input as rejected', async () => {
        const f = fixture();
        await f.store.refresh();
        let release;
        f.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        f.store.choose('psi');
        await settleEdit();
        // While Psi is in flight the user changes back to the saved value.
        f.store.choose('pi');
        expect(f.store.mode).toBe('pi');
        release(Response.json({ error: 'nope' }, { status: 400 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.store.phase).toBe('saved');
        expect(f.store.error).toBe('');
        expect(f.store.mode).toBe('pi');
        await settleEdit();
        expect(posts(f.fetch)).toHaveLength(1);
    });
});

describe('PiLaunchStore keeps each backend and document separate', () => {
    it('restores the same backend own draft after switching away', async () => {
        const a1 = fixture('', 'http://a.test');
        await a1.store.refresh();
        a1.store.choose('psi');
        a1.store.dispose();
        stores.splice(stores.indexOf(a1.store), 1);

        const b = fixture('', 'http://b.test');
        await b.store.refresh();
        b.store.choose('pi');
        expect(b.store.mode).toBe('pi');

        const a2 = fixture('', 'http://a.test');
        expect(a2.store.mode).toBe('psi');
        expect(a2.store.phase).toBe('pending');
        // B's choice never follows the user back to A.
        expect(a2.store.mode).toBe('psi');
        expect(b.store.changedFields).toEqual({});
    });

    it('gives a copied recovery hint its own record', async () => {
        const first = fixture();
        await first.store.refresh();
        first.store.choose('psi');
        const firstWriter = first.store.writer;
        first.store.dispose();
        stores.splice(stores.indexOf(first.store), 1);

        // A popup inherits the same sessionStorage hint and copies the draft.
        const second = fixture();
        expect(second.store.mode).toBe('psi');
        expect(second.store.writer).not.toBe(firstWriter);
        second.store.choose('pi');
        await settleEdit();
        second.store.dispose();
        stores.splice(stores.indexOf(second.store), 1);

        const records = Object.keys(localStorage).filter((key) =>
            key.startsWith(RECORD_PREFIX),
        );
        expect(records).toHaveLength(2);
        // The predecessor's record still holds its own draft.
        const firstRecord = JSON.parse(
            localStorage.getItem(
                RECORD_PREFIX + first.store.owner + ':' + firstWriter,
            ),
        );
        expect(firstRecord.draft.fields.pi_default_mode).toBe('psi');
    });

    it('restores a persisted attempt as unknown and does not resend it', async () => {
        const first = fixture();
        await first.store.refresh();
        first.fetch.mockImplementationOnce(async () => {
            throw new TypeError('timeout');
        });
        first.store.choose('psi');
        await settleEdit();
        expect(first.store.phase).toBe('unknown');
        first.store.dispose();
        stores.splice(stores.indexOf(first.store), 1);

        const second = fixture();
        expect(second.store.phase).toBe('unknown');
        expect(second.store.mode).toBe('psi');
        await settleEdit();
        expect(posts(second.fetch)).toHaveLength(0);
    });

    it('keeps editing available when the server is unreachable', async () => {
        const f = fixture();
        f.fetch.mockImplementation(async () => {
            throw new TypeError('offline');
        });
        await f.store.refresh();
        expect(f.store.phase).toBe('unavailable');
        f.store.choose('psi');
        expect(f.store.mode).toBe('psi');
        expect(f.store.phase).toBe('pending');
    });
});

describe('PiLaunchStore sends the Psi launch fields as one patch', () => {
    it('saves command, args, and env together and uses them only once saved', async () => {
        const f = fixture();
        await f.store.refresh();
        f.store.setCommand('/opt/psi');
        f.store.setArgs(['--model', 'space value']);
        f.store.setEnv({ PSI_TRACE: '1' });

        // Before confirmation a launch keeps the saved settings.
        expect(f.store.psiCommand).toBe('');
        expect(f.store.psiArgs).toEqual([]);
        expect(f.store.psiEnv).toEqual({});
        expect(f.store.changedFields).toEqual({
            psi_command: '/opt/psi',
            psi_args: ['--model', 'space value'],
            psi_env: { PSI_TRACE: '1' },
        });
        expect(f.store.phase).toBe('pending');

        await settleEdit();
        expect(posts(f.fetch)).toHaveLength(1);
        expect(JSON.parse(posts(f.fetch)[0][1].body)).toEqual({
            revision: 0,
            fields: {
                psi_command: '/opt/psi',
                psi_args: ['--model', 'space value'],
                psi_env: { PSI_TRACE: '1' },
            },
        });
        expect(f.store.phase).toBe('saved');
        expect(f.store.psiCommand).toBe('/opt/psi');
        expect(f.store.psiArgs).toEqual(['--model', 'space value']);
        expect(f.store.psiEnv).toEqual({ PSI_TRACE: '1' });
        expect(f.store.pending).toBe(false);
    });

    it('keeps a rejected draft for correction and saves the fix', async () => {
        const f = fixture();
        await f.store.refresh();
        f.fetch.mockImplementationOnce(
            async () =>
                new Response(
                    'psi_env key "PATH" is set by Phi and cannot be overridden',
                    { status: 400 },
                ),
        );
        f.store.setEnv({ PATH: '/tmp' });
        await settleEdit();
        expect(f.store.phase).toBe('rejected');
        expect(f.store.error).toContain('cannot be overridden');
        // The rejected value stays on screen so it can be corrected.
        expect(f.store.changedFields).toEqual({ psi_env: { PATH: '/tmp' } });
        expect(f.store.needsManualSave).toBe(true);

        f.store.setEnv({ PSI_TRACE: '1' });
        expect(f.store.error).toBe('');
        await settleEdit();
        expect(f.store.phase).toBe('saved');
        expect(f.store.psiEnv).toEqual({ PSI_TRACE: '1' });
    });

    it('clears the pending draft without a request when a value returns to the saved one', async () => {
        const f = fixture();
        await f.store.refresh();
        f.store.setArgs(['--model']);
        expect(f.store.phase).toBe('pending');
        f.store.setArgs([]);
        expect(f.store.pending).toBe(false);
        expect(f.store.phase).toBe('saved');
        await settleEdit();
        expect(posts(f.fetch)).toHaveLength(0);
    });
});

describe('parsePsiArgs and parsePsiEnv keep typed input predictable', () => {
    it('treats each line as one argument and keeps inner spaces', () => {
        expect(parsePsiArgs('--model\ndeep seek\n\n  \n')).toEqual({
            value: ['--model', 'deep seek', '  '],
        });
        expect(parsePsiArgs('a\r\nb')).toEqual({ value: ['a', 'b'] });
        expect(parsePsiArgs('')).toEqual({ value: [] });
    });

    it('reads env lines and rejects input the server would reject', () => {
        expect(parsePsiEnv('PSI_TRACE=1\n\nEMPTY=\nEQ=a=b\n')).toEqual({
            value: { PSI_TRACE: '1', EMPTY: '', EQ: 'a=b' },
        });
        expect(parsePsiEnv('NOEQUALS')).toEqual({
            error: 'Line 1: expected KEY=VALUE.',
        });
        expect(parsePsiEnv('=value')).toEqual({
            error: 'Line 1: expected KEY=VALUE.',
        });
        expect(parsePsiEnv('1BAD=value')).toEqual({
            error: 'Line 1: 1BAD must match [A-Za-z_][A-Za-z0-9_]*.',
        });
        expect(parsePsiEnv('FOO=1\nfoo=2')).toEqual({
            error: 'Line 2: foo is already set above.',
        });
    });
});
