import { beforeEach, expect, it, vi } from 'vitest';
import { createServerStateAdapter } from '../src/platform/server-state.ts';

const UPSTREAM = 'http://127.0.0.1:7070';

function memoryStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
            store.set(key, value);
        }),
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
});

it.each([
    ['missing value', null, 'missing'],
    ['valid binding', '{"v":1,"origin":"http://127.0.0.1:7070"}', 'ok'],
    ['broken JSON', '{oops', 'corrupt'],
    ['array', '[]', 'corrupt'],
    ['wrong version', '{"v":2,"origin":"http://127.0.0.1:7070"}', 'corrupt'],
    ['missing origin', '{"v":1}', 'corrupt'],
    ['empty origin', '{"v":1,"origin":""}', 'corrupt'],
    [
        'extra field',
        '{"v":1,"origin":"http://127.0.0.1:7070","token":"x"}',
        'corrupt',
    ],
] as const)('reads binding %s', (_name, raw, expected) => {
    const storage = memoryStorage(
        raw === null ? {} : { 'phi.react.auth-server.v1': raw },
    );
    const servers = createServerStateAdapter(storage, UPSTREAM);
    const binding = servers.readBinding();
    expect(binding.status).toBe(expected);
    if (binding.status === 'ok') expect(binding.origin).toBe(UPSTREAM);
});

it.each(['denied read', 'absent storage'] as const)(
    'reports %s instead of throwing',
    (mode) => {
        const denied = () => {
            throw new Error('denied');
        };
        const storage =
            mode === 'absent storage'
                ? null
                : { getItem: vi.fn(denied), setItem: vi.fn(denied) };
        const servers = createServerStateAdapter(storage, UPSTREAM);
        expect(servers.readBinding()).toEqual({ status: 'denied' });
        expect(servers.readHostname()).toBeNull();
        expect(servers.writeBinding(UPSTREAM)).toBe(false);
        expect(servers.writeHostname('phi')).toBe(false);
    },
);

it('writes the exact binding shape', () => {
    const storage = memoryStorage();
    const servers = createServerStateAdapter(storage, UPSTREAM);
    expect(servers.writeBinding(UPSTREAM)).toBe(true);
    expect(storage.store.get('phi.react.auth-server.v1')).toBe(
        JSON.stringify({ v: 1, origin: UPSTREAM }),
    );
    expect(servers.readBinding()).toEqual({ status: 'ok', origin: UPSTREAM });
});

it.each([
    ['missing value', null, null],
    ['valid cache', '{"v":1,"hostname":"phi-1"}', 'phi-1'],
    ['broken JSON', '{oops', null],
    ['wrong version', '{"v":0,"hostname":"phi-1"}', null],
    ['empty hostname', '{"v":1,"hostname":""}', null],
    ['oversized hostname', `{"v":1,"hostname":"${'h'.repeat(256)}"}`, null],
    ['extra field', '{"v":1,"hostname":"phi-1","token":"x"}', null],
] as const)('reads cached hostname %s', (_name, raw, expected) => {
    const storage = memoryStorage(
        raw === null ? {} : { [`phi.react.server-info.v1:${UPSTREAM}`]: raw },
    );
    expect(createServerStateAdapter(storage, UPSTREAM).readHostname()).toBe(
        expected,
    );
});

it('scopes the hostname cache to the configured upstream', () => {
    const storage = memoryStorage();
    const first = createServerStateAdapter(storage, 'http://127.0.0.1:7070');
    const second = createServerStateAdapter(storage, 'http://127.0.0.1:7071');
    expect(first.writeHostname('phi-1')).toBe(true);
    expect(first.readHostname()).toBe('phi-1');
    expect(second.readHostname()).toBeNull();
});

it('writes only valid hostnames and reports storage denial', () => {
    const storage = memoryStorage();
    const servers = createServerStateAdapter(storage, UPSTREAM);
    expect(servers.writeHostname('phi-1')).toBe(true);
    expect(storage.store.get(`phi.react.server-info.v1:${UPSTREAM}`)).toBe(
        JSON.stringify({ v: 1, hostname: 'phi-1' }),
    );
    expect(servers.writeHostname('')).toBe(false);
    expect(servers.writeHostname('h'.repeat(256))).toBe(false);
    expect(servers.readHostname()).toBe('phi-1');
    storage.setItem.mockImplementation(() => {
        throw new Error('denied');
    });
    expect(servers.writeHostname('phi-2')).toBe(false);
    expect(servers.writeBinding(UPSTREAM)).toBe(false);
});
