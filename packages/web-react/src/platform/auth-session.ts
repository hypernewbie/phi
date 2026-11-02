import type { CredentialBundle } from '@phi/core';
import type { AuthMessageId } from '../copy/auth.ts';
import type {
    ConnectionService,
    LoginOutcome,
    RefreshOutcome,
} from './http.ts';
import type { ServerState } from './server-state.ts';

export type AuthPhase =
    | 'checking'
    | 'sign-in'
    | 'ready'
    | 'unsupported'
    | 'unavailable'
    | 'blocked';

export type AuthProtection = 'unknown' | 'enabled' | 'disabled';

export interface AuthView {
    phase: AuthPhase;
    protection: AuthProtection;
    serverLabel: string;
    hostname: string | null;
    stale: boolean;
    pending: boolean;
    canSignIn: boolean;
    message: AuthMessageId | null;
}

export type SignInOutcome =
    | 'accepted'
    | 'invalid-length'
    | 'wrong-password'
    | 'rate-limited'
    | 'rejected'
    | 'unconfirmed'
    | 'cancelled';

export interface AuthSession {
    view(): AuthView;
    start(onView: (view: AuthView) => void): () => void;
    signIn(password: string): Promise<SignInOutcome>;
    retry(): void;
    // Live in-memory bearer for authed platform clients. Read per request;
    // never cache: the session owns renewal and revocation.
    bearer(): string | null;
}

const LOGIN_COOLDOWN_DEFAULT_MS = 60_000;
const COOLDOWN_CHUNK_MS = 300_000;
const LOCK_WAIT_MS = 15_000;
const RENEW_LEAD_MAX_MS = 60_000;
const RECOVERY_BASE_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const RECOVERY_JITTER = 0.2;

