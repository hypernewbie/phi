// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { BackendScope } from '../web/backend-scope.js';
import { PiLaunchStore } from '../web/pi-launch.js';

setupDomHarness();
let store;
let server;
let fetcher;
const initial = () => ({
    revision: 0,
    pi_default_mode: 'pi',
    psi_command: '',
    psi_args: [],
    psi_env: {},
});
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const posts = () =>
    fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
const debounce = () => vi.advanceTimersByTimeAsync(301);

beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    server = initial();
    fetcher = vi.fn(async (_url, init = {}) => {
        if (init.method === 'POST') {
            const { revision, fields } = JSON.parse(init.body);
            if (revision !== server.revision)
                return Response.json(server, { status: 409 });
            server = { ...server, ...fields, revision: revision + 1 };
        }
        return Response.json(server);
    });
    vi.stubGlobal('fetch', fetcher);
    store = new PiLaunchStore(new BackendScope('test', 'http://test'));
    await store.refresh();
});
afterEach(() => {
    store.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('saves the latest choice when the user returns to the cached value during a POST', async () => {
    const reply = deferred();
    fetcher.mockImplementationOnce(() => reply.promise);
    store.choose('psi');
    await debounce();
    store.choose('pi');
    server = { ...server, revision: 1, pi_default_mode: 'psi' };
    reply.resolve(Response.json(server));
    await debounce();
    expect(store.mode).toBe('pi');
    expect(server.pi_default_mode).toBe('pi');
    expect(posts()).toHaveLength(2);
});

it('continues newer edits after its own acknowledgement', async () => {
    const reply = deferred();
    fetcher.mockImplementationOnce(() => reply.promise);
    store.choose('psi');
    await debounce();
    store.setCommand('/new/psi');
    server = { ...server, revision: 1, pi_default_mode: 'psi' };
    reply.resolve(Response.json(server));
    await debounce();
    expect(server.psi_command).toBe('/new/psi');
    expect(store.phase).toBe('saved');
});

it('does not retry a rejected version on focus or GET', async () => {
    fetcher.mockImplementationOnce(
        async () => new Response('psi_command is unavailable', { status: 400 }),
    );
    store.setCommand('/missing/psi');
    await debounce();
    await store.refresh();
    await debounce();
    expect(posts()).toHaveLength(1);
    expect(store.phase).toBe('rejected');
});

it('keeps invalid raw input through refresh and reload instead of saving the last valid prefix', async () => {
    store.editText('psi_env', 'FIRST=1');
    store.editText('psi_env', 'FIRST=1\nBROKEN');
    await store.refresh();
    await debounce();
    expect(posts()).toHaveLength(0);
    store.dispose();
    store = new PiLaunchStore(new BackendScope('test', 'http://test'));
    expect(store.text('psi_env')).toBe('FIRST=1\nBROKEN');
    expect(store.fieldError('psi_env')).toContain('Line 2');
});

it('sends a Pi-only recovery ahead of a rejected Psi draft', async () => {
    server = { ...server, revision: 1, pi_default_mode: 'psi' };
    await store.refresh();
    fetcher.mockImplementationOnce(
        async () => new Response('psi_command is unavailable', { status: 400 }),
    );
    store.setCommand('/missing/psi');
    await debounce();
    store.choose('pi');
    await debounce();
    expect(JSON.parse(posts().at(-1)[1].body).fields).toEqual({
        pi_default_mode: 'pi',
    });
    expect(server.pi_default_mode).toBe('pi');
    expect(store.value('psi_command')).toBe('/missing/psi');
    expect(store.fieldError('psi_command')).toContain('unavailable');
    store.setCommand('/fixed/psi');
    await debounce();
    expect(server.psi_command).toBe('/fixed/psi');
    expect(store.phase).toBe('saved');
});

it('reconciles a lost response automatically without another POST', async () => {
    fetcher.mockImplementationOnce(async (_url, init) => {
        const { fields } = JSON.parse(init.body);
        server = { ...server, ...fields, revision: 1 };
        throw new TypeError('lost response');
    });
    store.choose('psi');
    await debounce();
    await vi.advanceTimersByTimeAsync(1100);
    expect(posts()).toHaveLength(1);
    expect(store.phase).toBe('saved');
});

it('does not dispatch an explicit save if its fresh revision read fails', async () => {
    store.choose('psi');
    fetcher.mockImplementationOnce(async () => {
        throw new TypeError('offline');
    });
    await store.saveNow();
    expect(posts()).toHaveLength(0);
});

it('a GET-only match cannot silently rebase newer edits over another writer', async () => {
    fetcher.mockImplementationOnce(async () => {
        throw new TypeError('lost response');
    });
    store.choose('psi');
    await debounce();
    store.setCommand('/my/psi');
    server = {
        ...server,
        revision: 1,
        pi_default_mode: 'psi',
        psi_command: '/their/psi',
    };
    await store.refresh();
    await debounce();
    expect(store.phase).toBe('conflict');
    expect(store.text('psi_command')).toBe('/my/psi');
    expect(posts()).toHaveLength(1);
    await store.saveNow();
    expect(server.psi_command).toBe('/my/psi');
});

it('an obsolete reply cannot settle the replacement explicit attempt', async () => {
    const old = deferred();
    fetcher.mockImplementationOnce(() => old.promise);
    store.choose('psi');
    await debounce();
    const current = deferred();
    fetcher.mockImplementation(async (_url, init) =>
        init?.method === 'POST' ? current.promise : Response.json(server),
    );
    const saving = store.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    const id = store.attempt.id;
    expect(posts()).toHaveLength(2);
    old.resolve(new Response('old rejection', { status: 400 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.attempt.id).toBe(id);
    server = { ...server, revision: 1, pi_default_mode: 'psi' };
    current.resolve(Response.json(server));
    await saving;
    expect(store.phase).toBe('saved');
    expect(store.fieldError('pi_default_mode')).toBe('');
});

it.each(['/second/psi', ''])(
    'keeps a newer command %j during an explicit save’s slow GET',
    async (newCommand) => {
        store.setCommand('/first/psi');
        server = { ...server, revision: 1 };
        await store.refresh();
        const read = deferred();
        fetcher.mockImplementationOnce(() => read.promise);
        const saving = store.saveNow();
        expect(store.canDiscard).toBe(false);
        expect(store.useServerValues()).toBe(false);
        store.setCommand(newCommand);
        read.resolve(Response.json(server));
        await saving;
        expect(JSON.parse(posts()[0][1].body).fields).toEqual({
            psi_command: '/first/psi',
        });
        expect(store.text('psi_command')).toBe(newCommand);
        await debounce();
        expect(server.psi_command).toBe(newCommand);
    },
);

it('pauses a same-revision conflict until the user explicitly saves', async () => {
    fetcher.mockImplementationOnce(async () =>
        Response.json(server, { status: 409 }),
    );
    store.choose('psi');
    await debounce();
    expect(store.phase).toBe('conflict');
    await store.refresh();
    await debounce();
    expect(posts()).toHaveLength(1);
    expect(store.phase).toBe('conflict');
    store.dispose();
    store = new PiLaunchStore(new BackendScope('test', 'http://test'));
    await store.refresh();
    await debounce();
    expect(posts()).toHaveLength(1);
    expect(store.phase).toBe('conflict');
    await store.saveNow();
    expect(server.pi_default_mode).toBe('psi');
    expect(store.phase).toBe('saved');
});

it('does not treat malformed success data as confirmation', async () => {
    fetcher.mockImplementationOnce(async () =>
        Response.json({
            ...server,
            revision: 1,
            pi_default_mode: 'psi',
            psi_env: [],
        }),
    );
    store.choose('psi');
    await debounce();
    expect(store.phase).toBe('unknown');
    expect(store.confirmed.revision).toBe(0);
    expect(store.attempt).not.toBeNull();
});

it('does not echo cache writes or another owner hints into GET loops', async () => {
    const count = fetcher.mock.calls.length;
    for (const key of [
        'phi:pi-launch-cache:v1:' + store.owner,
        'phi:pi-launch-ping:v1:another-owner',
    ])
        window.dispatchEvent(new StorageEvent('storage', { key }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls).toHaveLength(count);
    window.dispatchEvent(
        new StorageEvent('storage', {
            key: 'phi:pi-launch-ping:v1:' + store.owner,
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls).toHaveLength(count + 1);
});

it('scope abort stops retries and callbacks from a late request', async () => {
    const read = deferred();
    fetcher.mockImplementationOnce(() => read.promise);
    const refreshing = store.refresh();
    const notify = vi.fn();
    store.subscribe(notify);
    store.scope.abort();
    read.resolve(
        Response.json({ ...server, revision: 5, pi_default_mode: 'psi' }),
    );
    await refreshing;
    await vi.advanceTimersByTimeAsync(20000);
    expect(notify).not.toHaveBeenCalled();
    expect(store.confirmed.revision).toBe(0);
});
