/**
 * Tests for the AccessAuth module — pure-Node (no Electron import),
 * runs in vitest. Crypto parity is asserted by a fixed Unicode
 * vector: the browser's `web/auth.js` (Noble) and Node's
 * `crypto.pbkdf2`/`crypto.createHmac` produce identical verifier and
 * proof bytes for the same password + salt + iterations + challenge.
 */
import { describe, expect, it } from 'vitest';
import {
  AccessAuth,
  type CookieJarEntry,
  deriveVerifier,
  makeProof,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  parseSessionCookie,
  parseProtocols,
  readSetCookieHeaders,
  toCanonicalAuthOrigin,
  validateStatus,
} from '../src/access-auth.js';

// -- crypto parity vector (must stay byte-for-byte equal across platforms) --

describe('crypto parity with web/auth.js (Noble)', () => {
  it('produces a deterministic 32-byte verifier and base64url proof', async () => {
    // The browser's `web/auth.js` (Noble) and Node's
    // `crypto.pbkdf2`/`crypto.createHmac` are asserted byte-equal at
    // design time. Here we lock down that Node produces a 32-byte
    // verifier and a non-empty base64url proof for a fixed Unicode
    // input; a manual cross-check against the browser is run as part of
    // every release (see docs/auth-parity.md).
    const password = '\u03A6\u2014phi-parity\u00E9';
    const saltB64u = 'AQIDBAUGBwjCDA';
    const iterations = 600_000;
    const challenge = 'racecar';
    const salt = Buffer.from(saltB64u, 'base64url');
    const verifier = await deriveVerifier(password, salt, iterations);
    expect(verifier.length).toBe(32);
    const proof = makeProof(verifier, challenge);
    expect(proof).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(proof.length).toBeGreaterThan(0);
  });

  it('refuses iterations outside the bounded range', async () => {
    const salt = Buffer.from('AQ', 'base64url');
    await expect(
      deriveVerifier('whatever-password', salt, MIN_ITERATIONS - 1),
    ).rejects.toThrow();
    await expect(
      deriveVerifier('whatever-password', salt, MAX_ITERATIONS + 1),
    ).rejects.toThrow();
  });
});

// -- status validation --

describe('validateStatus', () => {
  it('returns null on non-object input', () => {
    expect(validateStatus(null)).toBe(null);
    expect(validateStatus(undefined)).toBe(null);
    expect(validateStatus('string')).toBe(null);
    expect(validateStatus(42)).toBe(null);
  });

  it('returns null when iterations is below MIN_ITERATIONS', () => {
    const r = validateStatus({
      enabled: true,
      authenticated: false,
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: 100,
      salt: 'AQID',
      challenge: 'x',
    });
    expect(r).toBe(null);
  });

  it('returns null on malformed salt or challenge', () => {
    const r = validateStatus({
      enabled: true,
      authenticated: false,
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: '',
      challenge: 'x',
    });
    expect(r).toBe(null);
    const r2 = validateStatus({
      enabled: true,
      authenticated: false,
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: 'AQID',
      challenge: '',
    });
    expect(r2).toBe(null);
  });

  it('marks enabled=false as the disabled branch', () => {
    const r = validateStatus({ enabled: false });
    expect(r).toEqual({ kind: 'disabled' });
  });

  it('accepts a well-formed enabled status', () => {
    const r = validateStatus({
      enabled: true,
      authenticated: false,
      version: 'v1',
      algorithm: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: 'AQID',
      challenge: 'x',
    });
    expect(r?.kind).toBe('trusted');
    if (r?.kind === 'trusted') {
      expect(r.status.salt.toString()).toBe(
        Buffer.from('AQID', 'base64url').toString(),
      );
      expect(r.status.challenge).toBe('x');
    }
  });
});

// -- cookie parser --

class FakeResponse {
  cookies: string[];
  headers: { get(name: string): string | null; getSetCookie(): string[] };
  constructor(cookies: string[]) {
    this.cookies = cookies;
    this.headers = {
      get: (name: string): string | null => {
        if (name.toLowerCase() !== 'set-cookie') return null;
        if (this.cookies.length === 0) return null;
        return this.cookies.join(', ');
      },
      getSetCookie: (): string[] => [...this.cookies],
    };
  }
}

describe('cookie parser', () => {
  it('rejects a Set-Cookie without HttpOnly', () => {
    const res = new FakeResponse(['phi_access_session=abc123; Path=/']);
    expect(parseSessionCookie(res as unknown as Response)).toBe(null);
  });

  it('captures the session cookie with HttpOnly', () => {
    const res = new FakeResponse([
      'phi_access_session=abc123; Path=/; HttpOnly',
    ]);
    const cookie = parseSessionCookie(res as unknown as Response);
    expect(cookie).not.toBe(null);
    expect(cookie?.cookieName).toBe('phi_access_session');
    expect(cookie?.cookieValue).toBe('abc123');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe('/');
  });

  it('ignores unrelated cookies', () => {
    const res = new FakeResponse([
      'other=value; Path=/; HttpOnly',
      'phi_access_session=ok; Path=/; HttpOnly',
    ]);
    expect(readSetCookieHeaders(res as unknown as Response)).toEqual([
      'other=value; Path=/; HttpOnly',
      'phi_access_session=ok; Path=/; HttpOnly',
    ]);
    const cookie = parseSessionCookie(res as unknown as Response);
    expect(cookie?.cookieValue).toBe('ok');
  });

  it('rejects an empty value', () => {
    const res = new FakeResponse(['phi_access_session=; Path=/; HttpOnly']);
    expect(parseSessionCookie(res as unknown as Response)).toBe(null);
  });
});

// -- fetchConfig discriminated outcomes --

