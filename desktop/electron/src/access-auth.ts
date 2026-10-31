/**
 * Access-auth bridge for the desktop's main view page.
 *
 * Pure TypeScript: this module never imports Electron, so vitest runs it
 * directly and the host loop (src/desktop.ts) is the only place it meets
 * the desktop surfaces. Mirrors the Wails trust model: the desktop never
 * receives the access password or stores it on disk; only the resulting
 * server-issued `phi_access_session` cookie is kept (per-origin,
 * process-lifetime, in-memory).
 *
 * Scope:
 *   - `fetchConfig(origin)`: discriminated `ok | unauthorized | unavailable`
 *     result for the active profile's `/api/config`. Honors a per-origin
 *     session cookie via the `Cookie` header (never `electron.session` —
 *     that jar is shared with body views and would silently authorize
 *     them, which violates the trust model).
 *   - `tryUnlock(origin, password)`: one-shot PBKDF2/HMAC handshake
 *     against `POST /api/auth/login`, captures the `phi_access_session`
 *     cookie (must be `HttpOnly`), and retries `/api/config` once.
 *   - `cancel(origin)`: drops the captured cookie for `origin`.
 *   - `hasCookie(origin)`: introspect whether a session cookie exists.
 *
 * Crypto parity with the browser's `web/auth.js` (Noble): the verifier is
 * `pbkdf2(sha256, password_utf8, salt_bytes, iterations, 32)`, the proof
 * is `hmac(sha256, verifier, challenge_utf8)` base64URL-encoded. Validated
 * at design time via a Node-vs-Noble Unicode vector (see
 * .pi-subagents/artifacts/phi_arc_auth_unbound_design.md).
 *
 * Status validation: before prompting, the module calls
 * `GET /api/auth/status` and accepts only `enabled: true` with a
 * valid positive-integer `iterations` (between 100000 and 2000000) and
 * a non-empty base64URL `salt`. That keeps a 401 from an unrelated
 * upstream (proxy, route) from triggering a password prompt the user
 * cannot satisfy.
 */
import { createHmac, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2) as (
  password: string,
  salt: Buffer,
  iterations: number,
  keylen: number,
  digest: string,
) => Promise<Buffer>;

/** Lazy fetch override (test seam). Production = native `fetch`. */
export type FetchLike = typeof fetch;

export interface ParsedSessionCookie {
  readonly cookieName: string;
  readonly cookieValue: string;
  readonly httpOnly: boolean;
  readonly path: string;
}

export interface CookieJarEntry extends ParsedSessionCookie {
  readonly origin: string;
}

/** Discriminated outcome of `fetchConfig` — never throws on network failure. */
export type FetchConfigResult =
  | { kind: 'ok'; config: unknown }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; reason: string };

/** Discriminated outcome of `tryUnlock`. The renderer surfaces the message. */
export type UnlockResult =
  | { kind: 'ok'; config: unknown | null }
  | { kind: 'invalid-password'; message: string }
  | { kind: 'rate-limited'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'stale'; message: string };

/** Protocol the host last selected for an origin. Kept beside the token map
 *  so a rejected v2 token does not silently fall back to a v1 cookie. */
export type SelectedProtocol = 'v1' | 'v2';

/** Result of validating an installed v2 token through `/api/auth/v2/status`. */
export type TokenVerdict = 'valid' | 'invalid' | 'unavailable';

/** One server-issued v2 credential bundle. The access token is short-lived; the
 *  refresh handle above it is the host's alone — it never reaches a renderer,
 *  an IPC payload, or a page-visible object. The deadline fields are integer
 *  Unix seconds from the server, and `expiresIn` is the server-computed
 *  remaining seconds, which is what renewal schedules from: a host clock that
 *  is behind would otherwise renew late and serve 401s for the whole window. */
export interface V2Bundle {
  readonly token: string;
  readonly expiresAt: number;
  readonly expiresIn: number;
  readonly refreshHandle: string;
  readonly refreshIdleExpiresAt: number;
  readonly refreshAbsoluteExpiresAt: number;
}

/** Discriminated outcome of a host refresh. `unauthorized` is the only terminal
 *  result; every other failure keeps the bundle for a later retry. */
export type RefreshResult =
  | { kind: 'ok'; bundle: V2Bundle }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; reason: string; retryAfterMs?: number }
  | { kind: 'superseded' };

/** Discriminated outcome of a host logout. */
export type LogoutResult =
  | { kind: 'ok' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; reason: string };

/** Capability discovery from the legacy status route. `raw` is retained so
 *  the v1 path can validate KDF metadata only when it needs it. */
export type AuthDiscovery =
  | { kind: 'disabled'; protocols: string[] }
  | {
      kind: 'enabled';
      protocols: string[];
      authenticated: boolean;
      raw: Record<string, unknown>;
    }
  | { kind: 'unavailable'; message: string };

/** A persisted access credential: the verifier plus the server's
 *  trust settings captured at unlock time. Used by the host to
 *  re-authenticate on next launch (the verifier replaces the typed
 *  password; the salt+iterations are stored alongside so the host
 *  can detect a server-side credential rotation and fall back to
 *  prompting). Matches the browser's `web/auth.js` `storeCredential`
 *  payload byte-for-byte (version, algorithm, iterations, salt, verifier). */
export interface StoredCredential {
  readonly version: 'v1';
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly salt: Buffer;
  readonly verifier: Buffer;
}

export type CookieProvider = (
  origin: string,
) => Promise<CookieJarEntry | null> | CookieJarEntry | null;

export type CookieCapturedListener = (
  origin: string,
  cookie: CookieJarEntry,
) => void | Promise<void>;

/** Notified whenever a host-held v2 bundle appears, rotates, or is dropped, so
 *  the encrypted store can persist it before any renderer sees the credential.
 *  A null bundle means the origin no longer holds a refreshable credential. */
export type BundleListener = (origin: string, bundle: V2Bundle | null) => void;

/** A captured handshake fence, see `AccessAuth.captureAttempt`. */
export interface AuthAttempt {
  readonly origin: string;
  readonly isCurrent: () => boolean;
}

/** Strict bounds — server-controlled values that must be validated before
 *  handing them to the PBKDF2 primitive (mitigates remote-driven cost
 *  amplification and malformed-salt attacks). */
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 2_000_000;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 1024;
const FETCH_TIMEOUT_MS = 5_000;
const COOKIE_NAME = 'phi_access_session';
const AUTH_PATH_STATUS = '/api/auth/status';
const AUTH_PATH_LOGIN = '/api/auth/login';
const AUTH_PATH_V2_STATUS = '/api/auth/v2/status';
const AUTH_PATH_V2_LOGIN = '/api/auth/v2/login';
const AUTH_PATH_V2_REFRESH = '/api/auth/v2/refresh';
const AUTH_PATH_V2_LOGOUT = '/api/auth/v2/logout';
const REFRESH_COOKIE_NAME = 'phi_access_refresh';
const REFRESH_COOKIE_PATH = '/api/auth/v2/refresh';
const REFRESH_HANDLE_BYTES = 32;
const CSRF_HEADER = 'X-Phi-Auth';
const CSRF_VALUE = 'v2';
const CONFIG_PATH = '/api/config';
/** Renew this long before the access expiry. The token lives one hour, so the
 *  lead is small relative to its lifetime and absorbs a slow round trip. */
