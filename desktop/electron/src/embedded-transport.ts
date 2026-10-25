/**
 * Main-process embedded transport for the single-tab embedded Phi desktop.
 *
 * Owns the privileged `phi-app://app/` scheme handler, static asset serving
 * from `embedded/`, backend `/api/*` proxy with per-profile cookie jars,
 * `/__phi/active` profile switching, `/__phi/compat` compatibility probing,
 * and the scoped WebSocket origin/cookie header bridge.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSetCookieHeaders } from './access-auth.js';

export const EMBEDDED_SCHEME = 'phi-app';
export const EMBEDDED_HOST = 'app';
export const EMBEDDED_ORIGIN = 'phi-app://app';
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

  constructor(options: EmbeddedTransportOptions) {
    this.embeddedDir = path.resolve(options.embeddedDir);
    this.resolveProfile = options.resolveProfile;
    this.listProfiles = options.listProfiles;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
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

      // Locked behind access-auth: stay in embedded mode so normal auth flow handles it.
      if (res.status === 401) {
        return true;
      }

      // If res.ok (200), check data?.api === '1'.
      // If it is 200 but doesn't have api === '1', it is an older incompatible server.
      if (res.ok) {
        try {
          const data = (await res.json()) as { api?: unknown };
          return data?.api === '1';
        } catch {
          return false;
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

    const forwardHeaders = new Headers();
    const stripped = new Set([
      'x-phi-backend',
      'host',
      'origin',
      'cookie',
      'connection',
      'content-length',
    ]);

    req.headers.forEach((val, key) => {
      if (!stripped.has(key.toLowerCase())) {
        forwardHeaders.set(key, val);
      }
    });

    forwardHeaders.set('Origin', new URL(profile.origin).origin);

    const jarCookie = this.getCookieHeader(profile.id);
    const incomingCookie = req.headers.get('cookie');
    let finalCookie = '';
    if (incomingCookie && jarCookie) {
      const map = new Map<string, string>();
      for (const part of incomingCookie.split(';')) {
        const p = part.trim();
        const eq = p.indexOf('=');
        if (eq > 0) map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
      }
      const jarMap = this.cookieJars.get(profile.id);
      if (jarMap) {
        for (const [k, v] of jarMap.entries()) map.set(k, v);
      }
      finalCookie = Array.from(map.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    } else {
      finalCookie = jarCookie || incomingCookie || '';
    }
    if (finalCookie) {
      forwardHeaders.set('Cookie', finalCookie);
    }

    let body: BodyInit | undefined = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (typeof req.arrayBuffer === 'function') {
        try {
          const buf = await req.arrayBuffer();
          if (buf.byteLength > 0) {
            body = buf;
          }
        } catch {
          /* ignore body read error */
        }
      } else if ((req as unknown as { body?: BodyInit }).body !== undefined) {
        body = (req as unknown as { body?: BodyInit }).body;
      }
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchImpl(targetUrl.toString(), {
        method: req.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual',
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'upstream request failed',
          message: String(err),
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    const setCookies = readSetCookieHeaders(upstreamRes);
    for (const sc of setCookies) {
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
