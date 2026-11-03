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

export type SetPasswordOutcome =
    | { kind: 'ok'; bundle: CredentialBundle }
    | { kind: 'invalid-length' }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };

export type ClearPasswordOutcome =
    | { kind: 'ok' }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };

export type MobileReadOutcome =
    | { kind: 'ok'; state: MobileAppearance }
    | { kind: 'rejected'; status: number }
    | { kind: 'unavailable' }
    | { kind: 'unsupported' }
    | { kind: 'cancelled' };

export type MobileSaveOutcome =
    | { kind: 'saved'; state: MobileAppearance }
    | { kind: 'conflict'; state: MobileAppearance }
    | { kind: 'rejected'; status: number }
    | { kind: 'unknown' }
    | { kind: 'cancelled' };

export type MobileFenceOutcome =
    | { kind: 'saved'; state: MobileAppearance }
    | { kind: 'rejected'; status: number }
    | { kind: 'unknown' }
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
    setPassword(
        password: string,
        signal: AbortSignal,
        bearer?: string,
    ): Promise<SetPasswordOutcome>;
    clearPassword(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<ClearPasswordOutcome>;
    getConfigHostname(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<ConfigOutcome>;
    getConfigDocument(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<ConfigDocumentOutcome>;
    getVersion(signal: AbortSignal, bearer?: string): Promise<VersionOutcome>;
    getMobileAppearance(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<MobileReadOutcome>;
    postMobileAppearance(
        bodyJson: string,
        signal: AbortSignal,
        bearer?: string,
    ): Promise<MobileSaveOutcome>;
    postMobileFence(
        signal: AbortSignal,
        bearer?: string,
    ): Promise<MobileFenceOutcome>;
    postConfig(
        path: TogglePath,
        bodyJson: string,
        signal: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome>;
    postAppearance(
        bodyJson: string,
        signal: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome>;
    postTheme(
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
const MOBILE_DEFINITIVE = new Set([400, 401, 403, 404, 405, 413, 415]);
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
    themeColor: z.string().catch(''),
    uiFontFamily: z.string().catch(''),
    uiFontSize: z.number().int().min(0).catch(0),
    terminalFontFamily: z.string().catch(''),
    terminalFontSize: z.number().int().min(0).catch(0),
    mobileScrollbackRows: z.number().int().min(0).catch(0),
    hostnameOverride: z.string().catch(''),
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
    theme_color: z.string().catch(''),
    ui_font_family: z.string().catch(''),
    ui_font_size: z.number().int().min(0).catch(0),
    terminal_font_family: z.string().catch(''),
    terminal_font_size: z.number().int().min(0).catch(0),
    mobile_scrollback_rows: z.number().int().min(0).catch(0),
    hostname_override: z.string().catch(''),
});

const mobileFamilyField = z
    .string()
    .refine(
        (value) => new TextEncoder().encode(value).length <= 512,
        'family too long',
    )
    .refine((value) => !/\p{Cc}/u.test(value), 'family has controls');

const mobileAppearanceSchema = z
    .object({
        revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        ui_font_size: z.number().int().min(10).max(24).nullable(),
        terminal_font_size: z.number().int().min(8).max(32).nullable(),
        ui_font_family: mobileFamilyField.nullable(),
        terminal_font_family: mobileFamilyField.nullable(),
    })
    .strict();

export type MobileAppearance = z.infer<typeof mobileAppearanceSchema>;

export interface InheritedFamilies {
    readonly ui_font_family: string;
    readonly terminal_font_family: string;
}

const inheritedFamiliesSchema = z.object({
    ui_font_family: mobileFamilyField,
    terminal_font_family: mobileFamilyField,
});

export function decodeInheritedFamilies(
    body: unknown,
): InheritedFamilies | null {
    const parsed = inheritedFamiliesSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
}

function decodeMobileAppearance(body: unknown): MobileAppearance | null {
    const parsed = mobileAppearanceSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
}

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
        themeColor: wire.theme_color,
        uiFontFamily: wire.ui_font_family,
        uiFontSize: wire.ui_font_size,
        terminalFontFamily: wire.terminal_font_family,
        terminalFontSize: wire.terminal_font_size,
        mobileScrollbackRows: wire.mobile_scrollback_rows,
        hostnameOverride: wire.hostname_override,
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
    // One-shot password set/clear. Same timeout/body/redirect discipline
    // as login, plus a bearer. credentials stay same-origin (not omit):
    // the rotation response rotates the refresh cookie, and an omitted
    // fetch would drop it, logging the user out on the next reload.
    const postPassword = async (
        bodyJson: string,
        caller: AbortSignal,
        bearer: string | undefined,
        expectEnabled: boolean,
    ): Promise<
        | { kind: 'ok'; bundle: CredentialBundle | null }
        | { kind: 'rejected'; status: number }
        | { kind: 'unavailable' }
        | { kind: 'cancelled' }
    > => {
        type PasswordAttempt =
            | { bundle: CredentialBundle | null }
            | { rejected: number }
            | 'unavailable';
        const outcome = await withDeadline<PasswordAttempt>(
            caller,
            async (signal) => {
                let response: Response;
                try {
                    response = await fetchImpl('/api/auth/v2/password', {
                        method: 'POST',
                        credentials: 'same-origin',
                        redirect: 'error',
                        cache: 'no-store',
                        headers: headersFor(bearer, true),
                        body: bodyJson,
                        signal,
                    });
                } catch {
                    return 'unavailable';
                }
                try {
                    if (response.redirected) return 'unavailable';
                    if (
                        response.headers.get(PROXY_ERROR_HEADER) ===
                        UPSTREAM_MISMATCH
                    )
                        return 'unavailable';
                    if (
                        response.status === 400 ||
                        response.status === 401 ||
                        response.status === 403 ||
                        response.status === 429 ||
                        response.status === 500 ||
                        response.status === 503
                    )
                        return { rejected: response.status };
                    if (response.status !== 200) return 'unavailable';
                    const body = await readBoundedJson(
                        response,
                        AUTH_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unavailable';
                    const payload = body.value as Record<string, unknown>;
                    if (
                        typeof payload !== 'object' ||
                        payload === null ||
                        Array.isArray(payload) ||
                        payload.enabled !== expectEnabled
                    )
                        return 'unavailable';
                    const bundle = decodeBundle(body.value);
                    // Set rotates the credential: no bundle, no success.
                    // Clear carries no bundle; the flag is the proof.
                    if (expectEnabled && bundle === null) return 'unavailable';
                    return { bundle };
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
        if ('rejected' in outcome)
            return { kind: 'rejected', status: outcome.rejected };
        return { kind: 'ok', bundle: outcome.bundle };
    };
    const setPassword = async (
        password: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<SetPasswordOutcome> => {
        const bytes = passwordByteLength(password);
        if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES)
            return { kind: 'invalid-length' };
        const outcome = await postPassword(
            JSON.stringify({ password }),
            caller,
            bearer,
            true,
        );
        if (outcome.kind === 'ok') {
            if (outcome.bundle === null) return { kind: 'unavailable' };
            return { kind: 'ok', bundle: outcome.bundle };
        }
        return outcome;
    };
    const clearPassword = async (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<ClearPasswordOutcome> => {
        const outcome = await postPassword(
            JSON.stringify({ password: '' }),
            caller,
            bearer,
            false,
        );
        if (outcome.kind === 'ok') return { kind: 'ok' };
        return outcome;
    };
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
    const getMobileAppearance = async (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<MobileReadOutcome> => {
        const outcome = await getDocument(
            '/api/config/mobile-appearance',
            decodeMobileAppearance,
            caller,
            bearer,
        );
        if (outcome.kind === 'ok')
            return { kind: 'ok', state: outcome.document };
        if (outcome.kind === 'blocked') return { kind: 'unavailable' };
        return outcome;
    };
    // Mobile saves distinguish definitive rejections from unknown
    // outcomes (web/mobile-appearance.js send): anything outside the
    // definitive list, including 5xx and malformed 200 bodies, means
    // the write may have applied and must be fenced, never retried.
    const postMobile = async (
        path:
            | '/api/config/mobile-appearance'
            | '/api/config/mobile-appearance/fence',
        bodyJson: string,
        caller: AbortSignal,
        bearer: string | undefined,
        acceptConflict: boolean,
    ): Promise<MobileSaveOutcome> => {
        type Attempt =
            | { saved: MobileAppearance }
            | { conflict: MobileAppearance }
            | { rejected: number }
            | 'unknown';
        const outcome = await withDeadline<Attempt>(caller, async (signal) => {
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
                return 'unknown';
            }
            try {
                if (response.redirected) return 'unknown';
                if (
                    response.headers.get(PROXY_ERROR_HEADER) ===
                    UPSTREAM_MISMATCH
                )
                    return 'unknown';
                if (
                    response.status === 200 ||
                    (response.status === 409 && acceptConflict)
                ) {
                    const body = await readBoundedJson(
                        response,
                        AUTH_BODY_LIMIT,
                    );
                    if (!body.ok) return 'unknown';
                    const state = decodeMobileAppearance(body.value);
                    if (state === null) return 'unknown';
                    return response.status === 200
                        ? { saved: state }
                        : { conflict: state };
                }
                if (MOBILE_DEFINITIVE.has(response.status))
                    return { rejected: response.status };
                return 'unknown';
            } finally {
                discardBody(response);
            }
        });
        if (outcome === 'cancelled' || outcome === 'expired')
            return outcome === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'unknown' };
        if (outcome === 'unknown') return { kind: 'unknown' };
        if ('rejected' in outcome)
            return { kind: 'rejected', status: outcome.rejected };
        if ('saved' in outcome) return { kind: 'saved', state: outcome.saved };
        return { kind: 'conflict', state: outcome.conflict };
    };
    const postMobileAppearance = (
        bodyJson: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<MobileSaveOutcome> =>
        postMobile(
            '/api/config/mobile-appearance',
            bodyJson,
            caller,
            bearer,
            true,
        );
    const postMobileFence = async (
        caller: AbortSignal,
        bearer?: string,
    ): Promise<MobileFenceOutcome> => {
        const outcome = await postMobile(
            '/api/config/mobile-appearance/fence',
            '{}',
            caller,
            bearer,
            false,
        );
        if (outcome.kind === 'conflict') return { kind: 'unknown' };
        return outcome;
    };
    // Config saves report status only; like legacy, the body is unread.
    const postStatus = async (
        path: string,
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
    const postConfig = (
        path: TogglePath,
        bodyJson: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome> => postStatus(path, bodyJson, caller, bearer);
    const postAppearance = (
        bodyJson: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome> =>
        postStatus('/api/config/appearance', bodyJson, caller, bearer);
    const postTheme = (
        bodyJson: string,
        caller: AbortSignal,
        bearer?: string,
    ): Promise<PostOutcome> =>
        postStatus('/api/config/theme', bodyJson, caller, bearer);
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
        setPassword,
        clearPassword,
        getConfigHostname,
        getConfigDocument,
        getVersion,
        getMobileAppearance,
        postMobileAppearance,
        postMobileFence,
        postConfig,
        postAppearance,
        postTheme,
    };
}
