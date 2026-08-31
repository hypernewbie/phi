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
const CONFIG_PATH = '/api/config';

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
  /** Per-origin verifier cache: the verifier is computed once per
   *  successful login and held until the host reads it (for disk
   *  persistence) or a new login overwrites it. Cleared on `cancel`
   *  so a stale verifier doesn't outlive its origin. */
  private readonly lastVerifier = new Map<string, Buffer>();
  private readonly lastCredential = new Map<
    string,
    { verifier: Buffer; salt: Buffer; iterations: number }
  >();
  private readonly _doFetch: FetchLike;
  private _cookieProvider: CookieProvider | null = null;
  private _onCookieCaptured: CookieCapturedListener | null = null;

  constructor(doFetch: FetchLike = fetch) {
    this._doFetch = doFetch;
  }

  setCookieProvider(provider: CookieProvider | null): void {
    this._cookieProvider = provider;
  }

  setOnCookieCaptured(listener: CookieCapturedListener | null): void {
    this._onCookieCaptured = listener;
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
    this.cookies.delete(origin);
    this.lastVerifier.delete(origin);
    this.lastCredential.delete(origin);
  }

  /** Returns the verifier cached for `origin` from the most recent
   *  successful login, or null if no successful login has happened
   *  for this origin in the current process. The host reads this
   *  after `tryUnlock` to persist the verifier across restarts. */
  getLastVerifier(origin: string): Buffer | null {
    return this.lastVerifier.get(origin) ?? null;
  }

  /** Returns the full validated credential (verifier, salt, iterations)
   *  cached for `origin` from the most recent successful login. */
  getLastCredential(
    origin: string,
  ): { verifier: Buffer; salt: Buffer; iterations: number } | null {
    return this.lastCredential.get(origin) ?? null;
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
    if (verifier.length !== 32) {
      return {
        kind: 'invalid-password',
        message: 'Stored credential is corrupted.',
      };
    }
    const status = await this.fetchStatus(origin, signal);
    if (status.kind === 'unavailable') {
      verifier.fill(0);
      return { kind: 'unavailable', message: status.message };
    }
    if (status.kind === 'no-auth') {
      verifier.fill(0);
      this.cancel(origin);
      const cfg = await this.fetchConfig(origin);
      return cfg.kind === 'ok'
        ? { kind: 'ok', config: cfg.config }
        : {
            kind: 'unavailable',
            message: 'auth disabled but config still failed',
          };
    }
    return this.completeUnlock(origin, verifier, status, signal);
  }

  /** Test/introspect helper: does `origin` currently hold a session cookie? */
  hasCookie(origin: string): boolean {
    return this.cookies.has(origin);
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
    if (signal?.aborted) return { kind: 'stale', message: 'Aborted' };
    const status = await this.fetchStatus(origin, signal);
    if (signal?.aborted) return { kind: 'stale', message: 'Aborted' };
    if (status.kind === 'unavailable') return status;
    if (status.kind === 'no-auth') return status;
    const cred = this.lastCredential.get(origin);
    const verifier = cred ? cred.verifier : this.lastVerifier.get(origin);
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
  async fetchConfig(origin: string): Promise<FetchConfigResult> {
    let cookie = this.cookies.get(origin);
    if (!cookie && this._cookieProvider) {
      try {
        const fromProvider = await this._cookieProvider(origin);
        if (fromProvider) {
          this.cookies.set(origin, fromProvider);
          cookie = fromProvider;
        }
      } catch {
        /* ignore provider lookup error */
      }
    }
    const headers: Record<string, string> = {};
    if (cookie)
      headers['Cookie'] = `${cookie.cookieName}=${cookie.cookieValue}`;
    try {
      const res = await this.safeFetch(new URL(CONFIG_PATH, origin), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 401) {
        this.cookies.delete(origin);
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
   * Runs the unlock handshake: fetch fresh status, derive verifier,
   * compute proof, POST login, capture cookie, retry `/api/config`.
   * Returns `stale` when the active origin changed mid-handshake. Status
   * validation failures → `unavailable` (the caller shows the user a
   * non-modal message — never a password prompt on a server we can't
   * trust). Returns `no-auth-needed` when the server reports access
   * disabled (the caller clears any prompt and re-fetches config).
   */
  async tryUnlock(
    origin: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<UnlockResult> {
    if (
      password.length < MIN_PASSWORD_LEN ||
      password.length > MAX_PASSWORD_LEN
    ) {
      return {
        kind: 'invalid-password',
        message: 'Password length is out of range.',
      };
    }
    const status = await this.fetchStatus(origin, signal);
    if (status.kind === 'unavailable') {
      return { kind: 'unavailable', message: status.message };
    }
    if (status.kind === 'no-auth') {
      this.cancel(origin);
      const cfg = await this.fetchConfig(origin);
      return cfg.kind === 'ok'
        ? { kind: 'ok', config: cfg.config }
        : {
            kind: 'unavailable',
            message: 'auth disabled but config still failed',
          };
    }
    // status.kind === 'trusted' — server-controlled values are validated.
    const verifier = await deriveVerifier(
      password,
      status.salt,
      status.iterations,
    );
    return this.completeUnlock(origin, verifier, status, signal);
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
    origin: string,
    verifier: Buffer,
    status: {
      kind: 'trusted';
      salt: Buffer;
      iterations: number;
      challenge: string;
      authenticated: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<UnlockResult> {
    const proof = makeProof(verifier, status.challenge);
    if (signal?.aborted) {
      verifier.fill(0);
      return { kind: 'stale', message: 'Aborted' };
    }
    const login = await this.postLogin(origin, status.challenge, proof, signal);
    if (login.kind === 'rate-limited') {
      verifier.fill(0);
      return { kind: 'rate-limited', message: login.message };
    }
    if (login.kind === 'unavailable') {
      verifier.fill(0);
      return login;
    }
    if (login.kind !== 'ok') {
      verifier.fill(0);
      return login;
    }
    this.cookies.set(origin, login.cookie);
    if (this._onCookieCaptured) {
      try {
        void this._onCookieCaptured(origin, login.cookie);
      } catch {
        /* ignore */
      }
    }
    // Cache the verifier and trust settings so the host can persist it across restarts.
    // The host reads via `getLastCredential` after a successful unlock
    // and stores to disk encrypted via `safeStorage`.
    const cached = Buffer.alloc(verifier.length);
    cached.set(verifier);
    this.lastVerifier.set(origin, cached);
    this.lastCredential.set(origin, {
      verifier: Buffer.from(cached),
      salt: Buffer.from(status.salt),
      iterations: status.iterations,
    });
    // Re-fetch config with the captured cookie. A 401 here means the
    // server accepted login but didn't issue a usable session — drop the
    // cookie and report so the modal stays open with a clear message.
    const cfg = await this.fetchConfig(origin);
    verifier.fill(0);
    if (cfg.kind === 'ok') return { kind: 'ok', config: cfg.config };
    if (cfg.kind === 'unauthorized') {
      this.cancel(origin);
      return { kind: 'invalid-password', message: 'Session was not accepted.' };
    }
    // 5xx/timeout after a successful login: keep the cookie so the next
    // 10s poll can recover, but don't paint the wrong config.
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
    try {
      const res = await this.safeFetch(new URL(AUTH_PATH_STATUS, origin), {
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    origin: string,
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
      const res = await this.safeFetch(new URL(AUTH_PATH_LOGIN, origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, proof }),
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
      return { kind: 'ok', cookie: { origin, ...cookie } };
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
