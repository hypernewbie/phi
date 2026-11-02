import type { AuthStatus, CredentialBundle } from '@phi/core';
import { z } from 'zod';

export type ConnectionResult =
    | 'disabled'
    | 'protected'
    | 'unsupported'
    | 'unavailable'
    | 'cancelled';

export type AuthStatusOutcome =
    | { kind: 'ok'; status: AuthStatus }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };

export type LoginOutcome =
    | { kind: 'accepted'; bundle: CredentialBundle }
    | { kind: 'invalid-length' }
    | { kind: 'rejected'; status: number; retryAfterMs: number | null }
    | { kind: 'unconfirmed' }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'cancelled' };

export type RefreshOutcome =
    | { kind: 'accepted'; bundle: CredentialBundle }
    | { kind: 'rejected'; status: number; retryAfterMs: number | null }
    | { kind: 'unconfirmed' }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'cancelled' };

export type ConfigOutcome =
    | { kind: 'ok'; hostname: string }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'cancelled' };

export type TogglePath =
    | '/api/config/use-hidden-terminal'
    | '/api/config/use-existing-terminal-tab'
    | '/api/config/auto-reconnect'
    | '/api/config/pi-offline'
    | '/api/config/pi-bridge-no-inject'
    | '/api/config/claude-dangerously-skip-permissions'
    | '/api/config/agy-theme-ansi'
    | '/api/config/opencode-idle-stop';

export type PostOutcome =
    | { kind: 'ok' }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'cancelled' };

export interface VersionDocument {
    readonly version: string;
    readonly commit: string;
    readonly date: string;
    readonly buildSource: string;
}

export type DocumentOutcome<T> =
    | { kind: 'ok'; document: T }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'unsupported' }
    | { kind: 'blocked' }
    | { kind: 'cancelled' };

export type ConfigDocumentOutcome = DocumentOutcome<ConfigDocument>;
export type VersionOutcome = DocumentOutcome<VersionDocument>;

export interface ConnectionService {
    readonly serverLabel: string;
    getStatus(signal: AbortSignal): Promise<ConnectionResult>;
    getAuthStatus(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<AuthStatusOutcome>;
    login(password: string, signal: AbortSignal): Promise<LoginOutcome>;
    refresh(signal: AbortSignal): Promise<RefreshOutcome>;
    getConfigHostname(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<ConfigOutcome>;
    getConfigDocument(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<ConfigDocumentOutcome>;
    getVersion(signal: AbortSignal, bearer?: string): Promise<VersionOutcome>;
    postConfig(
        path: TogglePath,
        bodyJson: string,
        signal: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome>;
}

const ATTEMPT_TIMEOUT_MS = 15_000;
const AUTH_BODY_LIMIT = 16 * 1024;
const CONFIG_BODY_LIMIT = 4 * 1024 * 1024;
const BUNDLE_TOKEN_LIMIT = 8192;
const ACCESS_LIFETIME_MAX_S = 3600;
const PASSWORD_MIN_BYTES = 8;
const PASSWORD_MAX_BYTES = 1024;
const HOSTNAME_LIMIT = 255;
const PROXY_ERROR_HEADER = 'X-Phi-Proxy-Error';
const UPSTREAM_MISMATCH = 'upstream-mismatch';

async function withDeadline<T>(
    caller: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T | 'cancelled' | 'expired'> {
    if (caller.aborted) return 'cancelled';
    const controller = new AbortController();
    let interrupt: (result: 'cancelled' | 'expired') => void = () => {};
    const interrupted = new Promise<'cancelled' | 'expired'>((resolve) => {
        interrupt = resolve;
    });
    const cancel = () => {
        interrupt('cancelled');
        controller.abort();
    };
    caller.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
        interrupt('expired');
        controller.abort();
    }, ATTEMPT_TIMEOUT_MS);
    try {
        return await Promise.race([interrupted, run(controller.signal)]);
    } finally {
        clearTimeout(timer);
        caller.removeEventListener('abort', cancel);
        controller.abort();
    }
}

async function readBoundedJson(
    response: Response,
    limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return { ok: false };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) {
                await reader.cancel().catch(() => {});
                return { ok: false };
            }
            chunks.push(value);
        }
    } catch {
        return { ok: false };
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
    } catch {
        return { ok: false };
    }
}

