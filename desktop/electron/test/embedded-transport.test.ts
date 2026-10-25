// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDED_HOST,
  EMBEDDED_ORIGIN,
  EMBEDDED_PARTITION,
  EMBEDDED_SCHEME,
  type EmbeddedProfile,
  EmbeddedTransport,
  registerEmbeddedScheme,
} from '../src/embedded-transport.js';

describe('embedded-transport', () => {
  let tempDir: string;
  let profiles: Map<string, EmbeddedProfile>;
  let transport: EmbeddedTransport;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phi-embedded-test-'));
    profiles = new Map([
      ['prof1', { id: 'prof1', origin: 'http://127.0.0.1:8080' }],
      ['prof2', { id: 'prof2', origin: 'https://backend2.example.com:8443' }],
    ]);
    mockFetch = vi.fn();
    transport = new EmbeddedTransport({
      embeddedDir: tempDir,
      resolveProfile: (id) => profiles.get(id) ?? null,
      listProfiles: () => Array.from(profiles.values()),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('constants & scheme registration', () => {
    it('exports expected protocol and partition constants', () => {
      expect(EMBEDDED_SCHEME).toBe('phi-app');
      expect(EMBEDDED_HOST).toBe('app');
      expect(EMBEDDED_ORIGIN).toBe('phi-app://app');
      expect(EMBEDDED_PARTITION).toBe('persist:phi-embedded');
    });

    it('registerEmbeddedScheme registers phi-app as privileged with required flags', () => {
      const mockProtocol = {
        registerSchemesAsPrivileged: vi.fn(),
      };
      registerEmbeddedScheme(mockProtocol);

      expect(mockProtocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
      expect(mockProtocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
        {
          scheme: 'phi-app',
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
          },
        },
      ]);
    });
  });

  describe('static file serving', () => {
    beforeEach(() => {
      writeFileSync(
        path.join(tempDir, 'index.html'),
        '<!doctype html><title>Phi</title>',
      );
      writeFileSync(path.join(tempDir, 'style.css'), 'body { color: red; }');
      writeFileSync(path.join(tempDir, 'app.js'), 'console.log("phi");');
      writeFileSync(path.join(tempDir, 'manifest.json'), '{"name":"phi"}');
      writeFileSync(path.join(tempDir, 'icon.svg'), '<svg></svg>');
    });

    it('serves / as /index.html with text/html content-type', async () => {
      const req = new Request('phi-app://app/');
      const res = await transport.handleRequest(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const text = await res.text();
      expect(text).toBe('<!doctype html><title>Phi</title>');
    });

    it('handles HEAD request on static file with 200 and no body', async () => {
      const req = new Request('phi-app://app/index.html', { method: 'HEAD' });
      const res = await transport.handleRequest(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const text = await res.text();
      expect(text).toBe('');
    });

    it('serves css, js, json, svg with correct MIME types', async () => {
      const cssRes = await transport.handleRequest(
        new Request('phi-app://app/style.css'),
      );
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get('content-type')).toBe(
        'text/css; charset=utf-8',
      );

      const jsRes = await transport.handleRequest(
        new Request('phi-app://app/app.js'),
      );
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );

      const jsonRes = await transport.handleRequest(
        new Request('phi-app://app/manifest.json'),
      );
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );

      const svgRes = await transport.handleRequest(
        new Request('phi-app://app/icon.svg'),
      );
      expect(svgRes.status).toBe(200);
      expect(svgRes.headers.get('content-type')).toBe('image/svg+xml');
    });

    it('returns 404 when scheme or host does not match phi-app://app', async () => {
      const resOtherHost = await transport.handleRequest(
        new Request('phi-app://other-host/index.html'),
      );
      expect(resOtherHost.status).toBe(404);

      const resOtherScheme = await transport.handleRequest(
        new Request('http://app/index.html'),
      );
      expect(resOtherScheme.status).toBe(404);
    });

    it('serves font and media assets with correct MIME types', async () => {
      writeFileSync(path.join(tempDir, 'font.woff'), 'woff');
      writeFileSync(path.join(tempDir, 'font.woff2'), 'woff2');
      writeFileSync(path.join(tempDir, 'font.ttf'), 'ttf');
      writeFileSync(path.join(tempDir, 'doc.pdf'), '%PDF-1.4');
      writeFileSync(path.join(tempDir, 'track.mp3'), 'mp3');
      writeFileSync(path.join(tempDir, 'clip.mp4'), 'mp4');

      const woffRes = await transport.handleRequest(
        new Request('phi-app://app/font.woff'),
      );
      expect(woffRes.headers.get('content-type')).toBe('font/woff');

      const woff2Res = await transport.handleRequest(
        new Request('phi-app://app/font.woff2'),
      );
      expect(woff2Res.headers.get('content-type')).toBe('font/woff2');

      const ttfRes = await transport.handleRequest(
        new Request('phi-app://app/font.ttf'),
      );
      expect(ttfRes.headers.get('content-type')).toBe('font/ttf');

      const pdfRes = await transport.handleRequest(
        new Request('phi-app://app/doc.pdf'),
      );
      expect(pdfRes.headers.get('content-type')).toBe('application/pdf');

      const mp3Res = await transport.handleRequest(
        new Request('phi-app://app/track.mp3'),
      );
      expect(mp3Res.headers.get('content-type')).toBe('audio/mpeg');

      const mp4Res = await transport.handleRequest(
        new Request('phi-app://app/clip.mp4'),
      );
      expect(mp4Res.headers.get('content-type')).toBe('video/mp4');
    });

    it('returns 404 for missing static files', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/missing.txt'),
      );
      expect(res.status).toBe(404);
    });

    it('returns 405 for POST/PUT on static files', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/index.html', {
          method: 'POST',
          body: 'abc',
        }),
      );
      expect(res.status).toBe(405);
    });

    it('rejects path traversal attempts strictly (returning 403 or 404)', async () => {
      const traversalAttempts = [
        'phi-app://app/../../package.json',
        'phi-app://app/%2e%2e/%2e%2e/package.json',
        'phi-app://app/%2E%2E/%2E%2E/package.json',
        'phi-app://app/..%2f..%2fpackage.json',
        'phi-app://app/sub/../../../etc/passwd',
      ];

      for (const uri of traversalAttempts) {
        const res = await transport.handleRequest(new Request(uri));
        expect([403, 404]).toContain(res.status);
      }
    });
  });

  describe('/__phi/active routing', () => {
    it('initially returns null active profile', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/__phi/active'),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ profileId: null, origin: null });
    });

    it('sets active profile for valid profileId', async () => {
      const setReq = new Request('phi-app://app/__phi/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'prof1' }),
      });
      const setRes = await transport.handleRequest(setReq);
      expect(setRes.status).toBe(200);
      const setData = await setRes.json();
      expect(setData).toEqual({
        ok: true,
        profileId: 'prof1',
        origin: 'http://127.0.0.1:8080',
      });

      const getRes = await transport.handleRequest(
        new Request('phi-app://app/__phi/active'),
      );
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData).toEqual({
        profileId: 'prof1',
        origin: 'http://127.0.0.1:8080',
      });
    });

    it('returns 404 when setting an unknown profileId', async () => {
      const setReq = new Request('phi-app://app/__phi/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'nonexistent' }),
      });
      const setRes = await transport.handleRequest(setReq);
      expect(setRes.status).toBe(404);
    });

    it('allows resetting active profile to null', async () => {
      // First set prof1
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      // Now reset with null
      const resetRes = await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: null }),
        }),
      );
      expect(resetRes.status).toBe(200);
      expect(await resetRes.json()).toEqual({
        ok: true,
        profileId: null,
        origin: null,
      });

      const getRes = await transport.handleRequest(
        new Request('phi-app://app/__phi/active'),
      );
      expect(await getRes.json()).toEqual({ profileId: null, origin: null });
    });

    it('rejects malformed bodies with 400', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not a json',
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('/api/* proxy', () => {
    it('returns 404 when no active backend profile is configured and no X-Phi-Backend header is set', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/api/config'),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown backend profile' });
    });

    it('uses active profile by default', async () => {
      // Set active profile to prof1
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Workspace 1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await transport.handleRequest(
        new Request('phi-app://app/api/config?extra=1'),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ title: 'Workspace 1' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('http://127.0.0.1:8080/api/config?extra=1');
      expect(calledOpts.method).toBe('GET');
      expect(calledOpts.redirect).toBe('manual');
      expect(calledOpts.headers.get('Origin')).toBe('http://127.0.0.1:8080');
    });

    it('X-Phi-Backend header overrides the active profile', async () => {
      // Active profile is prof1
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Backend 2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await transport.handleRequest(
        new Request('phi-app://app/api/terminals', {
          headers: { 'X-Phi-Backend': 'prof2' },
        }),
      );
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://backend2.example.com:8443/api/terminals');
      expect(calledOpts.headers.get('Origin')).toBe(
        'https://backend2.example.com:8443',
      );
      expect(calledOpts.headers.get('x-phi-backend')).toBeNull();
    });

    it('returns 404 when X-Phi-Backend points to unknown profile', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/api/terminals', {
          headers: { 'X-Phi-Backend': 'unknown_profile' },
        }),
      );
      expect(res.status).toBe(404);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('forwards POST method and body payload, and strips unsafe headers', async () => {
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const postBody = JSON.stringify({ command: 'bash' });
      const req = new Request('phi-app://app/api/spawn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: 'app',
          Origin: 'phi-app://app',
          'X-Custom-Header': 'keep-me',
          Connection: 'keep-alive',
          'Content-Length': String(postBody.length),
        },
        body: postBody,
      });

      const res = await transport.handleRequest(req);
      expect(res.status).toBe(201);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, calledOpts] = mockFetch.mock.calls[0];
      expect(calledOpts.method).toBe('POST');
      expect(calledOpts.headers.get('X-Custom-Header')).toBe('keep-me');
      expect(calledOpts.headers.get('Host')).toBeNull();
      expect(calledOpts.headers.get('Origin')).toBe('http://127.0.0.1:8080');
      expect(calledOpts.headers.get('Connection')).toBeNull();
      expect(calledOpts.headers.get('Content-Length')).toBeNull();
    });

    it('rejects path traversal escaping /api/ and never calls fetchImpl', async () => {
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      const maliciousPaths = [
        'phi-app://app/api/../../secret',
        'phi-app://app/api/%2e%2e/secret',
        'phi-app://app/api/%2E%2E/%2E%2E/secret',
        'phi-app://app/api/..%2fsecret',
      ];

      for (const uri of maliciousPaths) {
        const res = await transport.handleRequest(new Request(uri));
        expect([400, 403, 404]).toContain(res.status);
      }

      expect(mockFetch).not.toHaveBeenCalled();

      // Legitimate dots / double-dots in query parameters (e.g. git rev ranges) must be allowed
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const validQueryRes = await transport.handleRequest(
        new Request(
          'phi-app://app/api/git/raw-diff?rev=main..HEAD&file=foo%2ebar.ts',
        ),
      );
      expect(validQueryRes.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('cookie jar handling', () => {
    it('captures Set-Cookie on login response, strips it from client response, and attaches Cookie on subsequent requests', async () => {
      await transport.handleRequest(
        new Request('phi-app://app/__phi/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof1' }),
        }),
      );

      // 1. Upstream login sets cookie
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ user: 'alice' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie':
              'auth_token=secret123; Path=/; HttpOnly; SameSite=Strict',
          },
        }),
      );

      const loginRes = await transport.handleRequest(
        new Request('phi-app://app/api/login', { method: 'POST', body: '{}' }),
      );
      expect(loginRes.status).toBe(200);
      // Stripped from client response
      expect(loginRes.headers.get('set-cookie')).toBeNull();

      // 2. Subsequent request to same profile attaches cookie
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const nextRes = await transport.handleRequest(
        new Request('phi-app://app/api/status'),
      );
      expect(nextRes.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, nextOpts] = mockFetch.mock.calls[1];
      expect(nextOpts.headers.get('Cookie')).toBe('auth_token=secret123');
    });

    it('isolates cookies between Profile A and Profile B', async () => {
      // Set cookie on prof1
      transport.setCookie('prof1', 'phi_sess', 'token_prof1');
      // Set cookie on prof2
      transport.setCookie('prof2', 'phi_sess', 'token_prof2');

      expect(transport.getCookieHeader('prof1')).toBe('phi_sess=token_prof1');
      expect(transport.getCookieHeader('prof2')).toBe('phi_sess=token_prof2');

      // Request targeted to prof1
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await transport.handleRequest(
        new Request('phi-app://app/api/test', {
          headers: { 'X-Phi-Backend': 'prof1' },
        }),
      );
      expect(mockFetch.mock.calls[0][1].headers.get('Cookie')).toBe(
        'phi_sess=token_prof1',
      );

      // Request targeted to prof2
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await transport.handleRequest(
        new Request('phi-app://app/api/test', {
          headers: { 'X-Phi-Backend': 'prof2' },
        }),
      );
      expect(mockFetch.mock.calls[1][1].headers.get('Cookie')).toBe(
        'phi_sess=token_prof2',
      );
    });

    it('deletes cookie on Max-Age=0 or negative or empty value, and supports clearCookies', () => {
      transport.setCookie('prof1', 'sess', '123');
      transport.setCookie('prof1', 'prefs', 'dark');
      expect(transport.getCookieHeader('prof1')).toContain('sess=123');
      expect(transport.getCookieHeader('prof1')).toContain('prefs=dark');

      // Max-Age=0 deletion
      transport.applySetCookieHeader(
        'prof1',
        'sess=deleted; Max-Age=0; Path=/',
      );
      expect(transport.getCookieHeader('prof1')).toBe('prefs=dark');

      // Empty value deletion
      transport.setCookie('prof1', 'prefs', '');
      expect(transport.getCookieHeader('prof1')).toBe('');

      // Add back and clearCookies
      transport.setCookie('prof1', 'c1', 'v1');
      transport.clearCookies('prof1');
      expect(transport.getCookieHeader('prof1')).toBe('');
    });
  });

  describe('/__phi/compat probe', () => {
    it('returns compatible: true when /api/version returns api: "1"', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ api: '1', version: '0.25.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=prof1'),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        compatible: true,
        api: '1',
        version: '0.25.0',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/api/version',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns compatible: false when api field is missing or different', async () => {
      // Missing api field (legacy server)
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ version: '0.24.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res1 = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=prof1'),
      );
      expect(res1.status).toBe(200);
      expect(await res1.json()).toEqual({
        compatible: false,
        api: null,
        version: '0.24.0',
      });

      // Incompatible api version
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ api: '2', version: '0.26.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res2 = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=prof1'),
      );
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({
        compatible: false,
        api: '2',
        version: '0.26.0',
      });
    });

    it('never throws on network error or HTTP failure, returning compatible: false', async () => {
      // 500 error
      mockFetch.mockResolvedValueOnce(
        new Response('Server Error', { status: 500 }),
      );
      const res500 = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=prof1'),
      );
      expect(res500.status).toBe(200);
      expect(await res500.json()).toEqual({
        compatible: false,
        api: null,
        version: null,
      });

      // Network exception
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const resErr = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=prof1'),
      );
      expect(resErr.status).toBe(200);
      expect(await resErr.json()).toEqual({
        compatible: false,
        api: null,
        version: null,
      });
    });

    it('returns 404 when profile cannot be resolved', async () => {
      const res = await transport.handleRequest(
        new Request('phi-app://app/__phi/compat?id=unknown'),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('WebSocket header bridge', () => {
    it('rewrites Origin and injects Cookie when webContentsId and origin host match', () => {
      let listener:
        | ((
            details: {
              url: string;
              webContentsId?: number;
              requestHeaders: Record<string, string>;
            },
            callback: (resp: {
              requestHeaders?: Record<string, string>;
            }) => void,
          ) => void)
        | undefined;

      const mockSession = {
        webRequest: {
          onBeforeSendHeaders: vi.fn((_filter, l) => {
            listener = l;
          }),
        },
      };

      transport.attachWebSocketHeaderBridge(mockSession, () => 42);
      expect(mockSession.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(
        1,
      );
      expect(listener).toBeDefined();

      // Set cookies for prof1 and prof2
      transport.setCookie('prof1', 'ws_token', 'token_42');
      transport.setCookie('prof2', 'ws_token', 'token_99');

      // Set active profile to prof1
      transport.setCookie('prof1', 'auth', 'val1');

      // Test matched webContentsId and matched prof1 host
      let resultHeaders: Record<string, string> | undefined;
      listener!(
        {
          url: 'ws://127.0.0.1:8080/terminals/ws/1',
          webContentsId: 42,
          requestHeaders: {
            origin: 'phi-app://app',
            'user-agent': 'TestClient',
          },
        },
        (resp) => {
          resultHeaders = resp.requestHeaders;
        },
      );

      expect(resultHeaders).toBeDefined();
      expect(resultHeaders!['Origin']).toBe('http://127.0.0.1:8080');
      expect(resultHeaders!['origin']).toBeUndefined();
      expect(resultHeaders!['user-agent']).toBe('TestClient');
      expect(resultHeaders!['Cookie']).toContain('ws_token=token_42');
      expect(resultHeaders!['Cookie']).toContain('auth=val1');
    });

    it('leaves headers untouched when webContentsId does not match', () => {
      let listener: ((details: any, callback: any) => void) | undefined;
      const mockSession = {
        webRequest: {
          onBeforeSendHeaders: vi.fn((_filter, l) => {
            listener = l;
          }),
        },
      };

      transport.attachWebSocketHeaderBridge(mockSession, () => 42);
      transport.setCookie('prof1', 'token', 'abc');

      let resultHeaders: Record<string, string> | undefined;
      listener!(
        {
          url: 'ws://127.0.0.1:8080/ws',
          webContentsId: 99, // mismatch!
          requestHeaders: {
            origin: 'phi-app://app',
          },
        },
        (resp: any) => {
          resultHeaders = resp.requestHeaders;
        },
      );

      expect(resultHeaders).toEqual({ origin: 'phi-app://app' });
    });

    it('leaves headers untouched when host does not match any profile', () => {
      let listener: ((details: any, callback: any) => void) | undefined;
      const mockSession = {
        webRequest: {
          onBeforeSendHeaders: vi.fn((_filter, l) => {
            listener = l;
          }),
        },
      };

      transport.attachWebSocketHeaderBridge(mockSession, () => 42);

      let resultHeaders: Record<string, string> | undefined;
      listener!(
        {
          url: 'ws://unknown-host.example.com/ws',
          webContentsId: 42,
          requestHeaders: {
            origin: 'phi-app://app',
          },
        },
        (resp: any) => {
          resultHeaders = resp.requestHeaders;
        },
      );

      expect(resultHeaders).toEqual({ origin: 'phi-app://app' });
    });

    it('matches non-active profile via listProfiles if host matches', () => {
      let listener: ((details: any, callback: any) => void) | undefined;
      const mockSession = {
        webRequest: {
          onBeforeSendHeaders: vi.fn((_filter, l) => {
            listener = l;
          }),
        },
      };

      transport.attachWebSocketHeaderBridge(mockSession, () => 42);
      // Active is prof1, but URL connects to prof2: https://backend2.example.com:8443
      transport.setCookie('prof2', 'cookie2', 'val2');

      let resultHeaders: Record<string, string> | undefined;
      listener!(
        {
          url: 'wss://backend2.example.com:8443/chat',
          webContentsId: 42,
          requestHeaders: {
            origin: 'phi-app://app',
          },
        },
        (resp: any) => {
          resultHeaders = resp.requestHeaders;
        },
      );

      expect(resultHeaders!['Origin']).toBe(
        'https://backend2.example.com:8443',
      );
      expect(resultHeaders!['Cookie']).toBe('cookie2=val2');
    });
  });

  describe('setActiveProfile & getActiveProfileId', () => {
    it('sets and retrieves active profile id directly', () => {
      expect(transport.getActiveProfileId()).toBeNull();
      transport.setActiveProfile('prof1');
      expect(transport.getActiveProfileId()).toBe('prof1');
      transport.setActiveProfile(null);
      expect(transport.getActiveProfileId()).toBeNull();
      transport.setActiveProfile('prof2');
      expect(transport.getActiveProfileId()).toBe('prof2');
      transport.setActiveProfile('');
      expect(transport.getActiveProfileId()).toBeNull();
    });

    it('ignores unknown profile ids when setting', () => {
      transport.setActiveProfile('prof1');
      transport.setActiveProfile('unknown-id');
      expect(transport.getActiveProfileId()).toBe('prof1');
    });
  });

  describe('checkCompatibility', () => {
    it('returns true when /api/version returns 200 with api: "1"', async () => {
      transport.setCookie('prof1', 'phi_session', 'secret123');
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ version: '0.24.0', api: '1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/api/version',
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Cookie: 'phi_session=secret123',
          },
          // The probe never hangs: an unreachable server must not stall a
          // switch.
          signal: expect.anything(),
        },
      );
    });

    it('returns true when /api/version has no api marker (a server from before the marker)', async () => {
      // The marker only exists on servers built after the embedded
      // transport. An older server still serves the same web app, so the
      // embedded page works against it. Falling back to the server's own
      // page costs a FULL page load on every switch, which made a fleet
      // of servers crawl.
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ version: '0.23.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(true);
    });

    it('returns false when /api/version returns 200 with different api version', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ api: '2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(false);
    });

    it('returns true when /api/version returns 200 with a body it cannot read', async () => {
      // An unreadable body is not evidence of incompatibility.
      mockFetch.mockResolvedValueOnce(
        new Response('not-json', {
          status: 200,
        }),
      );

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(true);
    });

    it('returns true when /api/version returns 401 (auth-locked server)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', {
          status: 401,
        }),
      );

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(true);
    });

    it('returns true when network error occurs during fetch', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const compatible = await transport.checkCompatibility('prof1');
      expect(compatible).toBe(true);
    });

    it('returns false when profile cannot be resolved', async () => {
      const compatible = await transport.checkCompatibility('nonexistent');
      expect(compatible).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('capability probe cache', () => {
    it('reuses a fresh answer instead of re-probing the server', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ api: '1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      expect(await transport.checkCompatibility('prof1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // A second flip to the same server must not cost another round trip.
      expect(await transport.checkCompatibility('prof1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('persists a positive answer and reuses it in a new session', async () => {
      const compatPath = path.join(tempDir, 'api-compat.json');
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ api: '1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const first = new EmbeddedTransport({
        embeddedDir: tempDir,
        resolveProfile: (id) => profiles.get(id) ?? null,
        listProfiles: () => Array.from(profiles.values()),
        fetchImpl: mockFetch as unknown as typeof fetch,
        compatCachePath: compatPath,
      });
      expect(await first.checkCompatibility('prof1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // A new session (new transport) must not probe again.
      const second = new EmbeddedTransport({
        embeddedDir: tempDir,
        resolveProfile: (id) => profiles.get(id) ?? null,
        listProfiles: () => Array.from(profiles.values()),
        fetchImpl: mockFetch as unknown as typeof fetch,
        compatCachePath: compatPath,
      });
      expect(await second.checkCompatibility('prof1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('probes each profile separately', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ api: '1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await transport.checkCompatibility('prof1');
      await transport.checkCompatibility('prof2');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('in-flight unlock barrier', () => {
    it('holds proxied requests while an unlock is in flight', async () => {
      // The upstream answers with a session cookie once the unlock lands.
      mockFetch.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      transport.beginAuth('http://127.0.0.1:8080');
      const pending = transport.handleRequest(
        new Request('phi-app://app/api/config', {
          headers: { 'X-Phi-Backend': 'prof1' },
        }),
      );

      // The request must not have been proxied yet.
      expect(mockFetch).not.toHaveBeenCalled();

      transport.endAuth('http://127.0.0.1:8080');
      const res = await pending;
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not hold requests for a different origin', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      transport.beginAuth('https://backend2.example.com:8443');
      const res = await transport.handleRequest(
        new Request('phi-app://app/api/config', {
          headers: { 'X-Phi-Backend': 'prof1' },
        }),
      );
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('releases waiters when the unlock ends', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      transport.beginAuth('http://127.0.0.1:8080/');
      transport.endAuth('http://127.0.0.1:8080');
      const res = await transport.handleRequest(
        new Request('phi-app://app/api/config', {
          headers: { 'X-Phi-Backend': 'prof1' },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('access-session cookie bridge', () => {
    it('seeds a profile jar from a cookie captured in the main process', async () => {
      const ok = transport.setCookieForOrigin(
        'http://127.0.0.1:8080',
        'phi_access_session',
        'session-token',
      );
      expect(ok).toBe(true);

      // The main process can read the cookie back out of the proxy jar.
      const cookie = transport.getCookieForOrigin('http://127.0.0.1:8080');
      expect(cookie?.cookieName).toBe('phi_access_session');
      expect(cookie?.cookieValue).toBe('session-token');
    });

    it('matches an origin with a trailing slash to the profile', () => {
      const ok = transport.setCookieForOrigin(
        'http://127.0.0.1:8080/',
        'phi_access_session',
        'tok',
      );
      expect(ok).toBe(true);
      expect(
        transport.getCookieForOrigin('http://127.0.0.1:8080')?.cookieValue,
      ).toBe('tok');
    });

    it('keeps profiles separate', () => {
      transport.setCookieForOrigin(
        'http://127.0.0.1:8080',
        'phi_access_session',
        'one',
      );
      expect(
        transport.getCookieForOrigin('https://backend2.example.com:8443'),
      ).toBeNull();
    });

    it('returns null for an unknown origin', () => {
      expect(
        transport.setCookieForOrigin(
          'http://unknown.example.com',
          'phi_access_session',
          'x',
        ),
      ).toBe(false);
      expect(
        transport.getCookieForOrigin('http://unknown.example.com'),
      ).toBeNull();
    });
  });
});