export function createAuthSession(
    http: ConnectionService,
    servers: ServerState,
): AuthSession {
    let generation = 0;
    let token: string | null = null;
    let listener: ((view: AuthView) => void) | null = null;
    let phase: AuthPhase = 'checking';
    let protection: AuthProtection = 'unknown';
    let hostname: string | null = null;
    let stale = false;
    let message: AuthMessageId | null = null;
    let bindingBlocked = false;
    let storageNote = false;
    let controller: AbortController | null = null;
    let chainPending = false;
    let followUpPending = false;
    let loginInFlight: Promise<SignInOutcome> | null = null;
    let cooldownUntil = 0;
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
    let exhausted = false;
    let chainRefreshUsed = false;
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenStartMono: number | null = null;
    let tokenLifetimeMs = 0;
    let passwordRef: string | null = null;
    let backoffIndex = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const now = () => globalThis.performance.now();
    const cooldownActive = () => now() < cooldownUntil;
    const emit = () => {
        if (listener === null) return;
        listener({
            phase,
            protection,
            serverLabel: http.serverLabel,
            hostname,
            stale,
            pending: chainPending || followUpPending || loginInFlight !== null,
            canSignIn:
                phase === 'sign-in' &&
                protection === 'enabled' &&
                !bindingBlocked &&
                loginInFlight === null &&
                !cooldownActive(),
            message,
        });
    };
    const clearCooldownTimer = () => {
        if (cooldownTimer !== null) {
            clearTimeout(cooldownTimer);
            cooldownTimer = null;
        }
    };
    const armCooldownExpiry = () => {
        clearCooldownTimer();
        if (!Number.isFinite(cooldownUntil)) return;
        const remaining = cooldownUntil - now();
        if (remaining <= 0) return;
        cooldownTimer = setTimeout(
            () => {
                cooldownTimer = null;
                if (cooldownActive()) armCooldownExpiry();
                else emit();
            },
            Math.min(remaining, COOLDOWN_CHUNK_MS),
        );
    };
    const clearToken = () => {
        token = null;
        tokenStartMono = null;
        tokenLifetimeMs = 0;
        if (renewalTimer !== null) {
            clearTimeout(renewalTimer);
            renewalTimer = null;
        }
    };
    const tokenExpired = (): boolean =>
        token !== null &&
        tokenStartMono !== null &&
        now() > tokenStartMono + tokenLifetimeMs;
    const supersede = () => {
        generation += 1;
        controller?.abort();
        controller = null;
    };
    const clearRecoveryTimer = () => {
        if (recoveryTimer !== null) {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
        }
    };
    // One recovery timer. A server wait replaces the backoff delay for that
    // step; an infinite wait pauses automatic work instead of shortening it.
    const scheduleRecovery = (serverWaitMs?: number | null) => {
        if (listener === null || recoveryTimer !== null) return;
        if (serverWaitMs === undefined || serverWaitMs === null) {
            const base =
                RECOVERY_BASE_MS[
                    Math.min(backoffIndex, RECOVERY_BASE_MS.length - 1)
                ];
            backoffIndex += 1;
            recoveryTimer = setTimeout(
                onRecovery,
                base * (1 + Math.random() * RECOVERY_JITTER),
            );
            return;
        }
        if (!Number.isFinite(serverWaitMs)) return;
        backoffIndex += 1;
        recoveryTimer = setTimeout(onRecovery, Math.max(0, serverWaitMs));
    };
    const onRecovery = () => {
        recoveryTimer = null;
        if (listener === null) return;
        // In-flight work owns the outcome; it schedules again on failure
        // and resets the backoff only after a completed fresh read.
        if (loginInFlight !== null || chainPending || followUpPending) return;
        void runChain().catch(() => {});
    };

    // Terminal states clear the memory token and stop automatic work.
    const enterBlocked = () => {
        clearToken();
        clearRecoveryTimer();
        chainPending = false;
        followUpPending = false;
        phase = 'blocked';
        protection = 'unknown';
        bindingBlocked = false;
        message = null;
    };
    const enterUnsupported = () => {
        clearToken();
        clearRecoveryTimer();
        chainPending = false;
        followUpPending = false;
        phase = 'unsupported';
        protection = 'unknown';
        bindingBlocked = false;
        message = null;
    };
    // Before acceptance, failures keep the same Login screen mounted.
    const enterStatusUnknown = () => {
        if (phase === 'sign-in') {
            protection = 'unknown';
            message = 'status-unavailable';
        } else if (phase !== 'ready') {
            phase = 'unavailable';
            protection = 'unknown';
            message = 'status-unavailable';
        } else {
            stale = true;
            message = 'read-stale';
        }
    };

    interface LockCall<T> {
        startMono: number;
        value: T;
    }
    type LockResult<T> = LockCall<T> | 'timeout' | 'cancelled';
    interface LockManagerLike {
        request<T>(
            name: string,
            options: { signal: AbortSignal },
            callback: () => Promise<T>,
        ): Promise<T>;
    }
    const locksOf = (): LockManagerLike | null => {
        const locks = (
            globalThis as {
                navigator?: { locks?: LockManagerLike };
            }
        ).navigator?.locks;
        return typeof locks?.request === 'function' ? locks : null;
    };
    // Serializes one bundle exchange across tabs. The 15-second wait
    // bound covers acquisition only; the HTTP attempt keeps its own
    // deadline. Missing APIs and pre-entry rejections fall back to the
    // page's single flight once. A wait timeout never bypasses the lock,
    // and an entered-callback failure never reruns.
    const withAuthLock = async <T>(
        current: number,
        signal: AbortSignal,
        work: () => Promise<LockCall<T>>,
    ): Promise<LockResult<T>> => {
        const locks = locksOf();
        if (locks === null) {
            if (current !== generation || signal.aborted) return 'cancelled';
            return work();
        }
        const acquire = new AbortController();
        const release = () => acquire.abort();
        signal.addEventListener('abort', release, { once: true });
        let callbackStarted = false;
        let timedOut = false;
        const waitTimer = setTimeout(() => {
            timedOut = true;
            acquire.abort();
        }, LOCK_WAIT_MS);
        try {
            return await locks.request<LockCall<T> | 'cancelled'>(
                `phi.react.auth:${servers.upstream}`,
                { signal: acquire.signal },
                async () => {
                    clearTimeout(waitTimer);
                    callbackStarted = true;
                    if (
                        current !== generation ||
                        signal.aborted ||
                        acquire.signal.aborted
                    )
                        return 'cancelled';
                    return work();
                },
            );
        } catch (error) {
            if (callbackStarted) throw error;
            if (timedOut) return 'timeout';
            if (current !== generation || signal.aborted) return 'cancelled';
            return work();
        } finally {
            clearTimeout(waitTimer);
            signal.removeEventListener('abort', release);
        }
    };

    type RefreshAttempt =
        | { kind: 'accepted'; bundle: CredentialBundle; startMono: number }
        | { kind: 'rejected-401' }
        | { kind: 'transient' }
        | { kind: 'terminal' }
        | { kind: 'cancelled' };

    const bindingAllowsRefresh = (): boolean => {
        const binding = servers.readBinding();
        return binding.status === 'ok' && binding.origin === servers.upstream;
    };
    const refreshAllowed = (): boolean =>
        !chainRefreshUsed && !exhausted && bindingAllowsRefresh();

    const attemptRefresh = async (
        current: number,
        signal: AbortSignal,
    ): Promise<RefreshAttempt> => {
        chainRefreshUsed = true;
        const attempt = await withAuthLock(current, signal, async () => {
            const startMono = now();
            return { startMono, value: await http.refresh(signal) };
        });
        if (attempt === 'timeout') {
            scheduleRecovery();
            return { kind: 'transient' };
        }
        if (attempt === 'cancelled') return { kind: 'cancelled' };
        if (current !== generation) return { kind: 'cancelled' };
        const outcome = attempt.value;
        if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
        if (outcome.kind === 'blocked') {
            enterBlocked();
            emit();
            return { kind: 'terminal' };
        }
        if (outcome.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return { kind: 'terminal' };
        }
        if (outcome.kind === 'rejected') {
            if (outcome.status === 401) return { kind: 'rejected-401' };
            scheduleRecovery(outcome.retryAfterMs ?? undefined);
            return { kind: 'transient' };
        }
        if (outcome.kind === 'unconfirmed') {
            scheduleRecovery();
            return { kind: 'transient' };
        }
        return {
            kind: 'accepted',
            bundle: outcome.bundle,
            startMono: attempt.startMono,
        };
    };

    const installBundle = (bundle: CredentialBundle, startMono: number) => {
        token = bundle.token;
        tokenStartMono = startMono;
        tokenLifetimeMs = bundle.expiresIn * 1000;
        phase = 'ready';
        protection = 'enabled';
        bindingBlocked = false;
        if (renewalTimer !== null) {
            clearTimeout(renewalTimer);
            renewalTimer = null;
        }
        // Renew at lifetime minus min(60s, lifetime/2), anchored to the
        // monotonic request start. An already-aged bundle arms nothing:
        // explicit triggers drive instead of an immediate retry loop.
        const lead = Math.min(RENEW_LEAD_MAX_MS, tokenLifetimeMs / 2);
        const delay = startMono + tokenLifetimeMs - lead - now();
        if (delay > 0) renewalTimer = setTimeout(onRenewal, delay);
    };

    const refreshRejected401 = async (
        current: number,
        signal: AbortSignal,
    ): Promise<void> => {
        clearToken();
        exhausted = true;
        stale = hostname !== null;
        const recheck = await http.getAuthStatus(signal);
        if (current !== generation) return;
        if (recheck.kind === 'cancelled') return;
        if (recheck.kind === 'blocked') {
            enterBlocked();
            emit();
            return;
        }
        if (recheck.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return;
        }
        if (
            recheck.kind === 'ok' &&
            recheck.status.owned &&
            !recheck.status.enabled
        ) {
            protection = 'disabled';
            await readUncredentialedHostname(current, signal);
            return;
        }
        if (
            recheck.kind === 'ok' &&
            recheck.status.owned &&
            recheck.status.enabled
        ) {
            phase = 'sign-in';
            protection = 'enabled';
            bindingBlocked = false;
            message = null;
            emit();
            return;
        }
        if (phase === 'sign-in') {
            protection = 'unknown';
            message = 'status-unavailable';
        } else {
            phase = 'unavailable';
            protection = 'unknown';
            message = 'status-unavailable';
        }
        if (recheck.kind === 'unavailable') scheduleRecovery();
        emit();
    };

    const followRefresh = async (
        current: number,
        signal: AbortSignal,
        onAccepted: () => Promise<void>,
        onTransient: () => void,
        guard?: () => boolean,
    ): Promise<void> => {
        const refreshed = await attemptRefresh(current, signal);
        if (current !== generation || (guard !== undefined && !guard())) return;
        if (refreshed.kind === 'accepted') {
            installBundle(refreshed.bundle, refreshed.startMono);
            await onAccepted();
            return;
        }
        if (refreshed.kind === 'rejected-401') {
            await refreshRejected401(current, signal);
            return;
        }
        if (refreshed.kind === 'terminal' || refreshed.kind === 'cancelled')
            return;
        onTransient();
    };

    const onRenewal = (): void => {
        renewalTimer = null;
        if (listener === null || token === null || exhausted) return;
        if (loginInFlight !== null || chainPending || followUpPending) return;
        void runRenewalChain().catch(() => {});
    };

    const runRenewalChain = async (): Promise<void> => {
        supersede();
        const current = generation;
        const own = new AbortController();
        controller = own;
        const { signal } = own;
        chainPending = true;
        chainRefreshUsed = false;
        emit();
        try {
            await followRefresh(
                current,
                signal,
                () => verifyBearer(current, signal),
                () => {
                    if (token !== null) {
                        stale = true;
                        message = 'read-stale';
                    }
                    emit();
                },
            );
        } finally {
            if (current === generation) {
                chainPending = false;
                if (controller === own) controller = null;
                emit();
            }
        }
    };

    const onResync = (): void => {
        if (listener === null || token === null || cooldownActive()) return;
        if (loginInFlight !== null || chainPending || followUpPending) return;
        void runChain().catch(() => {});
    };
    const onVisible = (): void => {
        const state = (
            globalThis as {
                document?: { visibilityState?: unknown };
            }
        ).document?.visibilityState;
        if (typeof state === 'string' && state !== 'visible') return;
        onResync();
    };

    const readCredentialedHostname = async (
        current: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const sent = token;
        if (sent === null) return;
        const config = await http.getConfigHostname(signal, sent);
        if (current !== generation || token !== sent) return;
        if (config.kind === 'cancelled') return;
        if (config.kind === 'blocked') {
            enterBlocked();
            emit();
            return;
        }
        if (config.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return;
        }
        if (config.kind === 'rejected') {
            // 401 invalidates only the sent generation; 403 is a route
            // error that retains the token and cached data.
            if (config.status === 401) {
                if (refreshAllowed()) {
                    await followRefresh(
                        current,
                        signal,
                        () => readCredentialedHostname(current, signal),
                        () => {
                            stale = true;
                            message = 'read-stale';
                            emit();
                        },
                        () => token === sent,
                    );
                    return;
                }
                clearToken();
                phase = 'sign-in';
                protection = 'enabled';
                bindingBlocked = false;
                message = null;
            } else {
                stale = true;
                message = 'read-stale';
            }
            emit();
            return;
        }
        if (config.kind === 'unavailable') {
            stale = true;
            message = 'read-stale';
            scheduleRecovery();
            emit();
            return;
        }
        servers.writeHostname(config.hostname);
        hostname = config.hostname;
        stale = false;
        backoffIndex = 0;
        message = storageNote ? 'persistence-note' : null;
        emit();
    };

    const readUncredentialedHostname = async (
        current: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const config = await http.getConfigHostname(signal);
        if (current !== generation) return;
        if (config.kind === 'cancelled') return;
        if (config.kind === 'blocked') {
            enterBlocked();
            emit();
            return;
        }
        if (config.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return;
        }
        if (config.kind === 'rejected' && config.status === 401) {
            // An uncredentialed 401 after a disabled status rechecks
            // public status once instead of inferring the auth mode.
            const recheck = await http.getAuthStatus(signal);
            if (current !== generation) return;
            if (recheck.kind === 'cancelled') return;
            if (recheck.kind === 'blocked') {
                enterBlocked();
                emit();
                return;
            }
            if (recheck.kind === 'unsupported') {
                enterUnsupported();
                emit();
                return;
            }
            if (
                recheck.kind === 'ok' &&
                recheck.status.owned &&
                recheck.status.enabled
            ) {
                phase = 'sign-in';
                protection = 'enabled';
                bindingBlocked = false;
                message = null;
                emit();
                return;
            }
            enterStatusUnknown();
            emit();
            return;
        }
        if (config.kind === 'rejected' || config.kind === 'unavailable') {
            if (hostname !== null) {
                stale = true;
                message = 'read-stale';
            } else {
                enterStatusUnknown();
            }
            if (config.kind === 'unavailable') scheduleRecovery();
            emit();
            return;
        }
        servers.writeHostname(config.hostname);
        hostname = config.hostname;
        stale = false;
        backoffIndex = 0;
        phase = 'ready';
        protection = 'disabled';
        message = null;
        emit();
    };

    const verifyBearer = async (
        current: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const sent = token;
        if (sent === null) return;
        const status = await http.getAuthStatus(signal, sent);
        if (current !== generation || token !== sent) return;
        if (status.kind === 'cancelled') return;
        if (status.kind === 'blocked') {
            enterBlocked();
            emit();
            return;
        }
        if (status.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return;
        }
        if (status.kind === 'unavailable') {
            enterStatusUnknown();
            scheduleRecovery();
            emit();
            return;
        }
        if (!status.status.authenticated || !status.status.enabled) {
            if (refreshAllowed()) {
                await followRefresh(
                    current,
                    signal,
                    () => verifyBearer(current, signal),
                    () => {
                        stale = true;
                        message = 'read-stale';
                        emit();
                    },
                    () => token === sent,
                );
                return;
            }
            clearToken();
            bindingBlocked = false;
            if (status.status.owned && !status.status.enabled) {
                phase = 'sign-in';
                protection = 'disabled';
                message = null;
                await readUncredentialedHostname(current, signal);
                return;
            }
            if (!status.status.owned) {
                phase = 'sign-in';
                enterStatusUnknown();
                emit();
                return;
            }
            phase = 'sign-in';
            protection = 'enabled';
            message = null;
            emit();
            return;
        }
        await readCredentialedHostname(current, signal);
    };

    const runChain = async (): Promise<void> => {
        supersede();
        const current = generation;
        const own = new AbortController();
        controller = own;
        const { signal } = own;
        chainPending = true;
        chainRefreshUsed = false;
        if (phase !== 'ready' && phase !== 'sign-in') {
            phase = 'checking';
            message = null;
        }
        emit();
        try {
            const status = await http.getAuthStatus(signal);
            if (current !== generation) return;
            if (status.kind === 'cancelled') return;
            if (status.kind === 'blocked') {
                enterBlocked();
                emit();
                return;
            }
            if (status.kind === 'unsupported') {
                enterUnsupported();
                emit();
                return;
            }
            if (status.kind === 'unavailable' || !status.status.owned) {
                if (token !== null && phase === 'ready') {
                    stale = true;
                    message = 'read-stale';
                } else {
                    clearToken();
                    enterStatusUnknown();
                }
                if (status.kind === 'unavailable') scheduleRecovery();
                emit();
                return;
            }
            if (!status.status.enabled) {
                clearToken();
                protection = 'disabled';
                await readUncredentialedHostname(current, signal);
                return;
            }
            const binding = servers.readBinding();
            if (
                binding.status === 'ok' &&
                binding.origin !== servers.upstream
            ) {
                clearToken();
                bindingBlocked = true;
                phase = 'sign-in';
                protection = 'enabled';
                message = 'separate-profile';
                emit();
                return;
            }
            if (binding.status === 'denied') {
                bindingBlocked = false;
                if (token !== null) {
                    await verifyBearer(current, signal);
                    return;
                }
                phase = 'sign-in';
                protection = 'enabled';
                message = 'persistence-note';
                emit();
                return;
            }
            bindingBlocked = false;
            if (token !== null && !tokenExpired()) {
                await verifyBearer(current, signal);
                return;
            }
            if (bindingAllowsRefresh() && !exhausted) {
                await followRefresh(
                    current,
                    signal,
                    () => verifyBearer(current, signal),
                    () => {
                        phase = 'sign-in';
                        protection = 'enabled';
                        bindingBlocked = false;
                        message = null;
                        emit();
                    },
                );
                return;
            }
            if (token !== null) clearToken();
            phase = 'sign-in';
            protection = 'enabled';
            message = null;
            emit();
        } finally {
            if (current === generation) {
                chainPending = false;
                if (controller === own) controller = null;
                emit();
            }
        }
    };

    const runLogin = async (
        current: number,
        signal: AbortSignal,
    ): Promise<SignInOutcome> => {
        // A queued lock callback reads the cancellable reference instead
        // of capturing another copy. Release it after completion.
        const cancelledLogin: LoginOutcome = { kind: 'cancelled' };
        let attempt: LockResult<LoginOutcome>;
        try {
            attempt = await withAuthLock(current, signal, async () => {
                const held = passwordRef;
                if (held === null)
                    return { startMono: now(), value: cancelledLogin };
                const startMono = now();
                return {
                    startMono,
                    value: await http.login(held, signal),
                };
            });
        } finally {
            passwordRef = null;
        }
        if (attempt === 'timeout') return 'unconfirmed';
        if (attempt === 'cancelled') return 'cancelled';
        const { startMono, value: outcome } = attempt;
        if (current !== generation) return 'cancelled';
        if (outcome.kind === 'cancelled') return 'cancelled';
        if (outcome.kind === 'blocked') {
            enterBlocked();
            emit();
            return 'cancelled';
        }
        if (outcome.kind === 'unsupported') {
            enterUnsupported();
            emit();
            return 'cancelled';
        }
        if (outcome.kind === 'invalid-length') return 'invalid-length';
        if (outcome.kind === 'unconfirmed') return 'unconfirmed';
        if (outcome.kind === 'rejected') {
            if (outcome.status === 401) {
                const recheck = await http.getAuthStatus(signal);
                if (current !== generation) return 'cancelled';
                if (recheck.kind === 'cancelled') return 'cancelled';
                if (recheck.kind === 'blocked') {
                    enterBlocked();
                    emit();
                    return 'cancelled';
                }
                if (recheck.kind === 'unsupported') {
                    enterUnsupported();
                    emit();
                    return 'cancelled';
                }
                if (
                    recheck.kind === 'ok' &&
                    recheck.status.owned &&
                    recheck.status.enabled
                )
                    return 'wrong-password';
                if (
                    recheck.kind === 'ok' &&
                    recheck.status.owned &&
                    !recheck.status.enabled
                ) {
                    clearToken();
                    protection = 'disabled';
                    await readUncredentialedHostname(current, signal);
                    return 'rejected';
                }
                clearToken();
                enterStatusUnknown();
                emit();
                return 'unconfirmed';
            }
            // A 503 that names a wait cools down like a rate limit; a bare
            // 503 stays a plain rejection. Login never retries itself.
            if (
                outcome.status === 429 ||
                (outcome.status === 503 && outcome.retryAfterMs != null)
            ) {
                const wait = outcome.retryAfterMs ?? LOGIN_COOLDOWN_DEFAULT_MS;
                cooldownUntil = Number.isFinite(wait)
                    ? now() + Math.max(0, wait)
                    : Number.POSITIVE_INFINITY;
                armCooldownExpiry();
                emit();
                return 'rate-limited';
            }
            if (outcome.status === 500) {
                message = 'unlock-failed';
                emit();
            }
            return 'rejected';
        }
        installBundle(outcome.bundle, startMono);
        exhausted = false;
        storageNote = !servers.writeBinding(servers.upstream);
        stale = true;
        followUpPending = true;
        message = null;
        emit();
        // Follow-up reads never resubmit the password.
        void verifyBearer(current, signal)
            .catch(() => {})
            .finally(() => {
                if (current === generation) {
                    followUpPending = false;
                    emit();
                }
            });
        return 'accepted';
    };

    const onStorage = () => {
        // A binding or cache change from another tab supersedes
        // pending work; the chain rechecks identity before requesting.
        if (listener === null) return;
        void runChain().catch(() => {});
    };

    return {
        view: () => ({
            phase,
            protection,
            serverLabel: http.serverLabel,
            hostname,
            stale,
            pending: chainPending || followUpPending || loginInFlight !== null,
            canSignIn:
                phase === 'sign-in' &&
                protection === 'enabled' &&
                !bindingBlocked &&
                loginInFlight === null &&
                !cooldownActive(),
            message,
        }),
        start: (onView) => {
            listener = onView;
            hostname = servers.readHostname();
            stale = hostname !== null;
            phase = 'checking';
            protection = 'unknown';
            message = null;
            chainPending = true;
            emit();
            const target = globalThis as {
                addEventListener?: (type: string, handler: () => void) => void;
                removeEventListener?: (
                    type: string,
                    handler: () => void,
                ) => void;
            };
            target.addEventListener?.('storage', onStorage);
            target.addEventListener?.('online', onResync);
            // visibilitychange fires on the document, not the window.
            const documentTarget = (
                globalThis as {
                    document?: Pick<
                        Document,
                        'addEventListener' | 'removeEventListener'
                    >;
                }
            ).document;
            documentTarget?.addEventListener('visibilitychange', onVisible);
            void runChain().catch(() => {});
            return () => {
                target.removeEventListener?.('storage', onStorage);
                target.removeEventListener?.('online', onResync);
                documentTarget?.removeEventListener(
                    'visibilitychange',
                    onVisible,
                );
                listener = null;
                supersede();
                passwordRef = null;
                clearRecoveryTimer();
                clearCooldownTimer();
                cooldownUntil = 0;
                chainPending = false;
                followUpPending = false;
                loginInFlight = null;
                clearToken();
            };
        },
        signIn: (password) => {
            if (loginInFlight !== null) return loginInFlight;
            if (
                phase !== 'sign-in' ||
                protection !== 'enabled' ||
                bindingBlocked
            )
                return Promise.resolve('cancelled');
            if (cooldownActive()) return Promise.resolve('rate-limited');
            supersede();
            chainRefreshUsed = false;
            const current = generation;
            const own = new AbortController();
            controller = own;
            passwordRef = password;
            loginInFlight = runLogin(current, own.signal)
                .then(
                    (outcome) => outcome,
                    () => 'unconfirmed' as const,
                )
                .finally(() => {
                    if (controller === own) controller = null;
                    loginInFlight = null;
                    emit();
                });
            emit();
            return loginInFlight;
        },
        retry: () => {
            if (
                listener === null ||
                loginInFlight !== null ||
                chainPending ||
                followUpPending
            )
                return;
            // Retry joins the recovery chain now instead of waiting out
            // the scheduled backoff.
            clearRecoveryTimer();
            void runChain().catch(() => {});
        },
        bearer: () => token,
    };
}