const RENEW_LEAD_S = 60;
const REFRESH_BACKOFF_BASE_MS = 1_000;
const REFRESH_BACKOFF_MAX_MS = 60_000;
const RETRY_AFTER_MAX_MS = 300_000;
/** A bundle is five short fields; anything larger is not one. Matches the
 *  embedded proxy's limit so both owners reject the same bodies. */
const MAX_BUNDLE_BYTES = 64 * 1024;

/**
 * Canonicalizes and validates an origin string for access-auth identity.
 * Validates protocol (http: or https: only), authority (non-empty hostname,
 * no userinfo), and returns standard WHATWG url.origin (lowercase hostname,
 * default ports stripped, no trailing slash).
 * Returns null if the origin is invalid or untrusted.
 */
export function toCanonicalAuthOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withTimeout(signal?: AbortSignal, ms = FETCH_TIMEOUT_MS): AbortSignal {
  const timeoutSig = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
}

/** Validated `/api/auth/status` shape — only returned when fully trusted. */
interface TrustedAuthStatus {
  readonly version: 'v1';
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly salt: Buffer;
  readonly challenge: string;
  readonly authenticated: boolean;
}

export class AccessAuth {
  private readonly cookies = new Map<string, CookieJarEntry>();
  /** Per-origin v2 bearer. Installed by a successful v2 login, a host refresh,
   *  or the host restoring its encrypted store. Never persisted here. */
  private readonly tokens = new Map<string, string>();
  /** Per-origin refresh bundle. Present only when the host holds a handle, so
   *  a host-installed token with no handle is never refreshed. */
  private readonly bundles = new Map<string, V2Bundle>();
  /** One in-flight refresh promise per canonical origin: a reload, a poll and a
   *  401-driven renewal must never consume the same handle twice. */
  private readonly refreshes = new Map<string, Promise<RefreshResult>>();
  /** Bounded retry state after a non-terminal refresh failure. */
  private readonly refreshBackoff = new Map<
    string,
    { attempts: number; until: number }
  >();
  /** Per-origin protocol choice. Presence is intentional: a rejected token
   *  clears the token but keeps `v2` selected, so no cookie fallback runs. */
  private readonly selectedProtocols = new Map<string, SelectedProtocol>();
  /** Per-origin verifier cache: the verifier is computed once per
   *  successful login and held until the host reads it (for disk
   *  persistence) or a new login overwrites it. Cleared on `cancel`
   *  so a stale verifier doesn't outlive its origin. */
  private readonly lastVerifier = new Map<string, Buffer>();
  private readonly lastCredential = new Map<
    string,
    { verifier: Buffer; salt: Buffer; iterations: number }
  >();
  private readonly attemptTokens = new Map<string, number>();
  /** Access deadline per origin on this machine's clock: the receipt time plus
   *  the server's own remaining duration. The server's absolute timestamp is
   *  never compared with a local wall clock, which may be skewed by hours. */
  private readonly deadlineAt = new Map<string, number>();
  private readonly _doFetch: FetchLike;
  private readonly _now: () => number;
  private _cookieProvider: CookieProvider | null = null;
  private _onCookieCaptured: CookieCapturedListener | null = null;
  private _onBundle: BundleListener | null = null;

  constructor(doFetch: FetchLike = fetch, now: () => number = Date.now) {
    this._doFetch = doFetch;
    this._now = now;
  }

  setCookieProvider(provider: CookieProvider | null): void {
    this._cookieProvider = provider;
  }

  setOnCookieCaptured(listener: CookieCapturedListener | null): void {
    this._onCookieCaptured = listener;
  }

  setBundleListener(listener: BundleListener | null): void {
    this._onBundle = listener;
  }

  /** Announces the bundle an origin now holds. A listener failure must never
   *  break authentication: persistence reports its own failure and the host
   *  keeps the credential in memory. */
  private announceBundle(canonical: string): void {
    if (!this._onBundle) return;
    try {
      this._onBundle(canonical, this.bundles.get(canonical) ?? null);
    } catch {
      /* persistence is the listener's problem, not the credential's */
    }
  }