function discardBody(response: Response): void {
    void response.body?.cancel().catch(() => {});
}

function decodeAuthStatus(
    body: unknown,
    credentialed: boolean,
): AuthStatus | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
        return null;
    const { enabled, authenticated, owned } = body as Record<string, unknown>;
    if (
        typeof enabled !== 'boolean' ||
        typeof authenticated !== 'boolean' ||
        typeof owned !== 'boolean'
    )
        return null;
    if (authenticated && (!enabled || !owned)) return null;
    if (authenticated && !credentialed) return null;
    return { enabled, authenticated, owned };
}

function decodeBundle(body: unknown): CredentialBundle | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
        return null;
    const {
        token,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_idle_expires_at: refreshIdle,
        refresh_absolute_expires_at: refreshAbsolute,
    } = body as Record<string, unknown>;
    if (
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > BUNDLE_TOKEN_LIMIT ||
        !/^[\x21-\x7E]+$/.test(token)
    )
        return null;
    for (const value of [expiresAt, expiresIn, refreshIdle, refreshAbsolute]) {
        if (!Number.isSafeInteger(value) || (value as number) <= 0) return null;
    }
    if ((expiresIn as number) > ACCESS_LIFETIME_MAX_S) return null;
    if ((refreshIdle as number) > (refreshAbsolute as number)) return null;
    return {
        token,
        expiresAt: expiresAt as number,
        expiresIn: expiresIn as number,
        refreshIdleExpiresAt: refreshIdle as number,
        refreshAbsoluteExpiresAt: refreshAbsolute as number,
    };
}

function decodeHostname(body: unknown): string | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
        return null;
    const { hostname } = body as Record<string, unknown>;
    if (
        typeof hostname !== 'string' ||
        hostname.length === 0 ||
        hostname.length > HOSTNAME_LIMIT
    )
        return null;
    return hostname;
}

// Single source for the settings document shape: the wire decoder maps
// into it and the settings store reuses it for cache validation. Unknown
// fields are ignored.
export const configDocumentSchema = z.object({
    hostname: z.string().min(1).max(HOSTNAME_LIMIT),
    workspaces: z.array(z.string()),
    hiddenTerminal: z.boolean(),
    reuseTab: z.boolean(),
    autoReconnect: z.string(),
    fastMode: z.boolean(),
    piOffline: z.boolean(),
    piBridgeNoInject: z.boolean(),
    claudeSkipPermissions: z.boolean(),
    agyThemeAnsi: z.boolean(),
    opencodeIdleMinutes: z.number().int().min(0),
});

export type ConfigDocument = z.infer<typeof configDocumentSchema>;

const configWireSchema = z.object({
    hostname: z.string().min(1).max(HOSTNAME_LIMIT),
    workspaces: z.array(z.string()),
    use_hidden_terminal: z.boolean(),
    use_existing_terminal_tab: z.boolean(),
    auto_reconnect: z.string(),
    fast_mode: z.boolean(),
    pi_offline: z.boolean(),
    pi_bridge_no_inject: z.boolean(),
    claude_dangerously_skip_permissions: z.boolean(),
    agy_theme_ansi: z.boolean(),
    opencode_idle_stop_minutes: z.number().int().min(0),
});

function decodeConfigDocument(body: unknown): ConfigDocument | null {
    const parsed = configWireSchema.safeParse(body);
    if (!parsed.success) return null;
    const wire = parsed.data;
    const document: ConfigDocument = {
        hostname: wire.hostname,
        workspaces: wire.workspaces,
        hiddenTerminal: wire.use_hidden_terminal,
        reuseTab: wire.use_existing_terminal_tab,
        autoReconnect: wire.auto_reconnect,
        fastMode: wire.fast_mode,
        piOffline: wire.pi_offline,
        piBridgeNoInject: wire.pi_bridge_no_inject,
        claudeSkipPermissions: wire.claude_dangerously_skip_permissions,
        agyThemeAnsi: wire.agy_theme_ansi,
        opencodeIdleMinutes: wire.opencode_idle_stop_minutes,
    };
    return document;
}

const versionWireSchema = z.object({
    version: z.string().min(1),
    commit: z.string().catch(''),
    date: z.string().catch(''),
    build_source: z.string().catch(''),
});

