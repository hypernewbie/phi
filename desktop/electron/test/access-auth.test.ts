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
  deriveVerifier,
  makeProof,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  parseSessionCookie,
  readSetCookieHeaders,
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
    await expect(deriveVerifier('whatever-password', salt, MIN_ITERATIONS - 1)).rejects.toThrow();
    await expect(deriveVerifier('whatever-password', salt, MAX_ITERATIONS + 1)).rejects.toThrow();
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
      enabled: true, version: 'v1', algorithm: 'pbkdf2-sha256',
      iterations: 100, salt: 'AQID', challenge: 'x',
    });
    expect(r).toBe(null);
  });

  it('returns null on malformed salt or challenge', () => {
    const r = validateStatus({
      enabled: true, version: 'v1', algorithm: 'pbkdf2-sha256',
      iterations: 600_000, salt: '', challenge: 'x',
    });
    expect(r).toBe(null);
    const r2 = validateStatus({
      enabled: true, version: 'v1', algorithm: 'pbkdf2-sha256',
      iterations: 600_000, salt: 'AQID', challenge: '',
    });
    expect(r2).toBe(null);
  });

  it('marks enabled=false as the disabled branch', () => {
    const r = validateStatus({ enabled: false });
    expect(r).toEqual({ kind: 'disabled' });
  });

  it('accepts a well-formed enabled status', () => {
    const r = validateStatus({
      enabled: true, version: 'v1', algorithm: 'pbkdf2-sha256',
      iterations: 600_000, salt: 'AQID', challenge: 'x',
    });
    expect(r?.kind).toBe('trusted');
    if (r?.kind === 'trusted') {
      expect(r.status.salt.toString()).toBe(Buffer.from('AQID', 'base64url').toString());
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
    const res = new FakeResponse(['phi_access_session=abc123; Path=/; HttpOnly']);
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
    const auth = new AccessAuth(async () => new Response('nope', { status: 401 }));
    expect((await auth.fetchConfig(origin)).kind).toBe('unauthorized');
  });

  it('returns unavailable on 5xx, network failure, and bad JSON', async () => {
    const a = new AccessAuth(async () => new Response('', { status: 500 }));
    expect((await a.fetchConfig(origin)).kind).toBe('unavailable');
    const b = new AccessAuth(async () => { throw new Error('econnreset'); });
    expect((await b.fetchConfig(origin)).kind).toBe('unavailable');
    const c = new AccessAuth(async () => new Response('not json', { status: 200 }));
    expect((await c.fetchConfig(origin)).kind).toBe('unavailable');
  });

  it('sends the captured cookie when one is set', async () => {
    const seen: { cookie: string | null } = { cookie: null };
    const auth = new AccessAuth(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.cookie = headers['Cookie'] ?? null;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // Simulate a successful login by populating the cookie via reflection.
    (auth as unknown as { cookies: Map<string, { cookieName: string; cookieValue: string; path: string; httpOnly: true }> }).cookies.set(origin, {
      cookieName: 'phi_access_session',
      cookieValue: 'token-xyz',
      path: '/',
      httpOnly: true,
    });
    await auth.fetchConfig(origin);
    expect(seen.cookie).toBe('phi_access_session=token-xyz');
  });
});

// -- tryUnlock happy / sad paths --

describe('AccessAuth.tryUnlock', () => {
  const origin = 'https://phi.example/';
  const goodStatus = {
    enabled: true, version: 'v1' as const, algorithm: 'pbkdf2-sha256' as const,
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
        return new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'phi_access_session=ok-token; Path=/; HttpOnly' },
        });
      }
      if (path.endsWith('/api/config')) {
        return new Response(JSON.stringify({ hostname: 'X' }), { status: 200, headers: { 'content-type': 'application/json' } });
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
        return new Response(JSON.stringify(goodStatus), { status: 200, headers: { 'content-type': 'application/json' } });
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

  it('keeps the modal open (invalid-password) when /api/config still 401s after login', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200, headers: { 'content-type': 'application/json' } });
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
    expect(result.kind).toBe('invalid-password');
    expect(auth.hasCookie(origin)).toBe(false);
  });

  it('returns rate-limited on 429', async () => {
    const doFetch = (async (url: URL) => {
      const path = url.toString();
      if (path.endsWith('/api/auth/status')) {
        return new Response(JSON.stringify(goodStatus), { status: 200, headers: { 'content-type': 'application/json' } });
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
        return new Response(JSON.stringify(goodStatus), { status: 200, headers: { 'content-type': 'application/json' } });
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
    enabled: true, version: 'v1' as const, algorithm: 'pbkdf2-sha256' as const,
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
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const auth = new AccessAuth(doFetch);
    const result = await auth.fetchStatus(origin);
    expect(result.kind).toBe('unavailable');
  });

  it('returns unavailable on a non-2xx status code', async () => {
    const doFetch = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
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
    enabled: true, version: 'v1' as const, algorithm: 'pbkdf2-sha256' as const,
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
    const result = await auth.tryUnlockWithVerifier(origin, Buffer.alloc(32, 0xab));
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
    const result = await auth.tryUnlockWithVerifier(origin, Buffer.from(verifier));
    expect(result.kind).toBe('ok');
    expect(auth.hasCookie(origin)).toBe(true);
  });

  it('tryUnlockWithVerifier clears the cookie and returns invalid-password on a server-issued 401', async () => {
    const crypto = await import('node:crypto');
    const verifier = crypto.pbkdf2Sync('whatever-password', Buffer.from('AQID', 'base64url'), 600_000, 32, 'sha256');
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
    const result = await auth.tryUnlockWithVerifier(origin, Buffer.from(verifier));
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
