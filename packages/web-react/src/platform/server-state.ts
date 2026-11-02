export type BindingRead =
    | { status: 'ok'; origin: string }
    | { status: 'missing' }
    | { status: 'corrupt' }
    | { status: 'denied' };

export interface ServerState {
    readonly upstream: string;
    readonly bindingKey: string;
    readBinding(): BindingRead;
    writeBinding(origin: string): boolean;
    readHostname(): string | null;
    writeHostname(hostname: string): boolean;
}

const BINDING_KEY = 'phi.react.auth-server.v1';
const CACHE_PREFIX = 'phi.react.server-info.v1:';
const HOSTNAME_LIMIT = 255;

type BookmarkStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

export function createServerStateAdapter(
    storage: BookmarkStorage = globalThis.localStorage,
    upstream: string = __PHI_UPSTREAM_ORIGIN__,
): ServerState {
    const cacheKey = `${CACHE_PREFIX}${upstream}`;
    const readBinding = (): BindingRead => {
        if (storage === null || storage === undefined)
            return { status: 'denied' };
        let raw: string | null;
        try {
            raw = storage.getItem(BINDING_KEY);
        } catch {
            return { status: 'denied' };
        }
        if (raw === null) return { status: 'missing' };
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            return { status: 'corrupt' };
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return { status: 'corrupt' };
        const record = value as Record<string, unknown>;
        if (
            Object.keys(record).length !== 2 ||
            record.v !== 1 ||
            typeof record.origin !== 'string' ||
            record.origin.length === 0
        )
            return { status: 'corrupt' };
        return { status: 'ok', origin: record.origin };
    };
    const writeBinding = (origin: string): boolean => {
        if (storage === null || storage === undefined) return false;
        try {
            storage.setItem(BINDING_KEY, JSON.stringify({ v: 1, origin }));
            return true;
        } catch {
            return false;
        }
    };
    const readHostname = (): string | null => {
        if (storage === null || storage === undefined) return null;
        let raw: string | null;
        try {
            raw = storage.getItem(cacheKey);
        } catch {
            return null;
        }
        if (raw === null) return null;
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return null;
        const record = value as Record<string, unknown>;
        if (
            Object.keys(record).length !== 2 ||
            record.v !== 1 ||
            typeof record.hostname !== 'string' ||
            record.hostname.length === 0 ||
            record.hostname.length > HOSTNAME_LIMIT
        )
            return null;
        return record.hostname;
    };
    const writeHostname = (hostname: string): boolean => {
        if (
            hostname.length === 0 ||
            hostname.length > HOSTNAME_LIMIT ||
            storage === null ||
            storage === undefined
        )
            return false;
        try {
            storage.setItem(cacheKey, JSON.stringify({ v: 1, hostname }));
            return true;
        } catch {
            return false;
        }
    };
    return {
        upstream,
        bindingKey: BINDING_KEY,
        readBinding,
        writeBinding,
        readHostname,
        writeHostname,
    };
}