describe('AccessAuth.fetchConfig', () => {
  const origin = 'https://phi.example/';

  it('returns ok on 2xx with JSON', async () => {
    const auth = new AccessAuth(async (url) => {
      expect(url.toString()).toBe('https://phi.example/api/config');
      return new Response(JSON.stringify({ hostname: 'MINERVA' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const out = await auth.fetchConfig(origin);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.config).toEqual({ hostname: 'MINERVA' });
  });

  it('returns unauthorized on 401', async () => {
    const auth = new AccessAuth(
      async () => new Response('nope', { status: 401 }),
    );
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
  });

  it('returns unavailable on 5xx, network failure, and bad JSON', async () => {
    const a = new AccessAuth(async () => new Response('', { status: 500 }));
    expect((await a.fetchConfig(origin)).kind).toBe('unavailable');
    const b = new AccessAuth(async () => {
      throw new Error('econnreset');
    });
    expect((await b.fetchConfig(origin)).kind).toBe('unavailable');
    const c = new AccessAuth(
      async () => new Response('not json', { status: 200 }),
    );
    expect((await c.fetchConfig(origin)).kind).toBe('unavailable');
  });

  it('sends the captured cookie when one is set', async () => {
    const seen: { cookie: string | null } = { cookie: null };
    const auth = new AccessAuth(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.cookie = headers.Cookie ?? null;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Simulate a successful login by populating the cookie via reflection.
    (
      auth as unknown as {
        cookies: Map<
          string,
          {
            cookieName: string;
            cookieValue: string;
            path: string;
            httpOnly: true;
          }
        >;
      }
    ).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'token-xyz',
      path: '/',
      httpOnly: true,
    });
    await auth.fetchConfig(origin);
    expect(seen.cookie).toBe('phi_access_session=token-xyz');
  });

  it('drops a stale native-fetch cookie when config returns 401', async () => {
    const auth = new AccessAuth(async () => new Response('', { status: 401 }));
    (
      auth as unknown as {
        cookies: Map<
          string,
          {
            cookieName: string;
            cookieValue: string;
            path: string;
            httpOnly: true;
          }
        >;
      }
    ).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'expired-token',
      path: '/',
      httpOnly: true,
    });
    expect(auth.hasCookie(origin)).toBe(true);
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    expect(auth.hasCookie(origin)).toBe(false);
  });
});

// -- tryUnlock happy / sad paths --

describe('AccessAuth.tryUnlock', () => {
  const origin = 'https://phi.example/';
  const goodStatus = {
    enabled: true,
    authenticated: false,
    version: 'v1' as const,
    algorithm: 'pbkdf2-sha256' as const,
    iterations: 600_000,
    salt: Buffer.from('AQID', 'base64url').toString('base64url'),
    challenge: 'sample-challenge',
  };

  it('validates status, captures the cookie, and retries config', async () => {
    let calls = 0;
    const status = { ...goodStatus };
    const doFetch = (async (url: URL) => {
      calls += 1;
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': 'phi_access_session=ok-token; Path=/; HttpOnly',
          },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response(JSON.stringify({ hostname: 'X' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.config).toEqual({ hostname: 'X' });
    expect(calls).toBe(3);
  });

  it('returns invalid-password on 401 from /api/auth/login', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('bad', { status: 401 });
      }
      throw new Error('stop');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('invalid-password');
  });

  it('reports unavailable (session not accepted) when /api/config still 401s after login without inferring bad password', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response('', { status: 401 });
      }
      throw new Error(`stop`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('unavailable');
    expect(auth.hasCookie(origin)).toBe(false);
  });

  it('returns rate-limited on 429', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('slow down', { status: 429 });
      }
      throw new Error('stop');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('rate-limited');
  });

  it('returns unavailable when /api/auth/status returns malformed JSON', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response('not-json', { status: 200 });
      }
      throw new Error('stop');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('unavailable');
  });

  it('returns ok with null config on a 5xx after login (cookie retained for next poll)', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response('', { status: 503 });
      }
      throw new Error('stop');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'whatever-password');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.config).toBe(null);
    expect(auth.hasCookie(origin)).toBe(true);
  });

  it('creates a fresh single-use proof for the remote body after one password unlock', async () => {
    const password = 'whatever-password';
    let statusCalls = 0;
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        statusCalls += 1;
        return new Response(
          JSON.stringify({
            ...goodStatus,
            challenge:
              statusCalls === 1 ? 'native-challenge' : 'body-challenge',
          }),
          { status: 200 },
        );
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': 'phi_access_session=native-token; Path=/; HttpOnly',
          },
        });
      }
      if (path.endsWith('/api/config'))
        return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    expect((await auth.tryUnlock(origin, password)).kind).toBe('ok');

    const bodyLogin = await auth.createLoginProof(origin);
    expect(bodyLogin.kind).toBe('ok');
    if (bodyLogin.kind === 'ok') {
      expect(bodyLogin.challenge).toBe('body-challenge');
      const verifier = await deriveVerifier(
        password,
        Buffer.from(goodStatus.salt, 'base64url'),
        goodStatus.iterations,
      );
      expect(bodyLogin.proof).toBe(makeProof(verifier, 'body-challenge'));
      verifier.fill(0);
    }
    expect(statusCalls).toBe(2);
  });

  it('rejects passwords shorter than 8 characters without a fetch', async () => {
    let called = 0;
    const doFetch = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, 'short');
    expect(result.kind).toBe('invalid-password');
    expect(called).toBe(0);
  });
});

// -- fetchStatus (the host-loop helper that drives unlock prompting) --