  private async safeFetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this._doFetch(url, init);
    } catch (err) {
      if (url.hostname === 'localhost') {
        const fallback = new URL(url.toString());
        fallback.hostname = '127.0.0.1';
        try {
          return await this._doFetch(fallback, init);
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  /** Drops the captured cookie AND the cached verifier for `origin`.
   *  Used on rail switch away-from, profile removal, and quit — but
   *  cookies are intentionally NOT dropped on rail switch so a return
   *  trip doesn't re-prompt. */
  cancel(origin: string): void {
    const canonical = toCanonicalAuthOrigin(origin);
    if (canonical) {
      this.bumpAttempt(canonical);
      this.cookies.delete(canonical);
      this.cookies.delete(`${canonical}/`);
      this.lastVerifier.delete(canonical);
      this.lastVerifier.delete(`${canonical}/`);
      this.lastCredential.delete(canonical);
      this.lastCredential.delete(`${canonical}/`);
      this.tokens.delete(canonical);
      this.bundles.delete(canonical);
      this.refreshes.delete(canonical);
      this.refreshBackoff.delete(canonical);
      this.deadlineAt.delete(canonical);
      this.selectedProtocols.delete(canonical);
    }
    this.cookies.delete(origin);
    this.lastVerifier.delete(origin);
    this.lastCredential.delete(origin);
    this.tokens.delete(origin);
    this.bundles.delete(origin);
    this.refreshes.delete(origin);
    this.refreshBackoff.delete(origin);
    this.deadlineAt.delete(origin);
    this.selectedProtocols.delete(origin);
  }

  /** Installs a host-held v2 token. Memory-only: persistence belongs to the
   *  encrypted desktop store, never this module. Installation supersedes any
   *  auth handshake already in flight for that origin. */
  installToken(origin: string, token: string): boolean {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical || typeof token !== 'string' || token.length === 0) {
      return false;
    }
    this.tokens.set(canonical, token);
    // A bare token carries no refresh handle, so any older bundle describes a
    // different credential and must not be refreshed against this token.
    this.bundles.delete(canonical);
    this.deadlineAt.delete(canonical);
    this.selectedProtocols.set(canonical, 'v2');
    this.bumpAttempt(canonical);
    this.announceBundle(canonical);
    return true;
  }

  /** Installs a full v2 credential bundle: access token plus the host-only
   *  refresh handle and the server's deadlines. Returns false when the bundle
   *  is malformed, so a bad body can never displace a working credential.
   *
   *  `options.restored` marks a bundle read back from the encrypted store: its
   *  receipt-relative clock did not survive the restart, so renewal is due at
   *  once and the host authorizes from a fresh bundle before protected work. */
  installBundle(
    origin: string,
    bundle: V2Bundle,
    options: { restored?: boolean } = {},
  ): boolean {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical || !isValidBundle(bundle)) return false;
    this.tokens.set(canonical, bundle.token);
    this.bundles.set(canonical, bundle);
    this.selectedProtocols.set(canonical, 'v2');
    this.refreshBackoff.delete(canonical);
    // The deadline is measured from this receipt, not from the server's
    // absolute expiry read through a possibly-wrong local clock: a machine
    // whose clock runs ahead must not renew in a storm, and one that runs
    // behind must not miss a real expiry.
    this.deadlineAt.set(
      canonical,
      options.restored ? this._now() : this._now() + bundle.expiresIn * 1000,
    );
    this.bumpAttempt(canonical);
    // Persist before anyone can install this credential into a renderer.
    this.announceBundle(canonical);
    return true;
  }

  /** The bundle held for `origin`, or null. Host-only: the caller must never
   *  put this object (or its handle) into a renderer. */
  getBundle(origin: string): V2Bundle | null {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    return this.bundles.get(canonical) ?? null;
  }

  /** The bundle's access deadline on this machine's clock, in unix seconds, or
   *  null when no bundle with a usable duration is held. A credential consumer
   *  (the scoped asset cookie) uses this instead of the server's absolute
   *  timestamp, so a skewed local clock cannot expire it early or late. */
  getAccessDeadline(origin: string): number | null {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    const bundle = this.bundles.get(canonical);
    if (!bundle || bundle.expiresIn <= 0) return null;
    const deadline = this.deadlineAt.get(canonical);
    if (deadline === undefined) return null;
    return Math.floor(deadline / 1000);
  }

  /** Drops one rejected token while keeping the v2 selection. A delayed
   *  rejection for token A must not clear a newer token B. */
  rejectToken(origin: string, token: string): void {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return;
    if (this.tokens.get(canonical) === token) {
      this.tokens.delete(canonical);
      this.bundles.delete(canonical);
      this.deadlineAt.delete(canonical);
      this.announceBundle(canonical);
    }
    this.selectedProtocols.set(canonical, 'v2');
  }

  /** Returns the installed token for `origin`, if any. */
  getToken(origin: string): string | null {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    return this.tokens.get(canonical) ?? null;
  }

  hasToken(origin: string): boolean {
    return this.getToken(origin) !== null;
  }

  /** Captures the per-origin handshake fence. A caller that awaits between
   *  reading and writing auth state holds one of these and installs only while
   *  it is still current, so a slow response cannot displace a newer one. */
  captureAttempt(origin: string): AuthAttempt | null {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    const attempt = this.attemptTokens.get(canonical) ?? 0;
    return {
      origin: canonical,
      isCurrent: () => (this.attemptTokens.get(canonical) ?? 0) === attempt,
    };
  }

  /** Installs a bundle only while `attempt` still owns the origin. This is the
   *  fence every async credential path uses: a login or password response that
   *  lost its race must not replace the credential that won it. */
  installBundleForAttempt(
    origin: string,
    bundle: V2Bundle,
    attempt: AuthAttempt,
  ): boolean {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical || canonical !== attempt.origin) return false;
    if (!attempt.isCurrent()) return false;
    return this.installBundle(canonical, bundle);
  }

  /** Drops the bundle only while `attempt` still owns the origin, so a clear
   *  cannot revoke a session that was signed in after it started. */
  clearBundleForAttempt(attempt: AuthAttempt): boolean {
    if (!attempt.isCurrent()) return false;
    this.clearBundle(attempt.origin);
    return true;
  }

  /** Advances the per-origin attempt fence so a handshake that started
   *  earlier cannot mutate the selected credential when it finishes. */
  private bumpAttempt(canonical: string): void {
    this.attemptTokens.set(
      canonical,
      (this.attemptTokens.get(canonical) ?? 0) + 1,
    );
  }

  /** Protocol selected for `origin`; null before a credential decides. */
  getSelectedProtocol(origin: string): SelectedProtocol | null {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    return this.selectedProtocols.get(canonical) ?? null;
  }

  /** Returns the verifier cached for `origin` from the most recent
   *  successful login, or null if no successful login has happened
   *  for this origin in the current process. The host reads this
   *  after `tryUnlock` to persist the verifier across restarts. */
  getLastVerifier(origin: string): Buffer | null {
    const canonical = toCanonicalAuthOrigin(origin);
    return (
      (canonical ? this.lastVerifier.get(canonical) : null) ??
      this.lastVerifier.get(origin) ??
      null
    );
  }

  /** Returns the full validated credential (verifier, salt, iterations)
   *  cached for `origin` from the most recent successful login. */
  getLastCredential(
    origin: string,
  ): { verifier: Buffer; salt: Buffer; iterations: number } | null {
    const canonical = toCanonicalAuthOrigin(origin);
    return (
      (canonical ? this.lastCredential.get(canonical) : null) ??
      this.lastCredential.get(origin) ??
      null
    );
  }

  /** Re-authenticate using a previously-derived verifier (typically
   *  loaded from the host's persistent credential store on startup).
   *  Skips the password length check and PBKDF2 derivation — the
   *  verifier is the input. Fetches the current `/api/auth/status`,
   *  computes the proof against its challenge, and POSTs the login.
   *  The trust-settings comparison (algorithm/salt/iterations vs the
   *  stored credential) is the CALLER's responsibility — this method
   *  has no view of the stored credential's salt/iterations. A
   *  mismatch on the caller's side should skip the call entirely
   *  (the server's HMAC check will reject the verifier anyway); the
   *  pre-check belongs in the host's `tryReauthWithStoredCredential`
   *  so a salt rotation invalidates the credential cleanly. */
  async tryUnlockWithVerifier(
    origin: string,
    verifier: Buffer,
    signal?: AbortSignal,
  ): Promise<UnlockResult> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) {
      verifier.fill(0);
      return { kind: 'unavailable', message: 'invalid origin' };
    }
    if (this.selectedProtocols.get(canonical) === 'v2') {
      verifier.fill(0);
      return { kind: 'unavailable', message: 'v2 selected' };
    }
    if (verifier.length !== 32) {
      verifier.fill(0);
      return {
        kind: 'invalid-password',
        message: 'Stored credential is corrupted.',
      };
    }
    const attempt = this.captureAttempt(canonical);
    const status = await this.fetchStatus(canonical, signal);
    if (!attempt?.isCurrent()) {
      verifier.fill(0);
      return { kind: 'stale', message: 'Superseded' };
    }
    if (status.kind === 'unavailable') {
      verifier.fill(0);
      return { kind: 'unavailable', message: status.message };
    }
    if (status.kind === 'no-auth') {
      verifier.fill(0);
      this.cancel(origin);
      const cfg = await this.fetchConfig(canonical, signal);
      return cfg.kind === 'ok'
        ? { kind: 'ok', config: cfg.config }
        : {
            kind: 'unavailable',
            message: 'auth disabled but config still failed',
          };
    }
    const verifierCopy = Buffer.from(verifier);
    let res: UnlockResult;
    try {
      res = await this.completeUnlock(
        canonical,
        verifierCopy,
        status,
        signal,
        origin,
      );
      // If login returned invalid-password, the challenge may have expired or been consumed
      // (e.g. server restart). Allow at most one retry with a fresh status and challenge.
      if (res.kind === 'invalid-password' && !signal?.aborted) {
        const retryAttempt = this.captureAttempt(canonical);
        const freshStatus = await this.fetchStatus(canonical, signal);
        if (!retryAttempt?.isCurrent()) {
          return { kind: 'stale', message: 'Superseded' };
        }
        if (freshStatus.kind === 'trusted') {
          const retryCopy = Buffer.from(verifier);
          res = await this.completeUnlock(
            canonical,
            retryCopy,
            freshStatus,
            signal,
            origin,
          );
        }
      }
    } finally {
      verifier.fill(0);
    }
    return res;
  }

  /** Test/introspect helper: does `origin` currently hold a session cookie? */
  hasCookie(origin: string): boolean {
    if (this.cookies.has(origin)) return true;
    const canonical = toCanonicalAuthOrigin(origin);
    return canonical !== null && this.cookies.has(canonical);
  }

  /** Creates a fresh one-time login proof from the verifier retained after
   *  a successful desktop unlock. The proof may be handed to that origin's
   *  body view: it is bound to a server-issued single-use challenge and
   *  cannot reveal or replace the password/verifier. */
  async createLoginProof(
    origin: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'ok'; challenge: string; proof: string }
    | { kind: 'no-auth' }
    | { kind: 'unavailable'; message: string }
    | { kind: 'stale'; message: string }
  > {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return { kind: 'unavailable', message: 'invalid origin' };
    if (this.selectedProtocols.get(canonical) === 'v2') {
      return { kind: 'unavailable', message: 'v2 selected' };
    }
    if (signal?.aborted) return { kind: 'stale', message: 'Aborted' };
    const status = await this.fetchStatus(canonical, signal);
    if (signal?.aborted) return { kind: 'stale', message: 'Aborted' };
    if (status.kind === 'unavailable') return status;
    if (status.kind === 'no-auth') return status;
    const cred = this.lastCredential.get(canonical);
    const verifier = cred ? cred.verifier : this.lastVerifier.get(canonical);
    if (!verifier)
      return {
        kind: 'unavailable',
        message: 'No authenticated credential is available.',
      };
    return {
      kind: 'ok',
      challenge: status.challenge,
      proof: makeProof(verifier, status.challenge),
    };
  }
  /**
   * Fetches `/api/config` for `origin` with the captured session cookie
   * (if any). 401 is a discriminated `unauthorized` (the caller decides
   * whether to prompt for the password). Anything else (5xx, timeout,
   * CORS, malformed JSON) is `unavailable` — NOT promptable.
   */
  async fetchConfig(
    origin: string,
    signal?: AbortSignal,
  ): Promise<FetchConfigResult> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return { kind: 'unavailable', reason: 'invalid origin' };
    const protocol = this.selectedProtocols.get(canonical) ?? 'v1';
    let token = protocol === 'v2' ? this.tokens.get(canonical) : undefined;
    let cookie =
      protocol === 'v2'
        ? undefined
        : (this.cookies.get(canonical) ??
          (origin !== canonical ? this.cookies.get(origin) : undefined));
    if (protocol !== 'v2' && !cookie && this._cookieProvider) {
      try {
        let fromProvider = await this._cookieProvider(origin);
        if (!fromProvider && origin !== canonical) {
          fromProvider = await this._cookieProvider(canonical);
        }
        if (fromProvider) {
          const providerEntry = { ...fromProvider, origin: canonical };
          this.cookies.set(canonical, providerEntry);
          if (origin !== canonical) this.cookies.set(origin, providerEntry);
          cookie = providerEntry;
        }
      } catch {
        /* ignore provider lookup error */
      }
      // A host token installed while the provider was pending wins: never
      // send a legacy cookie for an origin that has since selected v2.
      if (this.selectedProtocols.get(canonical) === 'v2') {
        cookie = undefined;
        token = this.tokens.get(canonical);
      }
    }
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (cookie)
      headers.Cookie = `${cookie.cookieName}=${cookie.cookieValue}`;
    const sentCookie = cookie;
    try {
      const res = await this.safeFetch(new URL(CONFIG_PATH, canonical), {
        headers,
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 401) {
        if (token) {
          const bundle = this.bundles.get(canonical);
          if (bundle && bundle.token === token) {
            // A current access 401 is not proof the session ended: start one
            // host refresh for subsequent work. This request is never
            // replayed, so a mutation cannot be duplicated here.
            void this.refreshAccess(canonical);
          } else if (this.tokens.get(canonical) === token) {
            // A host-installed token without a refresh handle can only be
            // cleared; a newer token installed meanwhile survives.
            this.tokens.delete(canonical);
          }
        } else {
          const current =
            this.cookies.get(canonical) ?? this.cookies.get(origin);
          if (
            sentCookie &&
            current &&
            current.cookieValue === sentCookie.cookieValue
          ) {
            this.cookies.delete(canonical);
            this.cookies.delete(origin);
          }
        }
        return { kind: 'unauthorized' };
      }
      if (!res.ok) return { kind: 'unavailable', reason: `http ${res.status}` };
      // Parse defensively: a non-JSON body should not crash the main view.
      const text = await res.text();
      try {
        return { kind: 'ok', config: JSON.parse(text) as unknown };
      } catch {
        return { kind: 'unavailable', reason: 'bad json' };
      }
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Runs the unlock handshake: fetch fresh status, choose the advertised
   * protocol, then either derive a v1 verifier or post the raw password to
   * the v2 route. Returns `stale` when the active origin changed
   * mid-handshake. Status validation failures → `unavailable` (the caller
   * shows the user a non-modal message — never a password prompt on a
   * server we can't trust). Returns `no-auth-needed` when the server
   * reports access disabled (the caller clears any prompt and re-fetches
   * config).
   */
  async tryUnlock(
    origin: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<UnlockResult> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) {
      return { kind: 'unavailable', message: 'invalid origin' };
    }
    if (typeof password !== 'string') {
      return { kind: 'invalid-password', message: 'Password is required.' };
    }
    // Byte length is the lower bound for both protocols: a multibyte
    // password can be shorter in UTF-16 code units but long enough in
    // UTF-8. The v1 branch still applies its character-count bounds.
    if (Buffer.byteLength(password, 'utf8') < MIN_PASSWORD_LEN) {
      return {
        kind: 'invalid-password',
        message: 'Password length is out of range.',
      };
    }
    const attempt = (this.attemptTokens.get(canonical) ?? 0) + 1;
    this.attemptTokens.set(canonical, attempt);
    const isCurrent = (): boolean =>
      this.attemptTokens.get(canonical) === attempt;
    const discovery = await this.discoverStatus(canonical, signal);
    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    if (discovery.kind === 'unavailable') {
      return { kind: 'unavailable', message: discovery.message };
    }
    if (discovery.kind === 'disabled') {
      this.cancel(origin);
      const cfg = await this.fetchConfig(canonical, signal);
      return cfg.kind === 'ok'
        ? { kind: 'ok', config: cfg.config }
        : {
            kind: 'unavailable',
            message: 'auth disabled but config still failed',
          };
    }

    let protocol = this.selectedProtocols.get(canonical);
    // Only a successful v1-only discovery may move a selected v2 client back
    // to v1. A v1 selection never upgrades during a login attempt.
    if (protocol === 'v2' && !discovery.protocols.includes('v2')) {
      this.selectedProtocols.set(canonical, 'v1');
      this.tokens.delete(canonical);
      protocol = 'v1';
    }
    if (!protocol) {
      protocol = discovery.protocols.includes('v2') ? 'v2' : 'v1';
    }

    if (protocol === 'v2') {
      const bytes = Buffer.byteLength(password, 'utf8');
      if (bytes < MIN_PASSWORD_LEN || bytes > MAX_PASSWORD_LEN) {
        return {
          kind: 'invalid-password',
          message: 'Password length is out of range.',
        };
      }
      // Fix the selection before the network round trip: a failed v2 login
      // must not fall back to a v1 cookie or verifier on the next poll.
      this.selectedProtocols.set(canonical, 'v2');
      return this.completeV2Unlock(canonical, password, signal);
    }

    if (
      password.length < MIN_PASSWORD_LEN ||
      password.length > MAX_PASSWORD_LEN
    ) {
      return {
        kind: 'invalid-password',
        message: 'Password length is out of range.',
      };
    }
    const status = validateStatus(discovery.raw);
    if (status === null || status.kind !== 'trusted') {
      return {
        kind: 'unavailable',
        message: 'Phi returned unexpected auth settings',
      };
    }
    this.selectedProtocols.set(canonical, 'v1');
    const verifier = await deriveVerifier(
      password,
      status.status.salt,
      status.status.iterations,
    );
    try {
      return await this.completeUnlock(
        canonical,
        verifier,
        { kind: 'trusted', ...status.status },
        signal,
        origin,
      );
    } finally {
      verifier.fill(0);
    }
  }

  /** Posts a raw password to the v2 route, installs the returned bearer, and
   *  retries `/api/config` with it. The token is cleared only when the server
   *  rejects that same token; transient failures keep it for the next poll. */
  private async completeV2Unlock(
    canonical: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<UnlockResult> {
    const attempt = (this.attemptTokens.get(canonical) ?? 0) + 1;
    this.attemptTokens.set(canonical, attempt);
    const isCurrent = (): boolean =>
      this.attemptTokens.get(canonical) === attempt;
    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }

    let login: Awaited<ReturnType<AccessAuth['postV2Login']>>;
    try {
      login = await this.postV2Login(canonical, password, signal);
    } catch (err) {
      return {
        kind: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    if (login.kind !== 'ok') return login;

    if (!this.installBundle(canonical, login.bundle)) {
      return { kind: 'unavailable', message: 'v2 login returned bad bundle' };
    }
    this.selectedProtocols.set(canonical, 'v2');
    // Installing advances the handshake fence, which is what retires an older
    // in-flight attempt. This attempt must keep owning the credential it just
    // installed, so it adopts the new fence value before the follow-up fetch.
    const installedAttempt = this.attemptTokens.get(canonical) ?? 0;
    const stillCurrent = (): boolean =>
      this.attemptTokens.get(canonical) === installedAttempt;

    const cfg = await this.fetchConfig(canonical, signal);
    if (signal?.aborted || !stillCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    if (cfg.kind === 'ok') return { kind: 'ok', config: cfg.config };
    if (cfg.kind === 'unauthorized') {
      // The login itself succeeded; a 401 on config means the access token was
      // not accepted. A refresh is already in flight from fetchConfig, so the
      // bundle stays and the next poll recovers without another prompt.
      return { kind: 'unavailable', message: 'Session was not accepted.' };
    }
    // 5xx/timeout after a successful login: keep the token so the next poll
    // can recover, exactly like the v1 cookie path.
    return { kind: 'ok', config: null };
  }

  private async postV2Login(
    canonical: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'ok'; bundle: V2Bundle }
    | { kind: 'rate-limited'; message: string }
    | { kind: 'invalid-password'; message: string }
    | { kind: 'unavailable'; message: string }
  > {
    try {
      const res = await this.safeFetch(new URL(AUTH_PATH_V2_LOGIN, canonical), {
        method: 'POST',
        // No browser metadata is forged: the host sends the route-local CSRF
        // header a non-browser client is required to present.
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: CSRF_VALUE,
        },
        body: JSON.stringify({ password }),
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 429) {
        return {
          kind: 'rate-limited',
          message: 'Too many attempts. Try again later.',
        };
      }
      if (res.status === 400 || res.status === 401) {
        return { kind: 'invalid-password', message: 'Password not accepted.' };
      }
      if (res.status === 403) {
        return {
          kind: 'unavailable',
          message: 'Server refused the request origin',
        };
      }
      if (!res.ok) {
        return { kind: 'unavailable', message: `v2 login http ${res.status}` };
      }
      const handle = parseRefreshHandle(res);
      if (handle === null) {
        return {
          kind: 'unavailable',
          message: 'v2 login returned no refresh handle',
        };
      }
      const bundle = await this.readBundle(res, handle);
      if (bundle === null) {
        return { kind: 'unavailable', message: 'v2 login returned bad bundle' };
      }
      return { kind: 'ok', bundle };
    } catch (err) {
      return {
        kind: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Discovers enabled state and advertised protocols from the legacy status
   *  route. The raw body is retained for the v1 KDF path only. */
  async discoverStatus(
    origin: string,
    signal?: AbortSignal,
  ): Promise<AuthDiscovery> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return { kind: 'unavailable', message: 'invalid origin' };
    try {
      const res = await this.safeFetch(new URL(AUTH_PATH_STATUS, canonical), {
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status !== 200) {
        return { kind: 'unavailable', message: `status http ${res.status}` };
      }
      const raw = (await res.json()) as unknown;
      if (!raw || typeof raw !== 'object') {
        return { kind: 'unavailable', message: 'bad status json' };
      }
      const record = raw as Record<string, unknown>;
      if (typeof record.enabled !== 'boolean') {
        return { kind: 'unavailable', message: 'bad status enabled' };
      }
      const protocols = parseProtocols(record.protocols);
      if (protocols === null) {
        return { kind: 'unavailable', message: 'bad status protocols' };
      }
      if (record.enabled === false) {
        return { kind: 'disabled', protocols };
      }
      if (typeof record.authenticated !== 'boolean') {
        return { kind: 'unavailable', message: 'bad status authenticated' };
      }
      return {
        kind: 'enabled',
        protocols,
        authenticated: record.authenticated,
        raw: record,
      };
    } catch (err) {
      return {
        kind: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Checks an installed token through the v2 status route. Never sends a
   *  cookie, never clears the token: the caller owns that decision. */
  async checkToken(
    origin: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<TokenVerdict> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical || typeof token !== 'string' || token.length === 0) {
      return 'invalid';
    }
    try {
      const res = await this.safeFetch(
        new URL(AUTH_PATH_V2_STATUS, canonical),
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: withTimeout(signal, FETCH_TIMEOUT_MS),
          redirect: 'error',
        },
      );
      if (res.status === 401 || res.status === 403) return 'invalid';
      if (res.status !== 200) return 'unavailable';
      const payload = (await res.json()) as unknown;
      if (!payload || typeof payload !== 'object') return 'unavailable';
      const record = payload as Record<string, unknown>;
      if (typeof record.enabled !== 'boolean') return 'unavailable';
      if (typeof record.authenticated !== 'boolean') return 'unavailable';
      if (record.enabled === false) return 'valid';
      return record.authenticated ? 'valid' : 'invalid';
    } catch {
      return 'unavailable';
    }
  }

  /** Renews the bundled credential when its access expiry is near. Pull-based
   *  on purpose: the host calls this before its own polling, so there is no
   *  timer loop to drift, duplicate, or fire for a stale origin. Returns null
   *  when nothing is due, or when a previous failure is still backing off. */
  async renewIfDue(
    origin: string,
    signal?: AbortSignal,
  ): Promise<RefreshResult | null> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return null;
    if (!this.renewalDue(canonical)) return null;
    return this.refreshAccess(canonical, signal);
  }

  /** Synchronous form of the same check, so a caller can skip the `await`
   *  entirely when no renewal is pending: a poll for an origin without a
   *  bundle must not gain a microtask boundary it never had. */
  renewalDue(origin: string): boolean {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return false;
    const bundle = this.bundles.get(canonical);
    if (!bundle) return false;
    const backoff = this.refreshBackoff.get(canonical);
    if (backoff && backoff.until > this._now()) return false;
    // `expiresIn <= 0` means the bundle was already unusable on arrival; the
    // backoff check above keeps that from becoming a retry loop.
    if (bundle.expiresIn <= 0) return true;
    const deadline = this.deadlineAt.get(canonical);
    // An unknown deadline is not evidence of freshness: renew.
    if (deadline === undefined) return true;
    return this._now() >= deadline - RENEW_LEAD_S * 1000;
  }

  /** Forces one host refresh for `origin`, coalescing concurrent callers onto
   *  a single request. The refresh handle travels only in the `Cookie` header
   *  built here: never in JSON, a URL, or an `Authorization` value. */
  async refreshAccess(
    origin: string,
    signal?: AbortSignal,
  ): Promise<RefreshResult> {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return { kind: 'unavailable', reason: 'invalid origin' };
    const existing = this.refreshes.get(canonical);
    if (existing) return existing;
    const bundle = this.bundles.get(canonical);
    if (!bundle) return { kind: 'unavailable', reason: 'no refresh handle' };
    const pending = this.runRefresh(canonical, bundle, signal);
    this.refreshes.set(canonical, pending);
    try {
      return await pending;
    } finally {
      if (this.refreshes.get(canonical) === pending) {
        this.refreshes.delete(canonical);
      }
    }
  }

  /** Revokes this host's v2 session through the bearer route. `all` revokes
   *  every family and advances the record epoch. The host never claims the
   *  logout reached the server when the request failed. */
  async logout(
    origin: string,
    all: boolean,
    signal?: AbortSignal,
  ): Promise<LogoutResult> {
    const canonical = toCanonicalAuthOrigin(origin);
    const token = canonical ? this.tokens.get(canonical) : undefined;
    if (!canonical || !token) {
      return { kind: 'unavailable', reason: 'no credential to logout' };
    }
    let res: Response;
    try {
      res = await this.safeFetch(new URL(AUTH_PATH_V2_LOGOUT, canonical), {
        method: 'POST',
        // The bearer is the only authorization; the refresh cookie is not.
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: CSRF_VALUE,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ all }),
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (res.status === 401) {
      // Terminal: the credential is already gone server-side.
      if (this.tokens.get(canonical) === token) this.clearBundle(canonical);
      return { kind: 'unauthorized' };
    }
    if (!res.ok) {
      return { kind: 'unavailable', reason: `logout http ${res.status}` };
    }
    // Confirmed: the server cut the session and deleted its cookies.
    if (this.tokens.get(canonical) === token) this.clearBundle(canonical);
    return { kind: 'ok' };
  }

  /** Runs one refresh request and applies its outcome under the same fencing
   *  rules as a login: only a response that still owns the current handle may
   *  install, and only the current handle's 401 may clear. */
  private async runRefresh(
    canonical: string,
    bundle: V2Bundle,
    signal?: AbortSignal,
  ): Promise<RefreshResult> {
    let res: Response;
    try {
      res = await this.safeFetch(new URL(AUTH_PATH_V2_REFRESH, canonical), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: CSRF_VALUE,
          Cookie: `${REFRESH_COOKIE_NAME}=${bundle.refreshHandle}`,
        },
        body: '{}',
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      return this.failRefresh(
        canonical,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (res.status === 401) {
      // Only a 401 for the handle this request sent is terminal. A newer
      // login may have replaced it while this was in flight.
      const current = this.bundles.get(canonical);
      if (current && current.refreshHandle === bundle.refreshHandle) {
        this.clearBundle(canonical);
      }
      return { kind: 'unauthorized' };
    }
    if (res.status === 429) {
      return this.failRefresh(
        canonical,
        'refresh rate limited',
        retryAfterMs(res),
      );
    }
    if (!res.ok) {
      return this.failRefresh(canonical, `refresh http ${res.status}`);
    }
    // Even a grace replay re-issues the refresh cookie, so a success without
    // one is not a usable rotation: keep the current handle and retry rather
    // than treat a half-formed response as fresh state.
    const handle = parseRefreshHandle(res);
    if (handle === null) {
      return this.failRefresh(canonical, 'refresh returned no usable handle');
    }
    let installed: V2Bundle | null;
    try {
      installed = await this.readBundle(res, handle);
    } catch (err) {
      return this.failRefresh(
        canonical,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (installed === null) {
      return this.failRefresh(canonical, 'refresh returned a bad bundle');
    }
    const current = this.bundles.get(canonical);
    if (
      !current ||
      current.refreshHandle !== bundle.refreshHandle ||
      current.token !== bundle.token
    ) {
      // A newer credential won while this refresh was in flight: installing
      // now would resurrect the rotated handle the server just retired.
      return { kind: 'superseded' };
    }
    // The rotated bundle restarts the receipt-relative renewal clock: the
    // server's `expires_in` is measured from this response.
    this.installBundle(canonical, installed);
    return { kind: 'ok', bundle: installed };
  }

  /** Reads and validates a bundle body, bounded before parsing so a hostile or
   *  broken response cannot be interpreted as a credential. */
  private async readBundle(
    res: Response,
    handle: string,
  ): Promise<V2Bundle | null> {
    const text = await res.text();
    if (text.length > MAX_BUNDLE_BYTES) throw new Error('bundle too large');
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error('bundle is not json');
    }
    return parseCredentialBundle(payload, handle);
  }

  /** Records a non-terminal failure and returns it: the bundle stays, and the
   *  next attempt waits out a bounded backoff. */
  private failRefresh(
    canonical: string,
    reason: string,
    retryAfter?: number,
  ): RefreshResult {
    const previous = this.refreshBackoff.get(canonical);
    const attempts = (previous?.attempts ?? 0) + 1;
    const computed = Math.min(
      REFRESH_BACKOFF_MAX_MS,
      REFRESH_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    );
    const delay = Math.min(
      RETRY_AFTER_MAX_MS,
      retryAfter !== undefined ? Math.max(retryAfter, computed) : computed,
    );
    this.refreshBackoff.set(canonical, {
      attempts,
      until: this._now() + delay,
    });
    const result: RefreshResult = { kind: 'unavailable', reason };
    return retryAfter !== undefined
      ? { ...result, retryAfterMs: delay }
      : result;
  }

  /** Drops the v2 credential for `canonical` but keeps the protocol selection,
   *  so no later request falls back to a legacy cookie or verifier. */
  private clearBundle(canonical: string): void {
    this.tokens.delete(canonical);
    this.bundles.delete(canonical);
    this.refreshBackoff.delete(canonical);
    this.deadlineAt.delete(canonical);
    this.selectedProtocols.set(canonical, 'v2');
    // A terminal rejection is the one case the stored bundle must go away.
    this.announceBundle(canonical);
  }

  /** Shared post-status-fetch login path: computes the proof, posts
   *  login, captures the cookie, and stores the verifier for the
   *  host's persistent credential layer. Both `tryUnlock` (password
   *  path) and `tryUnlockWithVerifier` (stored-credential path)
   *  funnel through this method so the cookie-capture and
   *  verifier-caching are written once.
   *
   *  The caller is responsible for zeroing `verifier` after this
   *  returns. */
  private async completeUnlock(
    canonical: string,
    verifier: Buffer,
    status: {
      kind: 'trusted';
      salt: Buffer;
      iterations: number;
      challenge: string;
      authenticated: boolean;
    },
    signal: AbortSignal | undefined,
    callerOrigin?: string,
  ): Promise<UnlockResult> {
    if (this.selectedProtocols.get(canonical) === 'v2') {
      return { kind: 'stale', message: 'Superseded' };
    }
    const attempt = (this.attemptTokens.get(canonical) ?? 0) + 1;
    this.attemptTokens.set(canonical, attempt);
    const isCurrent = (): boolean =>
      this.attemptTokens.get(canonical) === attempt;

    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    const proof = makeProof(verifier, status.challenge);
    const login = await this.postLogin(
      canonical,
      status.challenge,
      proof,
      signal,
    );
    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    if (login.kind === 'rate-limited') {
      return { kind: 'rate-limited', message: login.message };
    }
    if (login.kind === 'unavailable') {
      return login;
    }
    if (login.kind !== 'ok') {
      return login;
    }

    // The successful v1 credential decides the protocol, including restoration.
    this.selectedProtocols.set(canonical, 'v1');
    // Install cookie and cache verifier only if this attempt is still current
    this.cookies.set(canonical, login.cookie);
    if (callerOrigin && callerOrigin !== canonical) {
      this.cookies.set(callerOrigin, login.cookie);
    }
    if (this._onCookieCaptured) {
      try {
        void this._onCookieCaptured(callerOrigin ?? canonical, login.cookie);
      } catch {
        /* ignore */
      }
    }
    const cached = Buffer.alloc(verifier.length);
    cached.set(verifier);
    this.lastVerifier.set(canonical, cached);
    this.lastCredential.set(canonical, {
      verifier: Buffer.from(cached),
      salt: Buffer.from(status.salt),
      iterations: status.iterations,
    });
    if (callerOrigin && callerOrigin !== canonical) {
      this.lastVerifier.set(callerOrigin, cached);
      this.lastCredential.set(callerOrigin, {
        verifier: Buffer.from(cached),
        salt: Buffer.from(status.salt),
        iterations: status.iterations,
      });
    }

    // Re-fetch config with the captured cookie.
    const cfg = await this.fetchConfig(canonical, signal);
    if (signal?.aborted || !isCurrent()) {
      return { kind: 'stale', message: 'Aborted' };
    }
    if (cfg.kind === 'ok') return { kind: 'ok', config: cfg.config };
    if (cfg.kind === 'unauthorized') {
      // Server did not accept the session on /api/config.
      // Invalidate only the specific cookie installed by this login if it is still present.
      // Crucially, DO NOT call this.cancel(canonical) which would destroy a newer login's state!
      const current =
        this.cookies.get(canonical) ??
        (callerOrigin ? this.cookies.get(callerOrigin) : undefined);
      if (!current || current.cookieValue === login.cookie.cookieValue) {
        this.cookies.delete(canonical);
        if (callerOrigin) this.cookies.delete(callerOrigin);
      }
      return { kind: 'unavailable', message: 'Session was not accepted.' };
    }
    // 5xx/timeout after a successful login: keep the cookie so the next poll can recover
    return { kind: 'ok', config: null };
  }

  // -- internals --

  /** Fetch the trust settings the server exposes at `/api/auth/status`.
   *  Public so the host loop can validate a 401-triggered unlock prompt
   *  with the same accessor (no second fetch path to drift). */
  async fetchStatus(
    origin: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'no-auth' }
    | {
        kind: 'trusted';
        salt: Buffer;
        iterations: number;
        challenge: string;
        authenticated: boolean;
      }
    | { kind: 'unavailable'; message: string }
  > {
    const canonical = toCanonicalAuthOrigin(origin);
    if (!canonical) return { kind: 'unavailable', message: 'invalid origin' };
    try {
      const res = await this.safeFetch(new URL(AUTH_PATH_STATUS, canonical), {
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok)
        return { kind: 'unavailable', message: `status http ${res.status}` };
      const status = (await res.json()) as unknown;
      const v = validateStatus(status);
      if (v === null)
        return {
          kind: 'unavailable',
          message: 'Phi returned unexpected auth settings',
        };
      if (v.kind === 'disabled') return { kind: 'no-auth' };
      return {
        kind: 'trusted',
        salt: v.status.salt,
        iterations: v.status.iterations,
        challenge: v.status.challenge,
        authenticated: v.status.authenticated,
      };
    } catch (err) {
      return {
        kind: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async postLogin(
    canonical: string,
    challenge: string,
    proof: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'ok'; cookie: CookieJarEntry }
    | { kind: 'rate-limited'; message: string }
    | { kind: 'invalid-password'; message: string }
    | { kind: 'unavailable'; message: string }
  > {
    try {
      const res = await this.safeFetch(new URL(AUTH_PATH_LOGIN, canonical), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, proof }),
        signal: withTimeout(signal, FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 429) {
        return {
          kind: 'rate-limited',
          message: await extractError(res, 'rate-limited'),
        };
      }
      if (res.status === 401) {
        return {
          kind: 'invalid-password',
          message: await extractError(res, 'Password not accepted'),
        };
      }
      if (!res.ok) {
        return { kind: 'unavailable', message: `login http ${res.status}` };
      }
      const cookie = parseSessionCookie(res);
      if (cookie === null)
        return {
          kind: 'unavailable',
          message: 'missing or insecure session cookie',
        };
      return { kind: 'ok', cookie: { origin: canonical, ...cookie } };
    } catch (err) {
      return {
        kind: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// -- module-private helpers (exposed only for tests via dynamic import) --

/** Public for tests. Async PBKDF2-SHA256 with bounded cost. */
export async function deriveVerifier(
  password: string,
  salt: Buffer,
  iterations: number,
): Promise<Buffer> {
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error(
      `iterations ${iterations} outside [${MIN_ITERATIONS}, ${MAX_ITERATIONS}]`,
    );
  }
  return pbkdf2Async(password, salt, iterations, 32, 'sha256');
}

/** Public for tests. HMAC-SHA256 proof encoded unpadded base64URL. */
export function makeProof(verifier: Buffer, challenge: string): string {
  return createHmac('sha256', verifier)
    .update(challenge, 'utf8')
    .digest('base64url');
}

/** Validate the optional `protocols` capability field. Absent means a
 *  legacy v1-only server. A present field must be a nonempty array of
 *  unique, nonempty strings and must name at least one supported protocol. */
export function parseProtocols(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (seen.has(value)) return null;
    seen.add(value);
  }
  const supported = Array.from(seen).filter((p) => p === 'v1' || p === 'v2');
  return supported.length === 0 ? null : supported;
}

/** Validate `/api/auth/status` JSON. Returns either the trusted status,
 *  an explicit disabled marker, or null on malformed input. */
export type ValidateStatusOutcome =
  | { kind: 'disabled' }
  | { kind: 'trusted'; status: TrustedAuthStatus };

export function validateStatus(raw: unknown): ValidateStatusOutcome | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return { kind: 'disabled' };
  if (r.enabled !== true) return null;
  if (typeof r.authenticated !== 'boolean') return null;
  if (r.version !== 'v1') return null;
  if (r.algorithm !== 'pbkdf2-sha256') return null;
  if (typeof r.iterations !== 'number') return null;
  if (
    !Number.isInteger(r.iterations) ||
    r.iterations < MIN_ITERATIONS ||
    r.iterations > MAX_ITERATIONS
  )
    return null;
  if (typeof r.salt !== 'string') return null;
  let salt: Buffer;
  try {
    salt = Buffer.from(r.salt, 'base64url');
    if (salt.length === 0) return null;
  } catch {
    return null;
  }
  if (typeof r.challenge !== 'string' || r.challenge.length === 0) return null;
  const authenticated = 'authenticated' in r ? r.authenticated === true : false;
  return {
    kind: 'trusted',
    status: {
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: r.iterations,
      salt,
      challenge: r.challenge,
      authenticated,
    },
  };
}

/**
 * Pulls the `phi_access_session` cookie from a response. Validates
 * HttpOnly and a parseable name/value; discards anything weaker. The
 * cookie is bound to `origin` by the caller (URL it's keyed under in
 * the jar); we don't re-check origin here because the response itself
 * is from a same-origin POST.
 */
export function parseSessionCookie(res: Response): ParsedSessionCookie | null {
  const setCookieHeaders = readSetCookieHeaders(res);
  for (const raw of setCookieHeaders) {
    const parts = raw.split(';').map((s) => s.trim());
    const pair = parts[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name !== COOKIE_NAME) continue;
    let httpOnly = false;
    let path = '/';
    for (const attr of parts.slice(1)) {
      if (attr.toLowerCase() === 'httponly') httpOnly = true;
      if (attr.toLowerCase().startsWith('path=')) path = attr.slice(5) || '/';
    }
    if (!httpOnly) return null;
    if (value.length === 0) continue;
    return {
      cookieName: name,
      cookieValue: value,
      path,
      httpOnly: true as const,
    };
  }
  return null;
}

/** A canonical refresh handle: 32 raw bytes, unpadded base64url. Re-encoding
 *  must reproduce the input, so a padded or non-canonical value is rejected
 *  instead of decoded leniently. */
export function isCanonicalRefreshHandle(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== REFRESH_HANDLE_BYTES) return false;
  return bytes.toString('base64url') === value;
}

/** Validates a credential bundle against the section 3 field and deadline
 *  rules. Returns null rather than throwing: a bad bundle never replaces a
 *  working credential. */
export function parseCredentialBundle(
  raw: unknown,
  handle: unknown,
): V2Bundle | null {
  if (!isCanonicalRefreshHandle(handle)) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== 'string' || r.token.length === 0) return null;
  const expiresAt = r.expires_at;
  const expiresIn = r.expires_in;
  const idle = r.refresh_idle_expires_at;
  const absolute = r.refresh_absolute_expires_at;
  if (!isPositiveInt(expiresAt)) return null;
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn))
    return null;
  if (!isPositiveInt(idle) || !isPositiveInt(absolute)) return null;
  if (idle > absolute) return null;
  return {
    token: r.token,
    expiresAt,
    expiresIn,
    refreshHandle: handle,
    refreshIdleExpiresAt: idle,
    refreshAbsoluteExpiresAt: absolute,
  };
}

/** Validates one persisted credential-store entry. The store keeps the token
 *  under `jwt` and the rest flat beside it, so an older build's
 *  `{version:'v2', jwt}` entry is rejected here: a bare token carries no
 *  refresh handle and must not be restored as if it could be renewed. */
export function parseStoredV2Bundle(raw: unknown): V2Bundle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 'v2') return null;
  return parseCredentialBundle(
    {
      token: r.jwt,
      expires_at: r.expiresAt,
      expires_in: r.expiresIn,
      refresh_idle_expires_at: r.refreshIdleExpiresAt,
      refresh_absolute_expires_at: r.refreshAbsoluteExpiresAt,
    },
    r.refreshHandle,
  );
}

/** Checks a bundle a caller already holds (a restored store entry) against the
 *  same rules, so a stored credential is validated before it is trusted. */
export function isValidBundle(value: unknown): value is V2Bundle {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<V2Bundle>;
  return (
    parseCredentialBundle(
      {
        token: b.token,
        expires_at: b.expiresAt,
        expires_in: b.expiresIn,
        refresh_idle_expires_at: b.refreshIdleExpiresAt,
        refresh_absolute_expires_at: b.refreshAbsoluteExpiresAt,
      },
      b.refreshHandle,
    ) !== null
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Pulls the rotated `phi_access_refresh` handle out of a response. The exact
 *  server attributes are required: a handle without them is not one this host
 *  may hold, and accepting it loosely would store an unprotected credential. */
export function parseRefreshHandle(res: Response): string | null {
  for (const raw of readSetCookieHeaders(res)) {
    const parts = raw.split(';').map((s) => s.trim());
    const pair = parts[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq) !== REFRESH_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1);
    if (!isCanonicalRefreshHandle(value)) continue;
    let httpOnly = false;
    let sameSiteStrict = false;
    let path = '';
    let hostOnly = true;
    for (const attr of parts.slice(1)) {
      const lower = attr.toLowerCase();
      if (lower === 'httponly') httpOnly = true;
      if (lower === 'samesite=strict') sameSiteStrict = true;
      if (lower.startsWith('path=')) path = attr.slice(5);
      if (lower.startsWith('domain=')) hostOnly = false;
    }
    if (!httpOnly || !sameSiteStrict || !hostOnly) continue;
    if (path !== REFRESH_COOKIE_PATH) continue;
    return value;
  }
  return null;
}

/** `Retry-After` in milliseconds, when the server sent integer seconds. */
export function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Reads the Set-Cookie headers off a `fetch` `Response`. */
export function readSetCookieHeaders(res: Response): string[] {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    try {
      const out = headers.getSetCookie.call(res.headers);
      if (Array.isArray(out)) return out;
    } catch {
      /* fall through */
    }
  }
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (text.length > 0 && text.length < 256) return text;
  } catch {
    /* ignore */
  }
  return fallback;
}
