import { describe, it, expect, vi } from 'vitest';
import { AccessAuth } from '../src/access-auth.js';

describe('AccessAuth localhost to 127.0.0.1 IPv4 fallback', () => {
  it('retries with 127.0.0.1 when localhost fails with ECONNREFUSED', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      if (url.hostname === 'localhost') {
        throw new Error('connect ECONNREFUSED ::1:8080');
      }
      if (url.hostname === '127.0.0.1') {
        return new Response(
          JSON.stringify({ hostname: 'remote-phi', workspaces: ['/test'] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`unexpected host ${url.hostname}`);
    });

    const auth = new AccessAuth(mockFetch as unknown as typeof fetch);
    const res = await auth.fetchConfig('http://localhost:8080');

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect((res.config as any)?.hostname).toBe('remote-phi');
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails with unavailable when both localhost and 127.0.0.1 fail', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const auth = new AccessAuth(mockFetch as unknown as typeof fetch);
    const res = await auth.fetchConfig('http://localhost:8080');

    expect(res.kind).toBe('unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