function decodeVersionDocument(body: unknown): VersionDocument | null {
    const parsed = versionWireSchema.safeParse(body);
    if (!parsed.success) return null;
    const wire = parsed.data;
    return {
        version: wire.version,
        commit: wire.commit,
        date: wire.date,
        buildSource: wire.build_source,
    };
}

// Complete interval in milliseconds, or null without a usable wait.
// Infinity marks a valid delay too large to represent safely: callers
// must pause automatic work rather than shorten the server wait.
const IMF_FIXDATE =
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
function parseRetryAfterMs(
    response: Response,
    receivedWallMs: number,
): number | null {
    const raw = response.headers.get('Retry-After');
    if (raw === null) return null;
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        if (!Number.isSafeInteger(seconds)) return Number.POSITIVE_INFINITY;
        const milliseconds = seconds * 1000;
        return Number.isSafeInteger(milliseconds)
            ? milliseconds
            : Number.POSITIVE_INFINITY;
    }
    // HTTP-dates must match the IMF-fixdate shape: Date.parse also
    // accepts bare numbers that are not valid dates.
    if (!IMF_FIXDATE.test(text)) return null;
    const target = Date.parse(text);
    if (Number.isNaN(target)) return null;
    const dateRaw = response.headers.get('Date');
    const dateMs =
        dateRaw !== null && IMF_FIXDATE.test(dateRaw.trim())
            ? Date.parse(dateRaw.trim())
            : NaN;
    const reference = Number.isNaN(dateMs) ? receivedWallMs : dateMs;
    return Math.max(0, target - reference);
}

function passwordByteLength(password: string): number {
    return new TextEncoder().encode(password).byteLength;
}

type StatusAttempt =
    | 'unavailable'
    | 'unsupported'
    | 'blocked'
    | { status: AuthStatus };

type BundleAttempt =
    | 'unconfirmed'
    | 'unsupported'
    | 'blocked'
    | { rejected: number; retryAfterMs: number | null }
    | { bundle: CredentialBundle };

type ConfigAttempt =
    | 'unavailable'
    | 'unsupported'
    | 'blocked'
    | { rejected: number }
    | { hostname: string };

type DocumentAttempt<T> =
    | 'unavailable'
    | 'unsupported'
    | 'blocked'
    | { rejected: number }
    | { document: T };