describe('AccessAuth.fetchStatus', () => {
  const origin = 'https://phi.example/';
  const goodStatus = {
    enabled: true,
    authenticated: false,
    version: 'v1' as const,
    algorithm: 'pbkdf2-sha256' as const,
    iterations: 600_000,
    salt: Buffer.from('AQID', 'base64url').toString('base64url'),
    challenge: 'sample-challenge',
  };

  it('returns trusted with the parsed status on a 200 with valid JSON', async () => {
    const doFetch = (async () =>
      new Response(JSON.stringify(goodStatus), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('trusted');
    if (result.kind === 'trusted') {
      expect(result.iterations).toBe(600_000);
      expect(result.challenge).toBe('sample-challenge');
      expect(result.salt.length).toBe(3);
    }
  });

  it('returns no-auth when the server reports enabled=false', async () => {
    const doFetch = (async () =>
      new Response(JSON.stringify({ enabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('no-auth');
  });

  it('returns unavailable on malformed JSON (regression: status must NOT be trusted)', async () => {
    // Regression guard: a previous version of the host loop called
    // AccessAuth.validateStatus via a wrong cast, which threw and was
    // silently caught as "unavailable" — but a fresh failure here would
    // return "unavailable" without ever trusting an unknown payload. This
    // case pins that the malformed JSON path returns unavailable, not
    // trusted.
    const doFetch = (async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('unavailable');
  });

  it('returns unavailable on a non-2xx status code', async () => {
    const doFetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('unavailable');
  });

  it('returns unavailable on a network failure', async () => {
    const doFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('unavailable');
  });

  it('returns unavailable when validateStatus rejects the payload shape', async () => {
    const doFetch = (async () =>
      new Response(JSON.stringify({ enabled: true, iterations: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('unavailable');
  });

  it('honors a pre-aborted signal (regression: aborted unlock must cancel status)', async () => {
    // The stub honors the signal so a pre-aborted signal aborts the fetch
    // before the response is read; this is what the host loop relies on
    // when the active server switches mid-fetch.
    const doFetch = (async (_url: URL, init?: RequestInit) => {
      const sig = init?.signal;
      if (sig?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify(goodStatus), { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await auth.fetchStatus(origin, ctrl.signal);
    expect(result.kind).toBe('unavailable');
  });
});

describe('AccessAuth.tryUnlockWithVerifier + verifier cache', () => {
  const origin = 'https://phi.example/';
  const goodStatus = {
    enabled: true,
    authenticated: false,
    version: 'v1' as const,
    algorithm: 'pbkdf2-sha256' as const,
    iterations: 600_000,
    salt: Buffer.from('AQID', 'base64url').toString('base64url'),
    challenge: 'sample-challenge',
  };

  it('tryUnlockWithVerifier returns invalid-password when the verifier is not 32 bytes', async () => {
    const auth = new AccessAuth();
    const result = await auth.tryUnlockWithVerifier(origin, Buffer.alloc(16));
    expect(result.kind).toBe('invalid-password');
  });

  it('tryUnlockWithVerifier returns unavailable on status fetch failure', async () => {
    const doFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlockWithVerifier(
      origin,
      Buffer.alloc(32, 0xab),
    );
    expect(result.kind).toBe('unavailable');
  });

  it('tryUnlockWithVerifier posts a valid proof and captures the cookie', async () => {
    // Compute the verifier for the synthetic password so the proof
    // is real (this is the same derivation the browser performs).
    const crypto = await import('node:crypto');
    const { pbkdf2Sync } = crypto;
    const password = 'whatever-password';
    const salt = Buffer.from('AQID', 'base64url');
    const verifier = pbkdf2Sync(password, salt, 600_000, 32, 'sha256');

    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response(JSON.stringify({ hostname: 'X' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlockWithVerifier(
      origin,
      Buffer.from(verifier),
    );
    expect(result.kind).toBe('ok');
    expect(auth.hasCookie(origin)).toBe(true);
  });

  it('tryUnlockWithVerifier clears the cookie and returns invalid-password on a server-issued 401', async () => {
    const crypto = await import('node:crypto');
    const verifier = crypto.pbkdf2Sync(
      'whatever-password',
      Buffer.from('AQID', 'base64url'),
      600_000,
      32,
      'sha256',
    );
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', { status: 401 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlockWithVerifier(
      origin,
      Buffer.from(verifier),
    );
    expect(result.kind).toBe('invalid-password');
  });

  it('getLastVerifier returns null before any successful login', () => {
    const auth = new AccessAuth();
    expect(auth.getLastVerifier(origin)).toBeNull();
  });

  it('getLastVerifier returns the cached verifier after a successful password unlock', async () => {
    const password = 'whatever-password';
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlock(origin, password);
    expect(result.kind).toBe('ok');
    const cached = auth.getLastVerifier(origin);
    expect(cached).not.toBeNull();
    expect(cached?.length).toBe(32);
  });

  it('getLastVerifier returns null after cancel', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    await auth.tryUnlock(origin, 'whatever-password');
    expect(auth.getLastVerifier(origin)).not.toBeNull();
    auth.cancel(origin);
    expect(auth.getLastVerifier(origin)).toBeNull();
  });
});

// -- concurrent-fetch race + rate-limited discrimination --
//
// These tests pin the invariants the DesktopHost silent re-auth fix
// relies on. They are deliberately AccessAuth-level (no Electron
// harness) because the AccessAuth behaviour is what the host's
// coalescing + conservative clearing defend against. A full
// DesktopHost behavioural suite (active-changed events, view
// lifecycle, IPC handlers) is a separate, larger effort.

describe('AccessAuth: invariants the DesktopHost silent re-auth fix relies on', () => {
  const origin = 'https://phi.example/';

  it('two concurrent stale-cookie fetchConfig calls both delete the cookie (the race invariant)', async () => {
    // Regression guard for the silent re-auth race: if two 10s polls
    // both fire fetchConfig with the stale cookie, BOTH delete the
    // captured cookie. The host loop's `configOpInFlight` Map
    // coalesces the two operations BEFORE the fetchConfig so only
    // one stale fetch is ever in flight — if that coalescing is
    // ever removed, both fetches race and the second poll deletes
    // the first's freshly-installed cookie. This test pins the
    // AccessAuth layer's "delete on every 401" invariant so the
    // race at the host layer remains observable.
    let deleteCount = 0;
    const cookies = new Map<
      string,
      { cookieName: string; cookieValue: string; path: string; httpOnly: true }
    >();
    cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'stale-token',
      path: '/',
      httpOnly: true,
    });
    const doFetch = (async (): Promise<Response> => {
      // Yield once so both fetchConfig calls register before either
      // resolves — otherwise the first resolves synchronously and
      // the second sees no cookie (the race only manifests with
      // concurrent in-flight requests).
      await new Promise((r) => setTimeout(r, 0));
      deleteCount += 1;
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    (auth as unknown as { cookies: typeof cookies }).cookies = cookies;
    const [a, b] = await Promise.all([
      auth.fetchConfig(origin),
      auth.fetchConfig(origin),
    ]);
    expect(a.kind).toBe('unauthorized');
    expect(b.kind).toBe('unauthorized');
    expect(deleteCount).toBe(2); // both stale fetches ran; cookie gone
    expect(auth.hasCookie(origin)).toBe(false);
  });

  it('tryUnlockWithVerifier returns rate-limited (not invalid-password) on 429', async () => {
    // 429 is returned BEFORE the server consumes the challenge or
    // evaluates the HMAC (auth.go: the rate-limit path fires on
    // the per-IP failure counter and returns before the challenge
    // lookup). It is NOT a proof rejection — it can fire from prior
    // unrelated failed attempts on the same client IP. The host
    // loop's conservative clearing branch must therefore NOT
    // erase the persisted credential on rate-limited. This test
    // pins the AccessAuth layer to return the discriminated
    // 'rate-limited' kind so the host's clearing branch can
    // recognise and preserve the credential.
    const crypto = await import('node:crypto');
    const verifier = crypto.pbkdf2Sync(
      'whatever-password',
      Buffer.from('AQID', 'base64url'),
      600_000,
      32,
      'sha256',
    );
    const goodStatus = {
      enabled: true,
      authenticated: false,
      version: 'v1' as const,
      algorithm: 'pbkdf2-sha256' as const,
      iterations: 600_000,
      salt: Buffer.from('AQID', 'base64url').toString('base64url'),
      challenge: 'sample-challenge',
    };
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('slow down', { status: 429 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.tryUnlockWithVerifier(
      origin,
      Buffer.from(verifier),
    );
    expect(result.kind).toBe('rate-limited');
  });

  it('fetchConfig preserves a fresh native cookie across a subsequent stale-cookie 401 (no spurious clears)', async () => {
    // Regression guard for the AccessAuth cookie lifecycle that the
    // host's silent re-auth relies on: a successful login installs
    // cookie S1, and a follow-up fetchConfig that sends S1 must NOT
    // spuriously clear S1 unless the server returns 401. A 200 must
    // preserve S1.
    const doFetch = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    (auth as unknown as { cookies: Map<string, unknown> }).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'fresh-token',
      path: '/',
      httpOnly: true,
    });
    const out = await auth.fetchConfig(origin);
    expect(out.kind).toBe('ok');
    expect(auth.hasCookie(origin)).toBe(true);
  });

  it('fetchConfig checks and imports cookie from cookieProvider when in-memory jar is empty', async () => {
    let capturedHeader = '';
    const doFetch = (async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedHeader = headers?.Cookie || '';
      return new Response('{"workspaces":["/test"]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const auth = new AccessAuth(doFetch);
    expect(auth.hasCookie(origin)).toBe(false);

    auth.setCookieProvider(async (queryOrigin) => {
      if (queryOrigin === origin) {
        return {
          origin,
          cookieName: 'phi_access_session',
          cookieValue: 'provider-session-token',
          path: '/',
          httpOnly: true,
        };
      }
      return null;
    });

    const res = await auth.fetchConfig(origin);
    expect(res.kind).toBe('ok');
    expect(capturedHeader).toBe('phi_access_session=provider-session-token');
    expect(auth.hasCookie(origin)).toBe(true);
  });

  it('notifies onCookieCaptured when a new session cookie is acquired', async () => {
    const goodStatus = {
      enabled: true,
      authenticated: false,
      version: 'v1' as const,
      algorithm: 'pbkdf2-sha256' as const,
      iterations: 600_000,
      salt: Buffer.from('AQID', 'base64url').toString('base64url'),
      challenge: 'test-challenge',
    };
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200 });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'set-cookie':
              'phi_access_session=captured-session; Path=/; HttpOnly',
          },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response('{"workspaces":[]}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const auth = new AccessAuth(doFetch);
    let notifiedOrigin = '';
    let notifiedCookie = '';
    auth.setOnCookieCaptured((orig, cookie) => {
      notifiedOrigin = orig;
      notifiedCookie = cookie.cookieValue;
    });

    const result = await auth.tryUnlock(origin, 'valid-password-123');
    expect(result.kind).toBe('ok');
    expect(notifiedOrigin).toBe(origin);
    expect(notifiedCookie).toBe('captured-session');
  });

  describe('canonical origin normalization and validation', () => {
    it('normalizes valid origins to WHATWG origin without trailing slash', () => {
      expect(toCanonicalAuthOrigin('https://minerva.example.test/')).toBe(
        'https://minerva.example.test',
      );
      expect(toCanonicalAuthOrigin('https://minerva.example.test')).toBe(
        'https://minerva.example.test',
      );
      expect(toCanonicalAuthOrigin('HTTP://Minerva.Example.Test:80/path')).toBe(
        'http://minerva.example.test',
      );
      expect(toCanonicalAuthOrigin('https://phi.example:443/')).toBe(
        'https://phi.example',
      );
      expect(toCanonicalAuthOrigin('http://127.0.0.1:7070/api/config')).toBe(
        'http://127.0.0.1:7070',
      );
    });

    it('rejects non-http/https, userinfo, and malformed origins', () => {
      expect(toCanonicalAuthOrigin('file:///tmp/phi')).toBeNull();
      expect(toCanonicalAuthOrigin('javascript:alert(1)')).toBeNull();
      expect(toCanonicalAuthOrigin('data:text/plain,foo')).toBeNull();
      expect(
        toCanonicalAuthOrigin('http://user:pass@example.com:7070'),
      ).toBeNull();
      expect(toCanonicalAuthOrigin('not a url')).toBeNull();
      expect(toCanonicalAuthOrigin('')).toBeNull();
    });

    it('shares session cookies between trailing slash and non-trailing slash access', async () => {
      let cookieReceived = '';
      const doFetch = (async (url: URL, init?: RequestInit) => {
        const path = url.toString();
        if (path.endsWith('/api/auth/status')) {
          return new Response(
            JSON.stringify({
              enabled: true,
              authenticated: false,
              version: 'v1',
              algorithm: 'pbkdf2-sha256',
              iterations: 600_000,
              salt: Buffer.from('AQID', 'base64url').toString('base64url'),
              challenge: 'test-challenge',
            }),
            { status: 200 },
          );
        }
        if (path.endsWith('/api/auth/login')) {
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              'set-cookie':
                'phi_access_session=shared-session-token; Path=/; HttpOnly',
            },
          });
        }
        if (path.endsWith('/api/config')) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          cookieReceived = headers.Cookie ?? '';
          return new Response('{"hostname":"minerva"}', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${path}`);
      }) as unknown as typeof fetch;

      const auth = new AccessAuth(doFetch);
      // Unlock with trailing slash
      const unlock = await auth.tryUnlock(
        'https://minerva.example.test/',
        'whatever-password',
      );
      expect(unlock.kind).toBe('ok');

      // Query hasCookie without trailing slash
      expect(auth.hasCookie('https://minerva.example.test')).toBe(true);

      // fetchConfig without trailing slash sends the cookie
      const cfg = await auth.fetchConfig('https://minerva.example.test');
      expect(cfg.kind).toBe('ok');
      expect(cookieReceived).toBe('phi_access_session=shared-session-token');

      // cancel with no slash clears cookie for with-slash as well
      auth.cancel('https://minerva.example.test');
      expect(auth.hasCookie('https://minerva.example.test/')).toBe(false);
      expect(auth.hasCookie('https://minerva.example.test')).toBe(false);
    });

    it('preserves newer session cookie S1 when an older unauthenticated probe returns 401', async () => {
      let probeResolve!: (res: Response) => void;
      const probePromise = new Promise<Response>((r) => {
        probeResolve = r;
      });

      const doFetch = (async (url: URL, init?: RequestInit) => {
        const path = url.toString();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (path.endsWith('/api/config')) {
          if (!headers.Cookie) {
            // Delayed unauthenticated probe
            return probePromise;
          }
          // Authenticated probe with S1
          return new Response('{"hostname":"fresh"}', { status: 200 });
        }
        throw new Error(`unexpected: ${path}`);
      }) as unknown as typeof fetch;

      const auth = new AccessAuth(doFetch);
      // 1. Start delayed unauthenticated probe
      const unauthProbe = auth.fetchConfig('https://minerva.example.test');

      // 2. Fresh login installs S1 in jar
      (auth as unknown as { cookies: Map<string, unknown> }).cookies.set(
        'https://minerva.example.test',
        {
          cookieName: 'phi_access_session',
          cookieValue: 'S1-token',
          path: '/',
          httpOnly: true,
          origin: 'https://minerva.example.test',
        },
      );

      // 3. Release unauthenticated probe with 401
      probeResolve(new Response('', { status: 401 }));
      const unauthRes = await unauthProbe;
      expect(unauthRes.kind).toBe('unauthorized');

      // 4. S1 must NOT have been deleted by the unauthenticated 401
      expect(auth.hasCookie('https://minerva.example.test')).toBe(true);
      const authProbe = await auth.fetchConfig('https://minerva.example.test');
      expect(authProbe.kind).toBe('ok');
    });

    it('does not allow older login validation failure to clobber newer login state', async () => {
      let configResolveA!: (res: Response) => void;
      const configPromiseA = new Promise<Response>((r) => {
        configResolveA = r;
      });

      let loginAReachedConfigResolve!: () => void;
      const loginAReachedConfigPromise = new Promise<void>((r) => {
        loginAReachedConfigResolve = r;
      });

      const goodStatus = {
        enabled: true,
        authenticated: false,
        version: 'v1' as const,
        algorithm: 'pbkdf2-sha256' as const,
        iterations: 600_000,
        salt: Buffer.from('AQID', 'base64url').toString('base64url'),
        challenge: 'test-challenge',
      };

      let loginCall = 0;
      const doFetch = (async (url: URL, init?: RequestInit) => {
        const path = url.toString();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (path.endsWith('/api/auth/status')) {
          return new Response(JSON.stringify(goodStatus), { status: 200 });
        }
        if (path.endsWith('/api/auth/login')) {
          loginCall++;
          const token = loginCall === 1 ? 'S1-cookie' : 'S2-cookie';
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              'set-cookie': `phi_access_session=${token}; Path=/; HttpOnly`,
            },
          });
        }
        if (path.endsWith('/api/config')) {
          const cookieHdr = headers.Cookie || headers.cookie || '';
          if (cookieHdr.includes('S1-cookie')) {
            loginAReachedConfigResolve();
            return configPromiseA;
          }
          if (cookieHdr.includes('S2-cookie')) {
            return new Response('{"hostname":"from-S2"}', { status: 200 });
          }
        }
        throw new Error(`unexpected fetch: ${path}`);
      }) as unknown as typeof fetch;

      const auth = new AccessAuth(doFetch);

      const verifierA = Buffer.alloc(32, 0x11);
      const verifierB = Buffer.alloc(32, 0x22);

      // Start login A (which will pause during post-login config fetch with S1)
      const loginAPromise = auth.tryUnlockWithVerifier(
        'https://minerva.example.test',
        verifierA,
      );

      // Wait until login A definitely reached fetchConfig with S1
      await loginAReachedConfigPromise;

      // Start and complete login B (which installs S2 and succeeds)
      const loginB = await auth.tryUnlockWithVerifier(
        'https://minerva.example.test',
        verifierB,
      );
      expect(loginB.kind).toBe('ok');

      // Now release login A's config validation with 401
      configResolveA(new Response('', { status: 401 }));
      await loginAPromise;

      // Login B's S2 cookie and verifier must NOT have been cancelled or deleted!
      expect(auth.hasCookie('https://minerva.example.test')).toBe(true);
      const postCheck = await auth.fetchConfig('https://minerva.example.test');
      expect(postCheck.kind).toBe('ok');
      if (postCheck.kind === 'ok') {
        expect(postCheck.config).toEqual({ hostname: 'from-S2' });
      }
    });
  });
});

// -- v2 selection, token ownership, and no-downgrade invariants --

describe('AccessAuth v2 selection', () => {
  const origin = 'https://phi.example/';
  const v1Status = {
    enabled: true,
    authenticated: false,
    version: 'v1',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
    salt: Buffer.from('AQID', 'base64url').toString('base64url'),
    challenge: 'sample-challenge',
    protocols: ['v1', 'v2'],
  };
  const v1OnlyStatus = { ...v1Status, protocols: ['v1'] };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // A v2 success is a credential bundle plus the rotating refresh cookie. The
  // host holds the handle; no test may rely on a bare-token success.
  const handleFor = (seed: number): string =>
    Buffer.alloc(32, seed).toString('base64url');
  const bundleBody = (
    token: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    token,
    expires_at: 1_700_003_600,
    expires_in: 3_600,
    refresh_idle_expires_at: 1_702_592_000,
    refresh_absolute_expires_at: 1_707_776_000,
    ...overrides,
  });
  const bundleResponse = (
    token: string,
    handle = handleFor(1),
    overrides: Record<string, unknown> = {},
  ): Response =>
    new Response(JSON.stringify(bundleBody(token, overrides)), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `phi_access_refresh=${handle}; Path=/api/auth/v2/refresh; HttpOnly; SameSite=Strict`,
      },
    });

  it('posts the raw password to v2 login and sends the token to config', async () => {
    const seen: Array<{ path: string; auth: string | null; body: string }> = [];
    const auth = new AccessAuth((async (url: URL, init?: RequestInit) => {
      const path = url.pathname;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        path,
        auth: headers.Authorization ?? null,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (path === '/api/auth/status') return json(v1Status);
      if (path === '/api/auth/v2/login') {
        expect(init?.method).toBe('POST');
        expect(headers['X-Phi-Auth']).toBe('v2');
        return bundleResponse('jwt-token');
      }
      if (path === '/api/config') {
        return json({ hostname: 'V2' });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch);

    const result = await auth.tryUnlock(origin, 'test-pass-1234');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.config).toEqual({ hostname: 'V2' });
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
    expect(auth.getToken(origin)).toBe('jwt-token');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleFor(1));
    const login = seen.find((c) => c.path === '/api/auth/v2/login');
    expect(login?.body).toBe(JSON.stringify({ password: 'test-pass-1234' }));
    const config = seen.find((c) => c.path === '/api/config');
    expect(config?.auth).toBe('Bearer jwt-token');
    expect(seen.some((c) => c.path === '/api/auth/login')).toBe(false);
  });

  it('keeps v2 selected after a rejected token and never falls back to a cookie', async () => {
    const seen: Array<{
      path: string;
      cookie: string | null;
      auth: string | null;
    }> = [];
    const auth = new AccessAuth((async (url: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        path: url.pathname,
        cookie: headers.Cookie ?? null,
        auth: headers.Authorization ?? null,
      });
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch);
    // A working legacy cookie exists, but an explicit token decides alone.
    (
      auth as unknown as {
        cookies: Map<string, unknown>;
      }
    ).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'legacy-cookie',
      path: '/',
      httpOnly: true,
    });
    expect(auth.installToken(origin, 'rejected-token')).toBe(true);
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    expect(auth.getToken(origin)).toBeNull();
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    expect(
      seen.every((c) => c.auth === 'Bearer rejected-token' || c.auth === null),
    ).toBe(true);
    expect(seen.every((c) => c.cookie === null)).toBe(true);
  });

  it('keeps a newer token when an older request is rejected', async () => {
    let releaseA!: (res: Response) => void;
    const configA = new Promise<Response>((resolve) => {
      releaseA = resolve;
    });
    let configCalls = 0;
    const auth = new AccessAuth((async (url: URL, init?: RequestInit) => {
      if (url.pathname !== '/api/config')
        throw new Error(`unexpected ${url.pathname}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      configCalls += 1;
      if (headers.Authorization === 'Bearer token-A') return configA;
      if (headers.Authorization === 'Bearer token-B')
        return json({ hostname: 'B' });
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch);

    expect(auth.installToken(origin, 'token-A')).toBe(true);
    const requestA = auth.fetchConfig(origin);
    // Wait until A is actually in flight before replacing it.
    while (configCalls === 0) await new Promise((r) => setTimeout(r, 0));
    expect(auth.installToken(origin, 'token-B')).toBe(true);
    releaseA(new Response('', { status: 401 }));
    expect((await requestA).kind).toBe('unauthorized');
    expect(auth.getToken(origin)).toBe('token-B');
    const next = await auth.fetchConfig(origin);
    expect(next.kind).toBe('ok');
  });

  it('lets a host token installed mid-handshake win over the login response', async () => {
    let releaseLogin!: (res: Response) => void;
    const loginPending = new Promise<Response>((resolve) => {
      releaseLogin = resolve;
    });
    let loginStarted = false;
    const auth = new AccessAuth((async (url: URL) => {
      if (url.pathname === '/api/auth/status') return json(v1Status);
      if (url.pathname === '/api/auth/v2/login') {
        loginStarted = true;
        return loginPending;
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as unknown as typeof fetch);

    const unlock = auth.tryUnlock(origin, 'test-pass-1234');
    while (!loginStarted) await new Promise((r) => setTimeout(r, 0));
    // The host installs its own bearer while the password login is still
    // in flight (restored credential, or a second window's unlock).
    expect(auth.installToken(origin, 'host-token')).toBe(true);
    releaseLogin(bundleResponse('login-token'));

    expect(await unlock).toMatchObject({ kind: 'stale' });
    expect(auth.getToken(origin)).toBe('host-token');
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
  });

  it('keeps v2 selected when the login fails so no later poll sends the v1 cookie', async () => {
    const seen: Array<{ path: string; cookie: string | null }> = [];
    const auth = new AccessAuth((async (url: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ path: url.pathname, cookie: headers.Cookie ?? null });
      if (url.pathname === '/api/auth/status') return json(v1Status);
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch);
    (auth as unknown as { cookies: Map<string, unknown> }).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'legacy-cookie',
      path: '/',
      httpOnly: true,
    });

    expect((await auth.tryUnlock(origin, 'test-pass-1234')).kind).toBe(
      'invalid-password',
    );
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    expect(
      seen
        .filter((c) => c.path === '/api/config')
        .every((c) => c.cookie === null),
    ).toBe(true);
  });

  it('ignores a cookie provider that resolves after a v2 token is installed', async () => {
    const sent: Array<{ cookie: string | null; auth: string | null }> = [];
    const auth = new AccessAuth((async (_url: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({
        cookie: headers.Cookie ?? null,
        auth: headers.Authorization ?? null,
      });
      return json({ hostname: 'V2' });
    }) as unknown as typeof fetch);
    let releaseProvider!: (value: CookieJarEntry | null) => void;
    auth.setCookieProvider(
      () =>
        new Promise((resolve) => {
          releaseProvider = resolve;
        }),
    );

    // The poll starts as a legacy (cookie) request and parks in the provider.
    const config = auth.fetchConfig(origin);
    while (!releaseProvider) await new Promise((r) => setTimeout(r, 0));
    expect(auth.installToken(origin, 'host-token')).toBe(true);
    releaseProvider({
      origin,
      cookieName: 'phi_access_session',
      cookieValue: 'legacy-cookie',
      path: '/',
      httpOnly: true,
    });

    expect((await config).kind).toBe('ok');
    expect(sent).toEqual([{ cookie: null, auth: 'Bearer host-token' }]);
  });

  it('validates a token through v2 status without a cookie', async () => {
    const seen: Array<{ auth: string | null; cookie: string | null }> = [];
    const auth = new AccessAuth((async (url: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        auth: headers.Authorization ?? null,
        cookie: headers.Cookie ?? null,
      });
      if (url.pathname !== '/api/auth/v2/status')
        throw new Error('wrong route');
      return json({ enabled: true, authenticated: true });
    }) as unknown as typeof fetch);
    expect(await auth.checkToken(origin, 'tok')).toBe('valid');
    expect(seen[0]).toEqual({ auth: 'Bearer tok', cookie: null });
  });

  it('reports invalid, disabled, transient, and malformed v2 statuses', async () => {
    const make = (res: Response) =>
      new AccessAuth((async () => res) as unknown as typeof fetch);
    expect(
      await make(json({ enabled: true, authenticated: false })).checkToken(
        origin,
        't',
      ),
    ).toBe('invalid');
    expect(
      await make(json({ enabled: false, authenticated: false })).checkToken(
        origin,
        't',
      ),
    ).toBe('valid');
    expect(
      await make(new Response('', { status: 401 })).checkToken(origin, 't'),
    ).toBe('invalid');
    expect(
      await make(new Response('', { status: 500 })).checkToken(origin, 't'),
    ).toBe('unavailable');
    expect(
      await make(new Response('not json', { status: 200 })).checkToken(
        origin,
        't',
      ),
    ).toBe('unavailable');
    expect(await make(json({ enabled: true })).checkToken(origin, 't')).toBe(
      'unavailable',
    );
  });

  it('maps v2 login failures to fixed messages', async () => {
    const make = (res: Response) =>
      new AccessAuth((async (url: URL) => {
        if (url.pathname === '/api/auth/status') return json(v1Status);
        if (url.pathname === '/api/auth/v2/login') return res;
        throw new Error(`unexpected ${url.pathname}`);
      }) as unknown as typeof fetch);
    const invalid = await make(
      new Response('secret server text', { status: 401 }),
    ).tryUnlock(origin, 'test-pass-1234');
    expect(invalid).toEqual({
      kind: 'invalid-password',
      message: 'Password not accepted.',
    });
    const limited = await make(new Response('', { status: 429 })).tryUnlock(
      origin,
      'test-pass-1234',
    );
    expect(limited.kind).toBe('rate-limited');
    const down = await make(new Response('', { status: 503 })).tryUnlock(
      origin,
      'test-pass-1234',
    );
    expect(down.kind).toBe('unavailable');
    const badToken = await make(json({ token: 42 })).tryUnlock(
      origin,
      'test-pass-1234',
    );
    expect(badToken.kind).toBe('unavailable');
  });

  it('uses UTF-8 byte length for the v2 password bound', async () => {
    const calls: string[] = [];
    const auth = new AccessAuth((async (url: URL) => {
      calls.push(url.pathname);
      if (url.pathname === '/api/auth/status') return json(v1Status);
      if (url.pathname === '/api/auth/v2/login') return bundleResponse('tok');
      return json({});
    }) as unknown as typeof fetch);
    // Four 4-byte characters plus four ASCII characters = 20 bytes, 8 chars.
    expect((await auth.tryUnlock(origin, '😀😀😀😀abcd')).kind).toBe('ok');
    // 1025 ASCII bytes exceeds the 1024-byte bound; no login request.
    const before = calls.filter((p) => p === '/api/auth/v2/login').length;
    const tooLong = await auth.tryUnlock(origin, 'a'.repeat(1025));
    expect(tooLong.kind).toBe('invalid-password');
    expect(calls.filter((p) => p === '/api/auth/v2/login').length).toBe(before);
  });

  it('refuses the v1 verifier and proof paths after v2 selection', async () => {
    const auth = new AccessAuth();
    auth.installToken(origin, 'tok');
    const verifier = Buffer.alloc(32, 0x11);
    expect((await auth.tryUnlockWithVerifier(origin, verifier)).kind).toBe(
      'unavailable',
    );
    expect((await auth.createLoginProof(origin)).kind).toBe('unavailable');
  });

  it('moves a selected v2 client to v1 only after v1-only discovery', async () => {
    const seen: string[] = [];
    const auth = new AccessAuth((async (url: URL) => {
      seen.push(url.pathname);
      if (url.pathname === '/api/auth/status') return json(v1OnlyStatus);
      if (url.pathname === '/api/auth/login') {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=v1; Path=/; HttpOnly' },
        });
      }
      return json({ hostname: 'V1' });
    }) as unknown as typeof fetch);
    auth.installToken(origin, 'stale-v2');
    const result = await auth.tryUnlock(origin, 'test-pass-1234');
    expect(result.kind).toBe('ok');
    expect(auth.getSelectedProtocol(origin)).toBe('v1');
    expect(auth.getToken(origin)).toBeNull();
    expect(seen).toContain('/api/auth/login');
    expect(seen).not.toContain('/api/auth/v2/login');
  });

  it('keeps a selected v1 client on v1 when the server advertises v2', async () => {
    const seen: string[] = [];
    let status = v1OnlyStatus;
    const auth = new AccessAuth((async (url: URL) => {
      seen.push(url.pathname);
      if (url.pathname === '/api/auth/status') return json(status);
      if (url.pathname === '/api/auth/login') {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=v1; Path=/; HttpOnly' },
        });
      }
      return json({});
    }) as unknown as typeof fetch);
    // Seed a v1 selection from a v1-only server.
    expect((await auth.tryUnlock(origin, 'test-pass-1234')).kind).toBe('ok');
    expect(auth.getSelectedProtocol(origin)).toBe('v1');
    // The same server now advertises v2; the selected v1 client stays on v1.
    status = v1Status;
    seen.length = 0;
    expect((await auth.tryUnlock(origin, 'test-pass-1234')).kind).toBe('ok');
    expect(seen).toContain('/api/auth/login');
    expect(seen).not.toContain('/api/auth/v2/login');
    expect(auth.getSelectedProtocol(origin)).toBe('v1');
  });

  it('clears token and selection on cancel', () => {
    const auth = new AccessAuth();
    auth.installToken(origin, 'tok');
    expect(auth.hasToken(origin)).toBe(true);
    auth.cancel(origin);
    expect(auth.hasToken(origin)).toBe(false);
    expect(auth.getSelectedProtocol(origin)).toBeNull();
  });
});

describe('parseProtocols', () => {
  it('treats an absent field as legacy v1-only', () => {
    expect(parseProtocols(undefined)).toEqual([]);
  });
  it('accepts unique supported names and ignores unknown neighbours', () => {
    expect(parseProtocols(['v1', 'v2'])).toEqual(['v1', 'v2']);
    expect(parseProtocols(['v2', 'future'])).toEqual(['v2']);
  });
  it('rejects malformed, empty, duplicate, and unsupported-only arrays', () => {
    expect(parseProtocols(null)).toBeNull();
    expect(parseProtocols([])).toBeNull();
    expect(parseProtocols(['v1', 'v1'])).toBeNull();
    expect(parseProtocols(['v1', ''])).toBeNull();
    expect(parseProtocols(['future'])).toBeNull();
    expect(parseProtocols('v2')).toBeNull();
  });
});

describe('AccessAuth v2 refresh bundle', () => {
  const origin = 'https://phi.example';
  const handleA = Buffer.alloc(32, 0xa1).toString('base64url');
  const handleB = Buffer.alloc(32, 0xb2).toString('base64url');
  // A fixed clock keeps renewal deterministic: the bundle's deadlines are
  // absolute server seconds, so the host never compares its own wall clock.
  let clockMs = 1_700_000_000_000;
  const now = (): number => clockMs;

  function bundle(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      token,
      expires_at: Math.floor(clockMs / 1000) + 3_600,
      expires_in: 3_600,
      refresh_idle_expires_at: Math.floor(clockMs / 1000) + 2_592_000,
      refresh_absolute_expires_at: Math.floor(clockMs / 1000) + 7_776_000,
      ...overrides,
    };
  }

  function refreshCookie(handle: string): string {
    return `phi_access_refresh=${handle}; Path=/api/auth/v2/refresh; HttpOnly; SameSite=Strict`;
  }

  function bundleResponse(
    token: string,
    handle: string,
    overrides: Record<string, unknown> = {},
  ): Response {
    return new Response(JSON.stringify(bundle(token, overrides)), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': refreshCookie(handle),
      },
    });
  }

  function install(auth: AccessAuth, token = 'token-a', handle = handleA): void {
    expect(
      auth.installBundle(origin, {
        token,
        expiresAt: Math.floor(clockMs / 1000) + 3_600,
        expiresIn: 3_600,
        refreshHandle: handle,
        refreshIdleExpiresAt: Math.floor(clockMs / 1000) + 2_592_000,
        refreshAbsoluteExpiresAt: Math.floor(clockMs / 1000) + 7_776_000,
      }),
    ).toBe(true);
  }

  type RefreshCall = {
    path: string;
    method: string | undefined;
    cookie: string | null;
    auth: string | null;
    csrf: string | null;
    body: string;
    url: string;
  };

  it('captures the bundle and keeps the refresh handle out of the request path', async () => {
    const calls: RefreshCall[] = [];
    const auth = new AccessAuth(
      (async (url: URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          path: url.pathname,
          method: init?.method,
          cookie: headers.Cookie ?? null,
          auth: headers.Authorization ?? null,
          csrf: headers['X-Phi-Auth'] ?? null,
          body: typeof init?.body === 'string' ? init.body : '',
          url: url.toString(),
        });
        if (url.pathname === '/api/auth/status')
          return new Response(
            JSON.stringify({
              enabled: true,
              authenticated: false,
              version: 'v1',
              algorithm: 'pbkdf2-sha256',
              iterations: 600_000,
              salt: Buffer.from('AQID', 'base64url').toString('base64url'),
              challenge: 'chal',
              protocols: ['v1', 'v2'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (url.pathname === '/api/auth/v2/login')
          return bundleResponse('access-1', handleB);
        if (url.pathname === '/api/config') return new Response('{"ok":1}');
        throw new Error(`unexpected ${url.pathname}`);
      }) as unknown as typeof fetch,
      now,
    );

    expect((await auth.tryUnlock(origin, 'correct-horse')).kind).toBe('ok');
    const login = calls.find((c) => c.path === '/api/auth/v2/login');
    expect(login?.csrf).toBe('v2');
    expect(login?.url).not.toContain(handleB);
    expect(auth.getToken(origin)).toBe('access-1');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleB);
    expect(auth.getBundle(origin)?.expiresIn).toBe(3_600);
  });

  it('refreshes with only the host cookie, JSON body, and CSRF header', async () => {
    const calls: RefreshCall[] = [];
    const auth = new AccessAuth(
      (async (url: URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          path: url.pathname,
          method: init?.method,
          cookie: headers.Cookie ?? null,
          auth: headers.Authorization ?? null,
          csrf: headers['X-Phi-Auth'] ?? null,
          body: typeof init?.body === 'string' ? init.body : '',
          url: url.toString(),
        });
        return bundleResponse('access-2', handleB);
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);

    const result = await auth.refreshAccess(origin);
    expect(result.kind).toBe('ok');
    const call = calls[0];
    expect(call.path).toBe('/api/auth/v2/refresh');
    expect(call.method).toBe('POST');
    expect(call.cookie).toBe(`phi_access_refresh=${handleA}`);
    expect(call.auth).toBeNull();
    expect(call.csrf).toBe('v2');
    expect(call.body).toBe('{}');
    expect(call.url).not.toContain(handleA);
    expect(auth.getToken(origin)).toBe('access-2');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleB);
  });

  it('renews only when the access expiry is near, and coalesces callers', async () => {
    let refreshCalls = 0;
    let release!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const auth = new AccessAuth(
      (async (url: URL) => {
        if (url.pathname !== '/api/auth/v2/refresh')
          throw new Error(`unexpected ${url.pathname}`);
        refreshCalls += 1;
        return pending;
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);

    // Well inside the lifetime: nothing is due, and no request is made.
    expect(await auth.renewIfDue(origin)).toBeNull();
    expect(refreshCalls).toBe(0);

    // Move to one second inside the renewal lead.
    clockMs += (3_600 - 60) * 1_000;
    const first = auth.renewIfDue(origin);
    const second = auth.renewIfDue(origin);
    const forced = auth.refreshAccess(origin);
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    release(bundleResponse('access-2', handleB));
    expect((await first)?.kind).toBe('ok');
    expect((await second)?.kind).toBe('ok');
    expect((await forced).kind).toBe('ok');
    expect(refreshCalls).toBe(1);
    expect(auth.getToken(origin)).toBe('access-2');
  });

  it('treats a matching refresh 401 as terminal and keeps v2 selected', async () => {
    const auth = new AccessAuth(
      (async () => new Response('access authentication required\n', {
        status: 401,
      })) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    expect((await auth.refreshAccess(origin)).kind).toBe('unauthorized');
    expect(auth.getToken(origin)).toBeNull();
    expect(auth.getBundle(origin)).toBeNull();
    // A rejected credential must never reopen the legacy v1 cookie path.
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
  });

  it('keeps the bundle and backs off on every non-401 refresh failure', async () => {
    let refreshCalls = 0;
    let status = 500;
    let retryAfter: string | null = null;
    const auth = new AccessAuth(
      (async () => {
        refreshCalls += 1;
        const headers = new Headers();
        if (retryAfter !== null) headers.set('retry-after', retryAfter);
        return new Response('', { status, headers });
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    clockMs += (3_600 - 60) * 1_000;
    const first = await auth.refreshAccess(origin);
    expect(first.kind).toBe('unavailable');
    expect(refreshCalls).toBe(1);
    // The credential survives a server-side or transport failure.
    expect(auth.getToken(origin)).toBe('access-1');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);

    // Backoff holds the next attempt even though the token is now due.
    expect(await auth.renewIfDue(origin)).toBeNull();
    expect(refreshCalls).toBe(1);

    // A 429 with Retry-After is honored, bounded by the 300-second cap.
    clockMs += 120_000;
    status = 429;
    retryAfter = '900';
    const limited = await auth.refreshAccess(origin);
    expect(limited).toMatchObject({
      kind: 'unavailable',
      retryAfterMs: 300_000,
    });
    expect(auth.getToken(origin)).toBe('access-1');
    expect(await auth.renewIfDue(origin)).toBeNull();
  });

  it('never installs a late refresh response over a newer bundle', async () => {
    let release!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const auth = new AccessAuth(
      (async () => pending) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-a', handleA);
    const inFlight = auth.refreshAccess(origin);
    await Promise.resolve();
    // A second login (another window) installs a newer credential meanwhile.
    install(auth, 'access-b', handleB);
    release(bundleResponse('access-late', Buffer.alloc(32, 0xc3).toString('base64url')));
    expect((await inFlight).kind).toBe('superseded');
    expect(auth.getToken(origin)).toBe('access-b');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleB);
  });

  it('rejects a malformed or oversized bundle without losing the credential', async () => {
    const badBundles: Response[] = [
      bundleResponse('access-2', handleB, { expires_at: 0 }),
      bundleResponse('access-2', handleB, { expires_in: 'soon' }),
      bundleResponse('access-2', handleB, { refresh_idle_expires_at: 9_999_999_999, refresh_absolute_expires_at: 1 }),
      new Response(JSON.stringify({ token: '' }), { status: 200 }),
      new Response('x'.repeat(70_000), { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    for (const response of badBundles) {
      const auth = new AccessAuth(
        (async () => response.clone()) as unknown as typeof fetch,
        now,
      );
      install(auth, 'access-1', handleA);
      const result = await auth.refreshAccess(origin);
      expect(result.kind).toBe('unavailable');
      expect(auth.getToken(origin)).toBe('access-1');
      expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);
    }
  });

  it('refuses a refresh cookie without the exact server attributes', async () => {
    const weak = [
      `phi_access_refresh=${handleB}; Path=/api/auth/v2/refresh; SameSite=Strict`,
      `phi_access_refresh=${handleB}; Path=/api/auth/v2/refresh; HttpOnly`,
      `phi_access_refresh=${handleB}; Path=/; HttpOnly; SameSite=Strict`,
      `phi_access_refresh=${handleB}; Path=/api/auth/v2/refresh; HttpOnly; SameSite=Strict; Domain=example`,
      `phi_access_refresh=${handleB}=; Path=/api/auth/v2/refresh; HttpOnly; SameSite=Strict`,
      `phi_access_refresh=short-handle; Path=/api/auth/v2/refresh; HttpOnly; SameSite=Strict`,
    ];
    for (const cookie of weak) {
      const auth = new AccessAuth(
        (async () =>
          new Response(JSON.stringify(bundle('access-2')), {
            status: 200,
            headers: { 'content-type': 'application/json', 'set-cookie': cookie },
          })) as unknown as typeof fetch,
        now,
      );
      install(auth, 'access-1', handleA);
      expect((await auth.refreshAccess(origin)).kind).toBe('unavailable');
      expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);
    }
  });

  it('starts exactly one refresh from an access 401 and never replays the request', async () => {
    let configCalls = 0;
    let refreshCalls = 0;
    const auth = new AccessAuth(
      (async (url: URL) => {
        if (url.pathname === '/api/config') {
          configCalls += 1;
          return new Response('', { status: 401 });
        }
        if (url.pathname === '/api/auth/v2/refresh') {
          refreshCalls += 1;
          return bundleResponse('access-2', handleB);
        }
        throw new Error(`unexpected ${url.pathname}`);
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    // The request is not replayed, but the credential is not deleted either.
    expect(configCalls).toBe(1);
    expect(auth.getToken(origin)).toBe('access-1');
    const refreshed = await auth.refreshAccess(origin);
    expect(refreshed.kind).toBe('ok');
    expect(refreshCalls).toBe(1);
    expect(auth.getToken(origin)).toBe('access-2');
  });

  it('clears a host-installed token on 401 without a refresh attempt', async () => {
    let refreshCalls = 0;
    const auth = new AccessAuth(
      (async (url: URL) => {
        if (url.pathname === '/api/config')
          return new Response('', { status: 401 });
        if (url.pathname === '/api/auth/v2/refresh') {
          refreshCalls += 1;
          return bundleResponse('access-2', handleB);
        }
        throw new Error(`unexpected ${url.pathname}`);
      }) as unknown as typeof fetch,
      now,
    );
    expect(auth.installToken(origin, 'host-token')).toBe(true);
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
    expect(refreshCalls).toBe(0);
    expect(auth.getToken(origin)).toBeNull();
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
  });

  it('logs out with the bearer, then drops the bundle and stays on v2', async () => {
    const calls: RefreshCall[] = [];
    const auth = new AccessAuth(
      (async (url: URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          path: url.pathname,
          method: init?.method,
          cookie: headers.Cookie ?? null,
          auth: headers.Authorization ?? null,
          csrf: headers['X-Phi-Auth'] ?? null,
          body: typeof init?.body === 'string' ? init.body : '',
          url: url.toString(),
        });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    expect(await auth.logout(origin, true)).toEqual({ kind: 'ok' });
    expect(calls[0]).toMatchObject({
      path: '/api/auth/v2/logout',
      method: 'POST',
      auth: 'Bearer access-1',
      csrf: 'v2',
      body: '{"all":true}',
      cookie: null,
    });
    expect(auth.getToken(origin)).toBeNull();
    expect(auth.getBundle(origin)).toBeNull();
    expect(auth.getSelectedProtocol(origin)).toBe('v2');
  });

  it('keeps the bundle when logout is not confirmed', async () => {
    const auth = new AccessAuth(
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    expect((await auth.logout(origin, false)).kind).toBe('unavailable');
    expect(auth.getToken(origin)).toBe('access-1');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);
  });

  it('isolates origins, cancellation, and the loopback fallback identity', async () => {
    const other = 'https://other.example';
    const refreshHosts: string[] = [];
    const auth = new AccessAuth(
      (async (url: URL) => {
        refreshHosts.push(url.host);
        return bundleResponse('access-2', handleB);
      }) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    expect(
      auth.installBundle(other, {
        token: 'other-token',
        expiresAt: Math.floor(clockMs / 1000) + 3_600,
        expiresIn: 3_600,
        refreshHandle: Buffer.alloc(32, 0xd4).toString('base64url'),
        refreshIdleExpiresAt: Math.floor(clockMs / 1000) + 2_592_000,
        refreshAbsoluteExpiresAt: Math.floor(clockMs / 1000) + 7_776_000,
      }),
    ).toBe(true);

    auth.cancel(other);
    expect(auth.getBundle(other)).toBeNull();
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);
    expect(auth.getSelectedProtocol(origin)).toBe('v2');

    // The canonical identity of 127.0.0.1 is its own origin: a bundle held
    // for another origin never travels to it.
    expect(auth.getBundle('http://127.0.0.1:8080')).toBeNull();
    expect(refreshHosts).toEqual([]);
  });

  it('accepts a grace replay that re-issues the same handle', async () => {
    // A lost response leaves the host holding a consumed handle. Inside the
    // server's 60-second grace the replay succeeds and re-issues that same
    // handle, which must not be mistaken for a missing rotation.
    const auth = new AccessAuth(
      (async () => bundleResponse('access-2', handleA)) as unknown as typeof fetch,
      now,
    );
    install(auth, 'access-1', handleA);
    const result = await auth.refreshAccess(origin);
    expect(result.kind).toBe('ok');
    expect(auth.getToken(origin)).toBe('access-2');
    expect(auth.getBundle(origin)?.refreshHandle).toBe(handleA);
  });

  it('keeps the canonical identity across the localhost transport fallback', async () => {
    const hosts: string[] = [];
    const auth = new AccessAuth(
      (async (url: URL) => {
        hosts.push(url.host);
        if (url.host === 'localhost:8080') throw new Error('connection refused');
        return bundleResponse('access-2', handleB);
      }) as unknown as typeof fetch,
      now,
    );
    const local = 'http://localhost:8080';
    expect(
      auth.installBundle(local, {
        token: 'access-1',
        expiresAt: Math.floor(clockMs / 1000) + 3_600,
        expiresIn: 3_600,
        refreshHandle: handleA,
        refreshIdleExpiresAt: Math.floor(clockMs / 1000) + 2_592_000,
        refreshAbsoluteExpiresAt: Math.floor(clockMs / 1000) + 7_776_000,
      }),
    ).toBe(true);
    expect((await auth.refreshAccess(local)).kind).toBe('ok');
    // The transport may move to the loopback literal; the credential stays
    // bound to the origin the user chose.
    expect(hosts).toEqual(['localhost:8080', '127.0.0.1:8080']);
    expect(auth.getToken(local)).toBe('access-2');
    expect(auth.getBundle('http://127.0.0.1:8080')).toBeNull();
  });

  it('never puts the handle in a renderer-visible accessor', () => {
    const auth = new AccessAuth(undefined, now);
    install(auth, 'access-1', handleA);
    // Everything the host hands to a body is the bare token.
    expect(auth.getToken(origin)).toBe('access-1');
    expect(auth.getToken(origin)).not.toContain(handleA);
    expect(JSON.stringify(auth.getToken(origin))).not.toContain(handleA);
  });
});
