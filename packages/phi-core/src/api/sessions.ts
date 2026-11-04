// Session list + rename wrappers. Ports web-src/sessions.ts list,
// validation, and rename behavior; the transport is injected so core
// stays free of HTTP, timers, and storage.
import type {
    AbortSignalLike,
    ApiTransport,
    RenameOutcome,
    Session,
    SessionsOutcome,
    TransportResult,
} from './types.ts';

// The single source of the paginated session list URL: every read,
// cache write, and cache lookup must produce the same string. The cwd
// passes through verbatim including empty (the server substitutes its
// activeCWD). Limit/offset pass through unvalidated: the server owns
// 400s, clamps, and the limit <= 0 means all rule.
export function sessionsUrl(
    coder: string,
    cwd: string,
    limit: number,
    offset = 0,
): string {
    return `/api/sessions?coder=${encodeURIComponent(coder)}&cwd=${encodeURIComponent(cwd)}&limit=${limit}&offset=${offset}`;
}

function isSessionEntry(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
    if (typeof entry.title !== 'string') return false;
    if (typeof entry.time_updated !== 'string') return false;
    if (!Number.isFinite(Date.parse(entry.time_updated))) return false;
    return ['cwd', 'coder', 'session_path'].every(
        (key) => !(key in entry) || typeof entry[key] === 'string',
    );
}

function toSession(entry: Record<string, unknown>): Session {
    const session: {
        id: string;
        title: string;
        cwd?: string;
        coder?: string;
        session_path?: string;
        time_updated: string;
    } = {
        id: entry.id as string,
        title: entry.title as string,
        time_updated: entry.time_updated as string,
    };
    for (const key of ['cwd', 'coder', 'session_path'] as const) {
        if (typeof entry[key] === 'string') session[key] = entry[key];
    }
    return session;
}

// Strict whole-page decode (legacy isSessionPage): one bad entry
// rejects the page. Returns null for any shape violation, including
// a top-level non-array. Unknown wire fields are dropped, never
// surfaced. Legacy rejects pages longer than the requested limit,
// and legacy always sends a positive page size. When limit <= 0 the
// server returns every session, so a length check would be
// meaningless — skip it.
export function decodeSessionPage(
    data: unknown,
    limit: number,
): Session[] | null {
    if (!Array.isArray(data)) return null;
    if (limit > 0 && data.length > limit) return null;
    if (!data.every(isSessionEntry)) return null;
    return data.map((entry) => toSession(entry as Record<string, unknown>));
}

export interface ListSessionsOptions {
    readonly coder: string;
    readonly cwd: string;
    readonly limit: number;
    readonly offset?: number;
    readonly signal: AbortSignalLike;
    readonly bearer?: string;
}

// Never throws on bad data, bad status, or transport rejection:
// everything maps into SessionsOutcome.
export async function listSessions(
    transport: ApiTransport,
    options: ListSessionsOptions,
): Promise<SessionsOutcome> {
    let result: TransportResult;
    try {
        result = await transport({
            method: 'GET',
            path: sessionsUrl(
                options.coder,
                options.cwd,
                options.limit,
                options.offset ?? 0,
            ),
            signal: options.signal,
            bearer: options.bearer,
        });
    } catch {
        return { kind: 'unavailable' };
    }
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'network-failure') return { kind: 'unavailable' };
    if (result.status === 401 || result.status === 403)
        return { kind: 'auth-required' };
    if (result.status === 400) return { kind: 'unsupported-coder' };
    if (result.status !== 200) return { kind: 'unavailable' };
    let data: unknown;
    try {
        data = JSON.parse(result.text);
    } catch {
        return { kind: 'invalid-response' };
    }
    const sessions = decodeSessionPage(data, options.limit);
    if (sessions === null) return { kind: 'invalid-response' };
    return { kind: 'ok', sessions };
}

export interface RenameSessionOptions {
    readonly id: string;
    readonly currentTitle: string;
    readonly name: string;
    readonly signal: AbortSignalLike;
    readonly bearer?: string;
}

// Renames via POST /api/session-meta. Empty or unchanged names never
// touch the transport. Same no-throw invariant as listSessions. The
// server sends an empty body; it is not read.
export async function renameSession(
    transport: ApiTransport,
    options: RenameSessionOptions,
): Promise<RenameOutcome> {
    const trimmed = options.name.trim();
    if (trimmed === '' || trimmed === options.currentTitle)
        return { kind: 'unchanged' };
    let result: TransportResult;
    try {
        result = await transport({
            method: 'POST',
            path: '/api/session-meta',
            body: JSON.stringify({ id: options.id, name: trimmed }),
            signal: options.signal,
            bearer: options.bearer,
        });
    } catch {
        return { kind: 'unavailable' };
    }
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'network-failure') return { kind: 'unavailable' };
    if (result.status === 401 || result.status === 403)
        return { kind: 'auth-required' };
    if (result.status !== 200) return { kind: 'unavailable' };
    return { kind: 'ok' };
}