export function createConnectionService(
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    upstreamOrigin: string = __PHI_UPSTREAM_ORIGIN__,
): ConnectionService {
    const headersFor = (
        bearer: string | undefined,
        post: boolean,
    ): Record<string, string> => {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Phi-Upstream': upstreamOrigin,
        };
        if (post) {
            headers['Content-Type'] = 'application/json';
            headers['X-Phi-Auth'] = 'v2';
        }
        if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
        return headers;
    };
    const getAuthStatus = async (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<AuthStatusOutcome> => {
        const outcome = await withDeadline<StatusAttempt>(
            caller,
            async (signal) => {
                let response: Response;
                try {
                    response = await fetchImpl('/api/auth/v2/status', {
                        method: 'GET',
                        credentials: 'omit',
                        redirect: 'error',
                        cache: 'no-store',
                        headers: headersFor(bearer, false),
                        signal,
                    });
                } catch {
                    return 'unavailable' as const;
                }
                try {
                    if (response.redirected) return 'unavailable';
                    if (
                        response.headers.get(PROXY_ERROR_HEADER) ===
                        UPSTREAM_MISMATCH
                    )
                        return 'blocked';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (response.status !== 200) return 'unavailable';
                    const body = await readBoundedJson(
                        response,
                        AUTH_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unavailable';
                    const status = decodeAuthStatus(
                        body.value,
                        bearer !== undefined,
                    );
                    return status === null ? 'unavailable' : { status };
                } finally {
                    discardBody(response);
                }
            },
        );
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unavailable' };
        if (outcome === 'unavailable') return { kind: 'unavailable' };
        if (outcome === 'unsupported') return { kind: 'unsupported' };
        if (outcome === 'blocked') return { kind: 'blocked' };
        return { kind: 'ok', status: outcome.status };
    };
    const postBundle = async (
        path: '/api/auth/v2/login' | '/api/auth/v2/refresh',
        bodyJson: string,
        caller: AbortSignal,
    ): Promise<RefreshOutcome> => {
        const outcome = await withDeadline<BundleAttempt>(
            caller,
            async (signal) => {
                let response: Response;
                let receivedWallMs = 0;
                try {
                    response = await fetchImpl(path, {
                        method: 'POST',
                        credentials: 'same-origin',
                        redirect: 'error',
                        cache: 'no-store',
                        headers: headersFor(undefined, true),
                        body: bodyJson,
                        signal,
                    });
                    receivedWallMs = Date.now();
                } catch {
                    return 'unconfirmed';
                }
                try {
                    if (response.redirected) return 'unconfirmed';
                    if (
                        response.headers.get(PROXY_ERROR_HEADER) ===
                        UPSTREAM_MISMATCH
                    )
                        return 'blocked';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (
                        response.status === 400 ||
                        response.status === 401 ||
                        response.status === 403 ||
                        response.status === 429 ||
                        response.status === 500 ||
                        response.status === 503
                    )
                        return {
                            rejected: response.status,
                            retryAfterMs:
                                response.status === 429 ||
                                response.status === 503
                                    ? parseRetryAfterMs(
                                          response,
                                          receivedWallMs,
                                      )
                                    : null,
                        };
                    if (response.status !== 200) return 'unconfirmed';
                    const body = await readBoundedJson(
                        response,
                        AUTH_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unconfirmed';
                    const bundle = decodeBundle(body.value);
                    return bundle === null ? 'unconfirmed' : { bundle };
                } finally {
                    discardBody(response);
                }
            },
        );
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unconfirmed' };
        if (outcome === 'unconfirmed') return { kind: 'unconfirmed' };
        if (outcome === 'unsupported') return { kind: 'unsupported' };
        if (outcome === 'blocked') return { kind: 'blocked' };
        if ('rejected' in outcome)
            return {
                kind: 'rejected',
                status: outcome.rejected,
                retryAfterMs: outcome.retryAfterMs,
            };
        return { kind: 'accepted', bundle: outcome.bundle };
    };
    const login = async (
        password: string,
        caller: AbortSignal,
    ): Promise<LoginOutcome> => {
        const bytes = passwordByteLength(password);
        if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES)
            return { kind: 'invalid-length' };
        return postBundle(
            '/api/auth/v2/login',
            JSON.stringify({ password }),
            caller,
        );
    };
    const refresh = (caller: AbortSignal): Promise<RefreshOutcome> =>
        postBundle('/api/auth/v2/refresh', '{}', caller);
    const getConfigHostname = async (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<ConfigOutcome> => {
        const outcome = await withDeadline<ConfigAttempt>(
            caller,
            async (signal) => {
                let response: Response;
                try {
                    response = await fetchImpl('/api/config', {
                        method: 'GET',
                        credentials: 'omit',
                        redirect: 'error',
                        cache: 'no-store',
                        headers: headersFor(bearer, false),
                        signal,
                    });
                } catch {
                    return 'unavailable' as const;
                }
                try {
                    if (response.redirected) return 'unavailable';
                    if (
                        response.headers.get(PROXY_ERROR_HEADER) ===
                        UPSTREAM_MISMATCH
                    )
                        return 'blocked';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (response.status === 401 || response.status === 403)
                        return { rejected: response.status };
                    if (response.status !== 200) return 'unavailable';
                    const body = await readBoundedJson(
                        response,
                        CONFIG_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unavailable';
                    const hostname = decodeHostname(body.value);
                    return hostname === null ? 'unavailable' : { hostname };
                } finally {
                    discardBody(response);
                }
            },
        );
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unavailable' };
        if (outcome === 'unavailable') return { kind: 'unavailable' };
        if (outcome === 'unsupported') return { kind: 'unsupported' };
        if (outcome === 'blocked') return { kind: 'blocked' };
        if ('rejected' in outcome)
            return { kind: 'rejected', status: outcome.rejected };
        return { kind: 'ok', hostname: outcome.hostname };
    };
    const getDocument = async <T>(
        path: string,
        decode: (body: unknown) => T | null,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<DocumentOutcome<T>> => {
        const outcome = await withDeadline<DocumentAttempt<T>>(
            caller,
            async (signal) => {
                let response: Response;
                try {
                    response = await fetchImpl(path, {
                        method: 'GET',
                        credentials: 'omit',
                        redirect: 'error',
                        cache: 'no-store',
                        headers: headersFor(bearer, false),
                        signal,
                    });
                } catch {
                    return 'unavailable' as const;
                }
                try {
                    if (response.redirected) return 'unavailable';
                    if (
                        response.headers.get(PROXY_ERROR_HEADER) ===
                        UPSTREAM_MISMATCH
                    )
                        return 'blocked';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (response.status === 401 || response.status === 403)
                        return { rejected: response.status };
                    if (response.status !== 200) return 'unavailable';
                    const body = await readBoundedJson(
                        response,
                        CONFIG_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unavailable';
                    const document = decode(body.value);
                    return document === null ? 'unavailable' : { document };
                } finally {
                    discardBody(response);
                }
            },
        );
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unavailable' };
        if (outcome === 'unavailable') return { kind: 'unavailable' };
        if (outcome === 'unsupported') return { kind: 'unsupported' };
        if (outcome === 'blocked') return { kind: 'blocked' };
        if ('rejected' in outcome)
            return { kind: 'rejected', status: outcome.rejected };
        return { kind: 'ok', document: outcome.document };
    };
    const getConfigDocument = (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<ConfigDocumentOutcome> =>
        getDocument('/api/config', decodeConfigDocument, caller, bearer);
    const getVersion = (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<VersionOutcome> =>
        getDocument('/api/version', decodeVersionDocument, caller, bearer);
    // Toggle saves report status only; like legacy, the body is unread.
    const postConfig = async (
        path: TogglePath,
        bodyJson: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome> => {
        const outcome = await withDeadline<
            | 'unavailable'
            | 'unsupported'
            | 'blocked'
            | { rejected: number }
            | { saved: true }
        >(caller, async (signal) => {
            let response: Response;
            try {
                response = await fetchImpl(path, {
                    method: 'POST',
                    credentials: 'omit',
                    redirect: 'error',
                    cache: 'no-store',
                    headers: headersFor(bearer, true),
                    body: bodyJson,
                    signal,
                });
            } catch {
                return 'unavailable' as const;
            }
            try {
                if (response.redirected) return 'unavailable';
                if (
                    response.headers.get(PROXY_ERROR_HEADER) ===
                    UPSTREAM_MISMATCH
                )
                    return 'blocked';
                if (response.status === 404 || response.status === 405)
                    return 'unsupported';
                if (response.status === 401 || response.status === 403)
                    return { rejected: response.status };
                if (response.status !== 200) return 'unavailable';
                return { saved: true };
            } finally {
                discardBody(response);
            }
        });
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unavailable' };
        if (outcome === 'unavailable') return { kind: 'unavailable' };
        if (outcome === 'unsupported') return { kind: 'unsupported' };
        if (outcome === 'blocked') return { kind: 'blocked' };
        if ('rejected' in outcome)
            return { kind: 'rejected', status: outcome.rejected };
        return { kind: 'ok' };
    };
    return {
        serverLabel: upstreamOrigin,
        async getStatus(signal) {
            if (signal.aborted) return 'cancelled';
            const controller = new AbortController();
            let interrupt: (result: ConnectionResult) => void = () => {};
            const interrupted = new Promise<ConnectionResult>((resolve) => {
                interrupt = resolve;
            });
            const cancel = () => {
                interrupt('cancelled');
                controller.abort();
            };
            signal.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => {
                interrupt('unavailable');
                controller.abort();
            }, 5_000);
            const probe = async (): Promise<ConnectionResult> => {
                try {
                    const response = await fetchImpl('/api/auth/v2/status', {
                        method: 'GET',
                        credentials: 'omit',
                        redirect: 'error',
                        headers: { Accept: 'application/json' },
                        signal: controller.signal,
                    });
                    if (response.redirected) return 'unavailable';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (response.status !== 200) return 'unavailable';
                    const body: unknown = await response.json();
                    if (
                        typeof body !== 'object' ||
                        body === null ||
                        !('enabled' in body) ||
                        !('authenticated' in body)
                    )
                        return 'unavailable';
                    if (
                        typeof body.enabled !== 'boolean' ||
                        typeof body.authenticated !== 'boolean'
                    )
                        return 'unavailable';
                    return body.enabled ? 'protected' : 'disabled';
                } catch {
                    return 'unavailable';
                }
            };
            try {
                return await Promise.race([interrupted, probe()]);
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                controller.abort();
            }
        },
        getAuthStatus,
        login,
        refresh,
        getConfigHostname,
        getConfigDocument,
        getVersion,
        postConfig,
    };
}
