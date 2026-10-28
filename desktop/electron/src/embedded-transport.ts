/**
 * Main-process embedded transport for the single-tab embedded Phi desktop.
 *
 * Owns the privileged `phi-app://app/` scheme handler, static asset serving
 * from `embedded/`, backend `/api/*` proxy with per-profile cookie jars,
 * `/__phi/active` profile switching, `/__phi/compat` compatibility probing,
 * and the scoped WebSocket origin/cookie header bridge.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  parseCredentialBundle,
  parseRefreshHandle,
  readSetCookieHeaders,
} from './access-auth.js';
import type { LogoutResult, RefreshResult, V2Bundle } from './access-auth.js';

export const EMBEDDED_SCHEME = 'phi-app';
export const EMBEDDED_HOST = 'app';
export const EMBEDDED_ORIGIN = 'phi-app://app';

/** The header the server accepts as a WebSocket credential. The shell page
 *  holds no token, so the main process adds it on approved upgrades. */
export const SOCKET_TOKEN_HEADER = 'X-Phi-Socket-Token';
/** Fixed host requirement on every v2 POST row. */
const V2_CSRF_HEADER = 'X-Phi-Auth';
const V2_CSRF_VALUE = 'v2';
/** A credential bundle larger than this is a host error, never a credential. */
const MAX_CREDENTIAL_BODY_BYTES = 64 * 1024;

/** How long a positive capability answer is reused. */
const COMPAT_CACHE_TTL_MS = 10 * 60 * 1000;
/** How long a negative capability answer is reused (short: the server may
 *  be upgraded to the current API at any time). */
const COMPAT_NEGATIVE_TTL_MS = 60 * 1000;
/** The access-auth session cookie the phi server issues. */
const ACCESS_SESSION_COOKIE = 'phi_access_session';
/** How long a proxied request waits for an in-flight unlock. */
const AUTH_WAIT_CAP_MS = 3_000;
export const EMBEDDED_PARTITION = 'persist:phi-embedded';

export interface EmbeddedProfile {
  id: string;
  origin: string;
}

export interface EmbeddedTransportOptions {
  embeddedDir: string;
  resolveProfile: (id: string) => EmbeddedProfile | null;
  listProfiles?: () => ReadonlyArray<EmbeddedProfile>;
  fetchImpl?: typeof fetch;
  /** Optional path for the persisted server-capability cache. */
  compatCachePath?: string;
  /**
   * The host's access-auth owner. The embedded page holds no credential, so
   * every protected row of the request table is authorized here, and the
   * rotating bundle never leaves host memory.
   */
  auth?: EmbeddedAuthHost;
}

/** The slice of the host `AccessAuth` owner this transport drives. Keeping it
 *  structural avoids a second credential owner and lets tests supply a fake. */
export interface EmbeddedAuthHost {
  getToken(origin: string): string | null;
  getBundle(origin: string): V2Bundle | null;
  installBundle(origin: string, bundle: V2Bundle): boolean;
  refreshAccess(origin: string): Promise<RefreshResult>;
  logout(origin: string, all: boolean): Promise<LogoutResult>;
}

export interface WebRequestFilter {
  urls: string[];
}

export interface WebRequestBeforeSendHeadersDetails {
  url: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}

export interface WebRequestBeforeSendHeadersResponse {
  requestHeaders?: Record<string, string>;
}

export interface WebSocketBridgeSession {
  webRequest: {
    onBeforeSendHeaders: (
      filter: WebRequestFilter,
      listener: (
        details: WebRequestBeforeSendHeadersDetails,
        callback: (response: WebRequestBeforeSendHeadersResponse) => void,
      ) => void,
    ) => void;
  };
}

export interface SchemePrivileges {
  standard?: boolean;
  secure?: boolean;
  supportFetchAPI?: boolean;
  stream?: boolean;
  corsEnabled?: boolean;
  bypassCSP?: boolean;
  allowServiceWorkers?: boolean;
}

export interface CustomSchemeRegistration {
  scheme: string;
  privileges?: SchemePrivileges;
}

export interface ProtocolRegistrar {
  registerSchemesAsPrivileged: (
    customSchemes: Array<CustomSchemeRegistration>,
  ) => void;
}

/**
 * Registers `phi-app` as a standard, secure, fetch-enabled privileged scheme.
 * Must be called before `app.whenReady()`.
 */
