// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendScope } from '../web-src/backend-scope.ts';
import { ThinkingPresetStore } from '../web-src/thinking-presets.ts';

const stores = new Set();

function response(levels = [], { status = 200, payload } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () =>
            payload === undefined ? { thinking_presets: levels } : payload,
        text: async () => (status === 200 ? '' : 'request failed'),
    };
}

function makeStore(profile = 'A', origin = `https://${profile}.test`) {
    const store = new ThinkingPresetStore();
    stores.add(store);
    const scope = new BackendScope(profile, origin);
    store.bind(scope);
    return { store, scope };
}

async function waitForState(store, predicate) {
    await vi.waitFor(() => expect(predicate(store.getState())).toBe(true));
}

const getCalls = (fetchMock) =>
    fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PUT');
const putCalls = (fetchMock) =>
    fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');

beforeEach(() => localStorage.clear());
afterEach(() => {
    for (const store of stores) store.dispose();
    stores.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('ThinkingPresetStore', () => {
    it('rebinds per backend, restores A→B→A caches, and captures backend headers', async () => {
        const server = new Map([
            ['A', ['low']],
            ['B', ['high']],
        ]);
        let holdAReads = false;
        let releaseARead;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            const profile = init.headers['X-Phi-Backend'];
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                server.set(profile, levels);
                return response(levels);
            }
            if (profile === 'A' && holdAReads) {
                holdAReads = false;
                return new Promise((resolve) => {
                    releaseARead = () => resolve(response(server.get('A')));
                });
            }
            return response(server.get(profile));
        });
        vi.stubGlobal('fetch', fetchMock);

        const { store, scope } = makeStore('A');
        await waitForState(store, (state) => state.confirmed?.[0] === 'low');
        store.setLevels(['low', 'max']);
        await waitForState(
            store,
            (state) => state.confirmed?.join(',') === 'low,max',
        );
        expect(putCalls(fetchMock).at(-1)[1].headers['X-Phi-Backend']).toBe(
            'A',
        );

        scope.abort();
        const scopeB = new BackendScope('B', 'https://B.test');
        store.bind(scopeB);
        await waitForState(store, (state) => state.confirmed?.[0] === 'high');
        store.setLevels(['medium']);
        await waitForState(store, (state) => state.confirmed?.[0] === 'medium');

        scopeB.abort();
        holdAReads = true;
        store.bind(new BackendScope('A', 'https://A.test'));
        expect(store.getState().desired).toEqual(['low', 'max']);
        await vi.waitFor(() => expect(releaseARead).toBeTypeOf('function'));
        releaseARead();
        await waitForState(
            store,
            (state) => state.confirmed?.join(',') === 'low,max',
        );
        const lastA = getCalls(fetchMock).at(-1)[1];
        expect(lastA.headers['X-Phi-Backend']).toBe('A');
        expect(store.getState().desired).toEqual(['low', 'max']);
    });

    it('aborts captured-owner body reads and ignores late data after rebind', async () => {
        let releaseARead;
        let signalA;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            const profile = init.headers['X-Phi-Backend'];
            if (profile === 'A') {
                signalA = init.signal;
                return {
                    ok: true,
                    status: 200,
                    json: () =>
                        new Promise((resolve) => {
                            releaseARead = () =>
                                resolve({ thinking_presets: ['low'] });
                        }),
                };
            }
            return response(['high']);
        });
        vi.stubGlobal('fetch', fetchMock);
        const store = new ThinkingPresetStore();
        stores.add(store);
        store.bind(new BackendScope('A', 'https://A.test'));
        await vi.waitFor(() => expect(releaseARead).toBeTypeOf('function'));
        store.bind(new BackendScope('B', 'https://B.test'));
        expect(signalA.aborted).toBe(true);
        await waitForState(store, (state) => state.confirmed?.[0] === 'high');
        releaseARead();
        await Promise.resolve();
        expect(store.getState().confirmed).toEqual(['high']);
        expect(store.getState().desired).toEqual(['high']);
    });

    it('rejects an inconsistent whole cache record rather than clearing the server list', async () => {
        const key = `phi:thinking-presets:v1:A:${encodeURIComponent('https://A.test')}`;
        localStorage.setItem(
            key,
            JSON.stringify({
                version: 1,
                confirmed: ['high'],
                desired: ['turbo'],
                dirty: true,
                saveRequired: false,
                attempt: null,
            }),
        );
        const fetchMock = vi.fn(async () => response(['high']));
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore('A');
        await waitForState(store, (state) => state.confirmed?.[0] === 'high');
        expect(store.getState().desired).toEqual(['high']);
        expect(putCalls(fetchMock)).toHaveLength(0);
    });

    it('keeps a persistent inline warning when localStorage writes are denied', async () => {
        const fetchMock = vi.fn(async (_url, init = {}) =>
            init.method === 'PUT'
                ? response(JSON.parse(init.body).thinking_presets)
                : response([]),
        );
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed !== null);
        store.setLevels(['high']);
        await waitForState(store, (state) => state.confirmed?.[0] === 'high');
        expect(store.getState().desired).toEqual(['high']);
        expect(store.getState().storageWarning).toContain(
            'Browser storage is unavailable',
        );
    });

    it('retains an owner draft in memory across rebinds when storage is denied', async () => {
        const server = new Map([
            ['A', []],
            ['B', []],
        ]);
        let failAReads = false;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            const profile = init.headers['X-Phi-Backend'];
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                server.set(profile, levels);
                return response(levels);
            }
            if (profile === 'A' && failAReads) throw new TypeError('offline');
            return response(server.get(profile));
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store, scope } = makeStore('A');
        await waitForState(store, (state) => state.confirmed?.length === 0);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        failAReads = true;
        store.setLevels(['high']);
        await waitForState(store, (state) => state.error === 'offline');
        expect(store.getState().attempt).toBeNull();
        expect(putCalls(fetchMock)).toHaveLength(0);

        scope.abort();
        const scopeB = new BackendScope('B', 'https://B.test');
        store.bind(scopeB);
        await waitForState(store, (state) => state.confirmed?.length === 0);
        scopeB.abort();
        store.bind(new BackendScope('A', 'https://A.test'));
        expect(store.getState().desired).toEqual(['high']);
        expect(store.getState().dirty).toBe(true);
        expect(store.getState().attempt).toBeNull();
        expect(store.getState().storageWarning).toContain(
            'Browser storage is unavailable',
        );
        expect(putCalls(fetchMock)).toHaveLength(0);
    });

    it('preserves intentional empty intent through the first GET and requires explicit save', async () => {
        let releaseFirstRead;
        let calls = 0;
        const server = ['low'];
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                server.splice(0, server.length, ...levels);
                return response(levels);
            }
            calls++;
            if (calls === 1)
                return new Promise((resolve) => {
                    releaseFirstRead = () => resolve(response(server));
                });
            return response(server);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await vi.waitFor(() => expect(releaseFirstRead).toBeTypeOf('function'));
        store.setLevels(['high']);
        store.setLevels([]);
        releaseFirstRead();
        await waitForState(store, (state) => state.saveRequired);
        expect(store.getState().desired).toEqual([]);
        expect(putCalls(fetchMock)).toHaveLength(0);

        await store.saveAgain();
        await waitForState(
            store,
            (state) => !state.dirty && state.confirmed?.length === 0,
        );
        expect(putCalls(fetchMock)).toHaveLength(1);
        expect(
            JSON.parse(putCalls(fetchMock)[0][1].body).thinking_presets,
        ).toEqual([]);
    });

    it('reconciles a lost PUT after deleting back to stale confirmed empty', async () => {
        let server = [];
        let loseFirstReply = true;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                server = levels;
                if (loseFirstReply) {
                    loseFirstReply = false;
                    throw new TypeError('connection lost after write');
                }
                return response(levels);
            }
            return response(server);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed !== null);
        store.setLevels(['high']);
        await waitForState(
            store,
            (state) => state.attempt?.status === 'unknown',
        );
        store.setLevels([]);
        await waitForState(store, (state) => state.desired.length === 0);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(putCalls(fetchMock)).toHaveLength(1);
        expect(store.getState().attempt?.levels).toEqual(['high']);

        await store.saveAgain();
        await waitForState(
            store,
            (state) =>
                !state.attempt && !state.dirty && state.confirmed?.length === 0,
        );
        expect(putCalls(fetchMock)).toHaveLength(2);
        expect(
            JSON.parse(putCalls(fetchMock)[1][1].body).thinking_presets,
        ).toEqual([]);
    });

    it('queues only one authorized retry behind an already-running wake GET', async () => {
        let server = [];
        let loseFirstReply = true;
        let holdWakeGet = false;
        let releaseWakeGet;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                if (loseFirstReply) {
                    loseFirstReply = false;
                    throw new TypeError('connection lost before apply');
                }
                server = levels;
                return response(levels);
            }
            if (holdWakeGet) {
                holdWakeGet = false;
                return new Promise((resolve) => {
                    releaseWakeGet = () => resolve(response(server));
                });
            }
            return response(server);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed?.length === 0);
        store.setLevels(['high']);
        await waitForState(
            store,
            (state) => state.attempt?.status === 'unknown',
        );

        holdWakeGet = true;
        store.start();
        await vi.waitFor(() => expect(releaseWakeGet).toBeTypeOf('function'));
        const retry = store.saveAgain();
        releaseWakeGet();
        await retry;
        await waitForState(
            store,
            (state) => state.confirmed?.[0] === 'high' && !state.dirty,
        );
        expect(putCalls(fetchMock)).toHaveLength(2);
        expect(
            JSON.parse(putCalls(fetchMock)[1][1].body).thinking_presets,
        ).toEqual(['high']);
    });

    it('serializes refreshes and writes so an older GET cannot replace a successful PUT', async () => {
        let server = [];
        let holdSecondGet = false;
        let releaseSecondGet;
        let active = 0;
        let maximumActive = 0;
        let getCount = 0;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            try {
                if (init.method === 'PUT') {
                    const levels = JSON.parse(init.body).thinking_presets;
                    server = levels;
                    await Promise.resolve();
                    return response(levels);
                }
                getCount++;
                if (getCount === 2 && holdSecondGet) {
                    holdSecondGet = false;
                    return await new Promise((resolve) => {
                        releaseSecondGet = () => resolve(response(server));
                    });
                }
                await Promise.resolve();
                return response(server);
            } finally {
                active--;
            }
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed !== null);

        holdSecondGet = true;
        const olderRefresh = store.refresh();
        await vi.waitFor(() => expect(releaseSecondGet).toBeTypeOf('function'));
        store.setLevels(['high']);
        const laterRefresh = store.refresh();
        releaseSecondGet();
        await Promise.all([olderRefresh, laterRefresh]);
        await waitForState(
            store,
            (state) => state.confirmed?.[0] === 'high' && !state.dirty,
        );
        expect(maximumActive).toBe(1);
        expect(store.getState().desired).toEqual(['high']);
    });

    it('applies edits made while a PUT response is pending', async () => {
        let server = [];
        let finishFirstPut;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                const levels = JSON.parse(init.body).thinking_presets;
                if (levels[0] === 'high') {
                    return new Promise((resolve) => {
                        finishFirstPut = () => {
                            server = levels;
                            resolve(response(levels));
                        };
                    });
                }
                server = levels;
                return response(levels);
            }
            return response(server);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed?.length === 0);
        store.setLevels(['high']);
        await vi.waitFor(() => expect(finishFirstPut).toBeTypeOf('function'));
        store.setLevels(['low']);
        expect(store.getState().desired).toEqual(['low']);
        expect(store.getState().writing).toBe(true);

        finishFirstPut();
        await waitForState(
            store,
            (state) => state.confirmed?.[0] === 'low' && !state.dirty,
        );
        expect(
            putCalls(fetchMock).map(
                ([, init]) => JSON.parse(init.body).thinking_presets,
            ),
        ).toEqual([['high'], ['low']]);
    });

    it('retains a definitive rejected PUT without replaying it on later probes', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async (_url, init = {}) =>
            init.method === 'PUT'
                ? response([], { status: 400 })
                : response([]),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed?.length === 0);
        store.setLevels(['high']);
        await waitForState(
            store,
            (state) => state.attempt?.status === 'rejected',
        );

        store.start();
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(10_001);
        expect(putCalls(fetchMock)).toHaveLength(1);
        expect(store.getState().desired).toEqual(['high']);
        expect(store.getState().dirty).toBe(true);
        expect(store.getState().attempt).toEqual({
            levels: ['high'],
            status: 'rejected',
        });
        expect(store.getState().writing).toBe(false);
    });

    it('keeps an unknown attempt and draft after a malformed 200 acknowledgement', async () => {
        const fetchMock = vi.fn(async (_url, init = {}) =>
            init.method === 'PUT'
                ? response([], { payload: {} })
                : response([]),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed !== null);
        store.setLevels(['high']);
        await waitForState(
            store,
            (state) => state.attempt?.status === 'unknown',
        );
        expect(store.getState().writing).toBe(false);
        expect(store.getState().desired).toEqual(['high']);
        expect(store.getState().error).toContain('not acknowledged');
    });

    it('keeps the write timeout active while a successful response body stalls', async () => {
        vi.useFakeTimers();
        let putStarted;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                putStarted?.();
                return {
                    ok: true,
                    status: 200,
                    json: () => new Promise(() => {}),
                };
            }
            return response([]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await vi.waitFor(() => expect(getCalls(fetchMock)).toHaveLength(1));
        await vi.waitFor(() => expect(store.getState().confirmed).toEqual([]));
        store.setLevels(['high']);
        const putWait = new Promise((resolve) => (putStarted = resolve));
        await putWait;
        await vi.advanceTimersByTimeAsync(15_001);
        expect(store.getState().writing).toBe(false);
        expect(store.getState().attempt?.status).toBe('unknown');
        expect(store.getState().error).toContain('timed out');
    });

    it('cancels body consumption with the captured backend scope', async () => {
        let putStarted;
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') {
                putStarted?.();
                return {
                    ok: true,
                    status: 200,
                    json: () => new Promise(() => {}),
                };
            }
            return response([]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store, scope } = makeStore();
        await waitForState(store, (state) => state.confirmed !== null);
        store.setLevels(['high']);
        const putWait = new Promise((resolve) => (putStarted = resolve));
        await putWait;
        scope.abort();
        await waitForState(
            store,
            (state) => !state.writing && state.attempt !== null,
        );
        expect(store.getState().attempt?.levels).toEqual(['high']);
    });

    it('probes on menu open, online, and the bounded wake timer without replaying an attempt', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async (_url, init = {}) => {
            if (init.method === 'PUT') throw new TypeError('offline');
            return response([]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await vi.waitFor(() => expect(getCalls(fetchMock)).toHaveLength(1));
        await vi.waitFor(() => expect(store.getState().confirmed).toEqual([]));
        store.setLevels(['high']);
        await vi.waitFor(() => expect(store.getState().attempt).not.toBeNull());
        expect(putCalls(fetchMock)).toHaveLength(1);

        store.start();
        await Promise.resolve();
        window.dispatchEvent(new Event('online'));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(getCalls(fetchMock).length).toBeGreaterThanOrEqual(4);
        expect(putCalls(fetchMock)).toHaveLength(1);
        expect(store.getState().attempt?.levels).toEqual(['high']);
    });

    it('uses a freshly refreshed list when discarding the draft', async () => {
        let server = ['high'];
        const fetchMock = vi.fn(async () => response(server));
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await waitForState(store, (state) => state.confirmed?.[0] === 'high');
        store.setLevels(['low']);
        await waitForState(store, (state) => state.desired[0] === 'low');
        server = ['medium'];
        expect(await store.refresh()).toBe(true);
        expect(store.getState().desired).toEqual(['low']);
        store.useServerList();
        expect(store.getState().confirmed).toEqual(['medium']);
        expect(store.getState().desired).toEqual(['medium']);
        expect(store.getState().dirty).toBe(false);
    });

    it('does not relaunch a failed initial GET from each render subscriber', async () => {
        const fetchMock = vi.fn(async () => {
            throw new TypeError('offline');
        });
        vi.stubGlobal('fetch', fetchMock);
        const { store } = makeStore();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.ensureLoaded();
        store.ensureLoaded();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