export function registerEmbeddedScheme(protocol: ProtocolRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EMBEDDED_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Which row of the embedded request table a proxied `/api/*` call belongs to. */
type AuthProxyRow =
  | 'refresh'
  | 'login'
  | 'password'
  | 'logout'
  | 'status'
  | 'other';

/** The v2 POST routes carry the host's own credential handling. */
const V2_AUTH_POST_ROUTES: Readonly<Record<string, AuthProxyRow>> =
  Object.freeze({
    '/api/auth/v2/refresh': 'refresh',
    '/api/auth/v2/login': 'login',
    '/api/auth/v2/password': 'password',
    '/api/auth/v2/logout': 'logout',
  });

/** Token-free answers the page may receive. A raw bundle never gets here. */
const REFRESH_OK_BODY = '{"ok":true}';
const ENABLED_BODY = '{"ok":true,"enabled":true}';
const CLEARED_BODY = '{"ok":true,"enabled":false}';
const LOGOUT_OK_BODY = '{"ok":true}';

function authProxyRow(pathname: string, method: string): AuthProxyRow {
  if (method === 'GET' && pathname === '/api/auth/v2/status') return 'status';
  if (method !== 'POST') return 'other';
  return V2_AUTH_POST_ROUTES[pathname] ?? 'other';
}

function isPasswordRoute(pathname: string): boolean {
  return pathname === '/api/auth/v2/password';
}

function tokenFreeJSON(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** A fixed token-free failure. The upstream body never reaches the page. */
function tokenFreeError(
  error: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

/** Preserves the status a page needs (401 terminal, 429 wait) without the
 *  upstream body, which can carry credential detail. */
function authFailureResponse(res: Response): Response {
  const error =
    res.status === 401
      ? 'unauthorized'
      : res.status === 429
        ? 'too many attempts'
        : 'authentication failed';
  const retryAfter = res.headers.get('Retry-After');
  return tokenFreeError(
    error,
    res.status,
    retryAfter ? { 'Retry-After': retryAfter } : {},
  );
}

async function readRequestBody(req: Request): Promise<BodyInit | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (typeof req.arrayBuffer === 'function') {
    try {
      const buf = await req.arrayBuffer();
      return buf.byteLength > 0 ? buf : undefined;
    } catch {
      return undefined;
    }
  }
  const fallback = (req as unknown as { body?: BodyInit }).body;
  return fallback === undefined ? undefined : fallback;
}

/** Reads a credential-bearing body under the 64 KiB host limit. `null` means an
 *  empty body and `'oversized'` means the bundle must be rejected, not parsed. */
async function readBoundedText(
  res: Response,
): Promise<string | null | 'oversized'> {
  const declared = Number.parseInt(res.headers.get('Content-Length') ?? '', 10);
  if (Number.isInteger(declared) && declared > MAX_CREDENTIAL_BODY_BYTES) {
    return 'oversized';
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CREDENTIAL_BODY_BYTES) {
    return 'oversized';
  }
  return text.length === 0 ? null : text;
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

export class EmbeddedTransport {
  private readonly embeddedDir: string;
  private readonly resolveProfile: (id: string) => EmbeddedProfile | null;
  private readonly listProfiles?: () => ReadonlyArray<EmbeddedProfile>;
  private readonly fetchImpl: typeof fetch;
  private activeProfileId: string | null = null;
  private readonly cookieJars = new Map<string, Map<string, string>>();
  /** Cached server-capability answers, keyed by profile id. */
  private readonly compatCache = new Map<
    string,
    { compatible: boolean; at: number }
  >();
  /** Where the capability answers are persisted between sessions. */
  private readonly compatCachePath?: string;
  /** In-flight access-auth attempts, keyed by canonical origin. */
  private readonly pendingAuth = new Map<
    string,
    { done: Promise<void>; release: () => void; holders: number }
  >();
  /** The host credential owner. Absent only in tests that never proxy `/api`. */
  private readonly auth?: EmbeddedAuthHost;

  constructor(options: EmbeddedTransportOptions) {
    this.embeddedDir = path.resolve(options.embeddedDir);
    this.resolveProfile = options.resolveProfile;
    this.listProfiles = options.listProfiles;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.compatCachePath = options.compatCachePath;
    this.auth = options.auth;
    this.loadPersistedCompat();
  }

  /**
   * Loads the persisted capability answers. Only POSITIVE answers are
   * kept: a server that speaks the current API keeps speaking it, so the
   * probe never has to run again. A negative answer is never persisted
   * (the server may be upgraded at any time).
   */
  private loadPersistedCompat(): void {
    if (!this.compatCachePath) return;
    try {
      const raw = JSON.parse(
        readFileSync(this.compatCachePath, 'utf8'),
      ) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return;
      for (const [origin, value] of Object.entries(raw)) {
        if (!origin || value !== '1') continue;
        const profile = this.findProfileByOrigin(origin);
        if (!profile) continue;
        this.compatCache.set(profile.id, {
          compatible: true,
          at: Date.now(),
        });
      }
    } catch {
      /* no cache, or an unreadable one: probe normally */
    }
  }

  /**
   * Marks an access-auth attempt as in flight for an origin. Requests for
   * that origin wait for it instead of racing it: the embedded page asks
   * the server whether it is protected as its FIRST call, and answering
   * "yes, and you are not logged in" before the desktop has finished its
   * own unlock made the page show a password prompt the user had already
   * answered elsewhere.
   */
  beginAuth(origin: string): void {
    const key = this.authKey(origin);
    if (!key) return;
    const existing = this.pendingAuth.get(key);
    if (existing) {
      // A second unlock for the same origin joins the first one.
      existing.holders += 1;
      return;
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingAuth.set(key, { done, release, holders: 1 });
  }

  /** Ends an in-flight access-auth attempt and lets waiting requests go. */
  endAuth(origin: string): void {
    const key = this.authKey(origin);
    if (!key) return;
    const pending = this.pendingAuth.get(key);
    if (!pending) return;
    pending.holders -= 1;
    if (pending.holders > 0) return;
    this.pendingAuth.delete(key);
    pending.release();
  }

  /** Waits (briefly) for an in-flight unlock of this origin to finish. */
  private async waitForAuth(origin: string): Promise<void> {
    const key = this.authKey(origin);
    if (!key) return;
    const pending = this.pendingAuth.get(key);
    if (!pending) return;
    // Bounded: a stuck unlock must never wedge the page.
    await Promise.race([
      pending.done,
      new Promise<void>((resolve) => setTimeout(resolve, AUTH_WAIT_CAP_MS)),
    ]);
  }

  private authKey(origin: string): string {
    try {
      return new URL(origin).origin;
    } catch {
      return '';
    }
  }

  /** Persists a positive capability answer for next time. */
  private persistCompat(profile: EmbeddedProfile): void {
    if (!this.compatCachePath) return;
    let next: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(
        readFileSync(this.compatCachePath, 'utf8'),
      ) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') next = raw;
    } catch {
      /* no cache yet: start from an empty one */
    }
    next[profile.origin] = '1';
    try {
      mkdirSync(path.dirname(this.compatCachePath), { recursive: true });
      writeFileSync(this.compatCachePath, JSON.stringify(next), 'utf8');
    } catch {
      /* best effort: the in-memory cache still works */
    }
  }

  getActiveProfileId(): string | null {
    return this.activeProfileId;
  }

  setActiveProfile(id: string | null): void {
    if (id === null || id === '') {
      this.activeProfileId = null;
      return;
    }
    const profile = this.resolveProfile(id);
    if (profile) {
      this.activeProfileId = profile.id;
    }
  }

  async checkCompatibility(profileId: string): Promise<boolean> {
    const profile = this.resolveProfile(profileId);
    if (!profile) return false;

    // The capability probe is a one-time fact about a server, but it costs
    // a full round trip - and a remote server's round trip is the switch's
    // dominant cost. A fresh answer is reused instead of re-probing on
    // every flip. A negative answer expires quickly so a server that is
    // upgraded to the current API is picked up soon.
    const cached = this.compatCache.get(profileId);
    if (cached) {
      const ttl = cached.compatible
        ? COMPAT_CACHE_TTL_MS
        : COMPAT_NEGATIVE_TTL_MS;
      if (Date.now() - cached.at < ttl) return cached.compatible;
      this.compatCache.delete(profileId);
    }

    const compatible = await this.probeCompatibility(profile);
    this.compatCache.set(profileId, { compatible, at: Date.now() });
    if (compatible) this.persistCompat(profile);
    return compatible;
  }

  private async probeCompatibility(profile: EmbeddedProfile): Promise<boolean> {
    try {
      const versionUrl = new URL('/api/version', profile.origin);
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      const cookie = this.getCookieHeader(profile.id);
      if (cookie) {
        headers['Cookie'] = cookie;
      }

      const res = await this.fetchImpl(versionUrl.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(4000),
      });

      // Locked behind access-auth: stay in embedded mode so normal auth flow handles it.
      if (res.status === 401) {
        return true;
      }

      // If res.ok (200), check the api marker.
      if (res.ok) {
        try {
          const data = (await res.json()) as { api?: unknown };
          // A server that does not advertise the marker PREDATES it: the
          // embedded page is the same web app the server itself serves, so
          // it works against that server. Only a server that advertises a
          // DIFFERENT api version is incompatible.
          //
          // Treating "no marker" as incompatible was expensive: the
          // fallback loads the server's own page, and in single-tab mode
          // that is a FULL page load on every switch. With a handful of
          // servers that is fine; with ten it made every switch crawl.
          if (typeof data?.api !== 'string') return true;
          return data.api === '1';
        } catch {
          // A body we cannot read is not evidence of incompatibility.
          return true;
        }
      }

      // Other non-ok statuses or offline: stay in embedded mode.
      return true;
    } catch {
      // Network error (server still starting/unreachable): stay in embedded mode.
      return true;
    }
  }

  // --- Cookie Jar Methods ---

  setCookie(profileId: string, name: string, value: string): void {
    if (!name) return;
    let jar = this.cookieJars.get(profileId);
    if (!jar) {
      jar = new Map();
      this.cookieJars.set(profileId, jar);
    }
    if (value === '') {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }

  applySetCookieHeader(profileId: string, rawSetCookie: string): void {
    if (!rawSetCookie) return;
    const parts = rawSetCookie.split(';');
    const firstPart = parts[0]?.trim();
    if (!firstPart) return;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx === -1) return;
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    if (!name) return;

    let isExpired = value === '';
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]?.trim() ?? '';
      const directiveEq = part.indexOf('=');
      const directiveName = (
        directiveEq === -1 ? part : part.slice(0, directiveEq)
      )
        .trim()
        .toLowerCase();
      const directiveVal =
        directiveEq === -1 ? '' : part.slice(directiveEq + 1).trim();

      if (directiveName === 'max-age') {
        const parsed = parseInt(directiveVal, 10);
        if (isNaN(parsed) || parsed <= 0) {
          isExpired = true;
        }
      } else if (directiveName === 'expires') {
        const parsedTime = Date.parse(directiveVal);
        if (!isNaN(parsedTime) && parsedTime <= Date.now()) {
          isExpired = true;
        }
      }
    }

    if (isExpired) {
      this.cookieJars.get(profileId)?.delete(name);
    } else {
      this.setCookie(profileId, name, value);
    }
  }

  getCookieHeader(profileId: string): string {
    const jar = this.cookieJars.get(profileId);
    if (!jar || jar.size === 0) return '';
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** Finds the profile whose origin matches `origin` (canonical compare:
   *  the profile may store a trailing slash the cookie does not). */
  private findProfileByOrigin(origin: string): EmbeddedProfile | null {
    let canonical: string;
    try {
      canonical = new URL(origin).origin;
    } catch {
      return null;
    }
    const candidates: EmbeddedProfile[] = [];
    const active = this.activeProfileId
      ? this.resolveProfile(this.activeProfileId)
      : null;
    if (active) candidates.push(active);
    for (const p of this.listProfiles?.() ?? []) candidates.push(p);
    for (const p of candidates) {
      try {
        if (new URL(p.origin).origin === canonical) return p;
      } catch {
        /* malformed profile origin */
      }
    }
    return null;
  }

  /**
   * Seeds a profile's cookie jar from a cookie captured elsewhere (the
   * main process's access-auth handshake). Without this the main process
   * and the embedded page hold SEPARATE sessions: the main process knew
   * the server was unlocked while every proxied page request still went
   * out unauthenticated, so the page asked for the password again.
   */
  setCookieForOrigin(origin: string, name: string, value: string): boolean {
    const profile = this.findProfileByOrigin(origin);
    if (!profile) return false;
    this.setCookie(profile.id, name, value);
    return true;
  }

  /** Reads a profile's access-session cookie for the main process. */
  getCookieForOrigin(origin: string): {
    cookieName: string;
    cookieValue: string;
    httpOnly: boolean;
    path: string;
    origin: string;
  } | null {
    const profile = this.findProfileByOrigin(origin);
    if (!profile) return null;
    const jar = this.cookieJars.get(profile.id);
    if (!jar) return null;
    const value = jar.get(ACCESS_SESSION_COOKIE);
    if (!value) return null;
    let canonical = profile.origin;
    try {
      canonical = new URL(profile.origin).origin;
    } catch {
      /* keep the raw origin */
    }
    return {
      cookieName: ACCESS_SESSION_COOKIE,
      cookieValue: value,
      httpOnly: true,
      path: '/',
      origin: canonical,
    };
  }

  clearCookies(profileId: string): void {
    this.cookieJars.delete(profileId);
  }

  // --- WebSocket Header Bridge ---

  attachWebSocketHeaderBridge(
    session: WebSocketBridgeSession,
    getEmbeddedWebContentsId: () => number | null,
  ): void {
    if (typeof session?.webRequest?.onBeforeSendHeaders !== 'function') return;
    session.webRequest.onBeforeSendHeaders(
      { urls: ['ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        const targetWebContentsId = getEmbeddedWebContentsId();
        if (
          targetWebContentsId === null ||
          details.webContentsId === undefined ||
          details.webContentsId !== targetWebContentsId
        ) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        let wsUrl: URL;
        try {
          wsUrl = new URL(details.url);
        } catch {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        let matchedProfile: EmbeddedProfile | null = null;
        if (this.activeProfileId) {
          const active = this.resolveProfile(this.activeProfileId);
          if (active) {
            try {
              if (new URL(active.origin).host === wsUrl.host) {
                matchedProfile = active;
              }
            } catch {}
          }
        }

        if (!matchedProfile && this.listProfiles) {
          const all = this.listProfiles();
          for (const p of all) {
            try {
              if (new URL(p.origin).host === wsUrl.host) {
                matchedProfile = p;
                break;
              }
            } catch {}
          }
        }

        if (!matchedProfile) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        const headers: Record<string, string> = { ...details.requestHeaders };

        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'origin') {
            delete headers[k];
          }
        }
        headers['Origin'] = new URL(matchedProfile.origin).origin;

        const jarCookie = this.getCookieHeader(matchedProfile.id);
        if (jarCookie) {
          let existingCookieKey: string | null = null;
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'cookie') {
              existingCookieKey = k;
              break;
            }
          }

          if (existingCookieKey) {
            const existingVal = headers[existingCookieKey] ?? '';
            const map = new Map<string, string>();
            for (const part of existingVal.split(';')) {
              const p = part.trim();
              const eq = p.indexOf('=');
              if (eq > 0)
                map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
            }
            const jarMap = this.cookieJars.get(matchedProfile.id);
            if (jarMap) {
              for (const [k, v] of jarMap.entries()) map.set(k, v);
            }
            headers[existingCookieKey] = Array.from(map.entries())
              .map(([k, v]) => `${k}=${v}`)
              .join('; ');
          } else {
            headers['Cookie'] = jarCookie;
          }
        }

        // The shell page holds no token, so it cannot build the `?token=` a
        // browser socket uses. The server accepts the host token in this header
        // on upgrades only; a URL rewrite is not available (Chromium drops
        // `onBeforeRequest` redirects for WebSocket handshakes).
        // A page-supplied value is always dropped: only the host may set this
        // header, so a renderer cannot choose its socket credential.
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === SOCKET_TOKEN_HEADER.toLowerCase()) {
            delete headers[k];
          }
        }
        const isSocketPath =
          wsUrl.pathname === '/ws' || wsUrl.pathname.startsWith('/ws/');
        const hostToken = isSocketPath
          ? (this.auth?.getToken(matchedProfile.origin) ?? null)
          : null;
        if (hostToken) headers[SOCKET_TOKEN_HEADER] = hostToken;

        callback({ requestHeaders: headers });
      },
    );
  }

  // --- Request Routing & Handling ---

  async handleRequest(req: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (url.protocol !== `${EMBEDDED_SCHEME}:` || url.host !== EMBEDDED_HOST) {
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return this.handleApiProxy(req, url);
    }

    if (url.pathname === '/__phi/active') {
      if (req.method === 'POST') {
        return this.handleSetActive(req);
      }
      if (req.method === 'GET') {
        return this.handleGetActive();
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/__phi/compat') {
      if (req.method === 'GET') {
        return this.handleGetCompat(url);
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname.startsWith('/__phi/')) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return this.handleStaticFile(req, url);
  }

  // --- Internal Route Handlers ---

  private async handleSetActive(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (typeof body !== 'object' || body === null) {
      return new Response(
        JSON.stringify({ error: 'request body must be an object' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    const { profileId } = body as { profileId?: unknown };

    if (profileId === null) {
      this.activeProfileId = null;
      return new Response(
        JSON.stringify({ ok: true, profileId: null, origin: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (typeof profileId === 'string') {
      const profile = this.resolveProfile(profileId);
      if (!profile) {
        return new Response(JSON.stringify({ error: 'unknown profile' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      this.activeProfileId = profile.id;
      return new Response(
        JSON.stringify({
          ok: true,
          profileId: profile.id,
          origin: profile.origin,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: 'profileId must be a string or null' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  private handleGetActive(): Response {
    if (this.activeProfileId === null) {
      return new Response(JSON.stringify({ profileId: null, origin: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const profile = this.resolveProfile(this.activeProfileId);
    if (!profile) {
      return new Response(JSON.stringify({ profileId: null, origin: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ profileId: profile.id, origin: profile.origin }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  private async handleGetCompat(url: URL): Promise<Response> {
    const targetId = url.searchParams.get('id') || this.activeProfileId;
    if (!targetId) {
      return new Response(
        JSON.stringify({ error: 'no profile specified or active' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const profile = this.resolveProfile(targetId);
    if (!profile) {
      return new Response(JSON.stringify({ error: 'unknown profile' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const versionUrl = new URL('/api/version', profile.origin);
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      const cookie = this.getCookieHeader(profile.id);
      if (cookie) {
        headers['Cookie'] = cookie;
      }

      const res = await this.fetchImpl(versionUrl.toString(), {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        return new Response(
          JSON.stringify({ compatible: false, api: null, version: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const data = (await res.json()) as { api?: unknown; version?: unknown };
      const apiStr = typeof data?.api === 'string' ? data.api : null;
      const versionStr =
        typeof data?.version === 'string' ? data.version : null;
      const compatible = apiStr === '1';

      return new Response(
        JSON.stringify({ compatible, api: apiStr, version: versionStr }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } catch {
      return new Response(
        JSON.stringify({ compatible: false, api: null, version: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  private async handleApiProxy(req: Request, url: URL): Promise<Response> {
    const backendHeader = req.headers.get('x-phi-backend')?.trim();
    const profileId =
      backendHeader && backendHeader.length > 0
        ? backendHeader
        : this.activeProfileId;

    if (!profileId) {
      return new Response(
        JSON.stringify({ error: 'unknown backend profile' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    const profile = this.resolveProfile(profileId);
    if (!profile) {
      return new Response(
        JSON.stringify({ error: 'unknown backend profile' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // An unlock for this origin may be in flight. Let it finish before
    // answering, so the page never sees "not authenticated" for a server
    // the desktop is authenticating right now.
    await this.waitForAuth(profile.origin);

    const rawUrl = typeof req.url === 'string' ? req.url : '';
    const qIdx = rawUrl.indexOf('?');
    const rawPathPart = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    let decodedPathname = url.pathname;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid API path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (
      rawPathPart.includes('/..') ||
      rawPathPart.includes('\\..') ||
      /(?:^|[/\\])(?:\.|%2e){2}(?:[/\\]|$)/i.test(rawPathPart) ||
      /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(decodedPathname)
    ) {
      return new Response(JSON.stringify({ error: 'invalid API path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(url.pathname + url.search, profile.origin);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid upstream URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let profileOrigin: string;
    try {
      profileOrigin = new URL(profile.origin).origin;
    } catch {
      return new Response(JSON.stringify({ error: 'invalid profile origin' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (
      targetUrl.origin !== profileOrigin ||
      (targetUrl.pathname !== '/api' && !targetUrl.pathname.startsWith('/api/'))
    ) {
      return new Response(JSON.stringify({ error: 'invalid API path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Section 6's request/response table. The page never supplies a
    // credential, so each row decides what the host attaches.
    const row = authProxyRow(targetUrl.pathname, req.method);
    if (row === 'refresh') return this.handleV2Refresh(profile);
    if (row === 'login' || row === 'password') {
      return this.handleV2CredentialRow(req, targetUrl, profile);
    }
    if (row === 'logout') return this.handleV2Logout(req, targetUrl, profile);
    return this.forwardApiRow(req, targetUrl, profile, row);
  }

  /**
   * The refresh row: the page's request never reaches the server. Refresh runs
   * through the host owner (one single-flight per origin), so a renderer reload
   * cannot consume the same handle twice, and only a terminal `401` drops the
   * bundle. The page gets a token-free answer either way.
   */
  private async handleV2Refresh(profile: EmbeddedProfile): Promise<Response> {
    if (!this.auth) return tokenFreeError('unavailable', 503);
    const result = await this.auth.refreshAccess(profile.origin);
    if (result.kind === 'ok') return tokenFreeJSON(REFRESH_OK_BODY, 200);
    if (result.kind === 'unauthorized') {
      return tokenFreeError('unauthorized', 401);
    }
    // Every other outcome keeps the bundle: the page retries with backoff and
    // must not be told to sign in.
    const headers: Record<string, string> = {};
    if (
      result.kind === 'unavailable' &&
      typeof result.retryAfterMs === 'number' &&
      result.retryAfterMs > 0
    ) {
      headers['Retry-After'] = String(Math.ceil(result.retryAfterMs / 1000));
    }
    return tokenFreeError('unavailable', 503, headers);
  }

  /**
   * The login and password rows. The body is forwarded unchanged; the row
   * decides which credential the host attaches, and a credential-bearing body
   * is consumed here and replaced by the exact token-free answer.
   */
  private async handleV2CredentialRow(
    req: Request,
    targetUrl: URL,
    profile: EmbeddedProfile,
  ): Promise<Response> {
    const body = await readRequestBody(req);
    const headers = this.buildForwardHeaders(req, profile, {
      jsonContentType: true,
      // A login carries no access credential even when the host holds one.
      bearer: null,
      v2: true,
    });
    // The password route requires a bearer once the server is enabled: without
    // this row the shell could neither change nor clear its own password.
    const hostToken = this.auth?.getToken(profile.origin) ?? null;
    if (hostToken && isPasswordRoute(targetUrl.pathname)) {
      headers.set('Authorization', `Bearer ${hostToken}`);
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchImpl(targetUrl.toString(), {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch {
      return tokenFreeError('upstream request failed', 502);
    }
    for (const sc of readSetCookieHeaders(upstreamRes)) {
      this.applySetCookieHeader(profile.id, sc);
    }

    if (!upstreamRes.ok) return authFailureResponse(upstreamRes);

    const raw = await readBoundedText(upstreamRes);
    if (raw === 'oversized')
      return tokenFreeError('invalid credential response', 502);
    let payload: unknown;
    try {
      payload = raw === null ? null : JSON.parse(raw);
    } catch {
      return tokenFreeError('invalid credential response', 502);
    }

    // Clear: the credential is gone server-side, and the host drops its own.
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).enabled === false
    ) {
      return tokenFreeJSON(CLEARED_BODY, 200);
    }

    const bundle = parseCredentialBundle(
      payload,
      parseRefreshHandle(upstreamRes),
    );
    // A malformed or oversized bundle is a host error. It must never reach the
    // page, and it must never displace a working credential.
    if (!bundle) return tokenFreeError('invalid credential response', 502);
    if (!this.auth?.installBundle(profile.origin, bundle)) {
      return tokenFreeError('unable to install credential', 503);
    }
    return tokenFreeJSON(ENABLED_BODY, 200);
  }

  /** The logout row: host bearer only, and the bundle drops on confirmation. */
  private async handleV2Logout(
    req: Request,
    targetUrl: URL,
    profile: EmbeddedProfile,
  ): Promise<Response> {
    const body = await readRequestBody(req);
    const headers = this.buildForwardHeaders(req, profile, {
      jsonContentType: true,
      bearer: this.auth?.getToken(profile.origin) ?? null,
      v2: true,
    });
    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchImpl(targetUrl.toString(), {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch {
      return tokenFreeError('upstream request failed', 502);
    }
    for (const sc of readSetCookieHeaders(upstreamRes)) {
      this.applySetCookieHeader(profile.id, sc);
    }
    if (!upstreamRes.ok) return authFailureResponse(upstreamRes);
    if (this.auth) await this.auth.logout(profile.origin, false);
    return tokenFreeJSON(LOGOUT_OK_BODY, 200);
  }

  /**
   * The rows that are plain forwarding: the v2 status row (host-authenticated so
   * the proxied answer reflects the host's session) and every other `/api/*`
   * row. Both strip the page's credential and browser-metadata headers; only the
   * host bearer differs, and an unprotected route ignores it.
   */
  private async forwardApiRow(
    req: Request,
    targetUrl: URL,
    profile: EmbeddedProfile,
    _row: AuthProxyRow,
  ): Promise<Response> {
    const body = await readRequestBody(req);
    const hostToken = this.auth?.getToken(profile.origin) ?? null;
    const headers = this.buildForwardHeaders(req, profile, {
      jsonContentType: false,
      bearer: hostToken,
      v2: false,
    });

    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchImpl(targetUrl.toString(), {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch {
      return new Response(
        JSON.stringify({
          error: 'upstream request failed',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    for (const sc of readSetCookieHeaders(upstreamRes)) {
      this.applySetCookieHeader(profile.id, sc);
    }

    const clientHeaders = new Headers();
    upstreamRes.headers.forEach((val, key) => {
      if (key.toLowerCase() !== 'set-cookie') {
        clientHeaders.set(key, val);
      }
    });

    const isNoBodyStatus =
      upstreamRes.status === 204 ||
      upstreamRes.status === 304 ||
      req.method === 'HEAD';

    return new Response(isNoBodyStatus ? null : upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: clientHeaders,
    });
  }

  /**
   * The headers every proxied row sends. The page's own credential, cookie and
   * browser-metadata headers are always dropped: the renderer cannot choose its
   * credential, and a `phi-app://app` page presents Fetch-Metadata the server
   * rejects.
   */
  private buildForwardHeaders(
    req: Request,
    profile: EmbeddedProfile,
    options: { jsonContentType: boolean; bearer: string | null; v2: boolean },
  ): Headers {
    const headers = new Headers();
    const stripped = new Set([
      'x-phi-backend',
      'host',
      'origin',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'cookie',
      'authorization',
      V2_CSRF_HEADER.toLowerCase(),
      SOCKET_TOKEN_HEADER.toLowerCase(),
      'connection',
      'content-length',
    ]);
    req.headers.forEach((val, key) => {
      if (!stripped.has(key.toLowerCase())) headers.set(key, val);
    });
    if (options.jsonContentType) {
      headers.set('Content-Type', 'application/json');
    }
    if (options.v2) {
      headers.set(V2_CSRF_HEADER, V2_CSRF_VALUE);
    }
    if (options.bearer) {
      headers.set('Authorization', `Bearer ${options.bearer}`);
    }
    const jarCookie = this.getCookieHeader(profile.id);
    if (jarCookie) headers.set('Cookie', jarCookie);
    return headers;
  }

  private handleStaticFile(req: Request, url: URL): Response {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '';
    if (
      rawUrl.includes('/..') ||
      rawUrl.includes('\\..') ||
      rawUrl.includes('%2e%2e') ||
      rawUrl.includes('%2E%2E') ||
      rawUrl.includes('..%2f') ||
      rawUrl.includes('..%2F')
    ) {
      return new Response('Forbidden', { status: 403 });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (decodedPath.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    let relativePath = decodedPath;
    if (relativePath === '/' || relativePath === '') {
      relativePath = '/index.html';
    }

    const normalizedRel = relativePath.replace(/^[/\\]+/, '');
    const normalizedEmbeddedDir = this.embeddedDir;
    const safePrefix = normalizedEmbeddedDir.endsWith(path.sep)
      ? normalizedEmbeddedDir
      : normalizedEmbeddedDir + path.sep;

    const filePath = path.resolve(normalizedEmbeddedDir, normalizedRel);

    if (
      filePath !== normalizedEmbeddedDir &&
      !filePath.startsWith(safePrefix)
    ) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!existsSync(filePath)) {
      return new Response('Not Found', { status: 404 });
    }

    let resolvedFile = filePath;
    const stat = statSync(resolvedFile);
    if (stat.isDirectory()) {
      const indexFile = path.join(resolvedFile, 'index.html');
      if (existsSync(indexFile)) {
        resolvedFile = indexFile;
      } else {
        return new Response('Not Found', { status: 404 });
      }
    }

    const ext = path.extname(resolvedFile).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const body = readFileSync(resolvedFile);

    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
    });

    return new Response(req.method === 'HEAD' ? null : body, {
      status: 200,
      headers,
    });
  }
}
