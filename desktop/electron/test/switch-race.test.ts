// @vitest-environment node
//
// FUNDAMENTAL CONTRACT — DO NOT CHANGE.
//
// Low-power (single-tab) mode shows ONE page for every server. A rail
// click must not answer the old page's headerless requests with the new
// server, and a switch that fails its compatibility probe must not leave
// the request router aimed at a server the page never switched to.
// "It thinks one server is another server" is a defect, never a
// trade-off.
//
// The routing pointer follows the page, not the click: it moves only at
// a commit — the page's own /__phi/active claim after it has painted,
// or a boot load — and claims are arrival-ordered, so the last click
// wins, never the last completion.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EmbeddedProfile,
  EmbeddedTransport,
} from '../src/embedded-transport.js';

const ORIGIN_A = 'http://127.0.0.1:8080';
const ORIGIN_B = 'https://backend-b.example.com:8443';

interface Harness {
  transport: EmbeddedTransport;
  upstream: ReturnType<typeof vi.fn>;
  /** Queues the next ungated upstream answer. */
  queue(response: Response): void;
  /** Holds a gated upstream answer (the compat probe, a slow row). */
  gate(url: string): { release: (init?: { api?: string }) => void };
  cleanup: () => void;
}

function buildHarness(): Harness {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'phi-switch-race-'));
  const profiles = new Map<string, EmbeddedProfile>([
    ['prof-a', { id: 'prof-a', origin: ORIGIN_A }],
    ['prof-b', { id: 'prof-b', origin: ORIGIN_B }],
  ]);
  const gates = new Map<
    string,
    { answer?: { api?: string }; release: () => void }
  >();
  /** Responses handed to the next ungated upstream row. */
  const queued: Response[] = [];

  const upstream = vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url.toString();
    const gate = gates.get(href);
    if (gate) {
      await new Promise<void>((resolve) => {
        gate.release = () => resolve();
      });
      return new Response(
        JSON.stringify({
          api: gate.answer?.api ?? '1',
          terminal_protocol: gate.answer?.api === undefined ? '3' : '9',
          version: '9.9.9',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const next = queued.shift();
    if (next) return next;
    return new Response(
      JSON.stringify({ api: '1', terminal_protocol: '3', version: '9.9.9' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const transport = new EmbeddedTransport({
    embeddedDir: tempDir,
    resolveProfile: (id) => profiles.get(id) ?? null,
    listProfiles: () => Array.from(profiles.values()),
    fetchImpl: upstream as unknown as typeof fetch,
  });

  return {
    transport,
    upstream,
    queue(response: Response) {
      queued.push(response);
    },
    gate(url: string) {
      const entry = {
        answer: undefined as { api?: string } | undefined,
        release: () => {},
      };
      gates.set(url, entry);
      return {
        release(init?: { api?: string }) {
          entry.answer = init;
          entry.release();
        },
      };
    },
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function headerless(url: string): Request {
  return new Request(`phi-app://app${url}`);
}

describe('single-tab switch race contracts', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  afterEach(() => {
    harness.cleanup();
    vi.restoreAllMocks();
  });

  it('R-window: until the page switches, headerless requests keep going to the server the page shows', async () => {
    const { transport } = harness;
    // The page is on A and has been for a while.
    transport.setActiveProfile('prof-a');

    // The user clicks B. The click opens the compatibility probe and
    // nothing else: the router follows the page, so until the page
    // lands on B there is no commit to make. Hold the probe open to
    // prove the window routes to A throughout.
    const probe = harness.gate(`${ORIGIN_B}/api/version`);
    const checking = transport.checkCompatibility('prof-b');

    // The page — still showing A — polls. Headerless, so it can only be
    // routed by the profile pointer.
    await transport.handleRequest(headerless('/api/peers/status'));

    // Those bytes must come from A, the server the page actually shows.
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_A}/`),
      ),
    ).toBe(true);
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_B}/api/peers`),
      ),
    ).toBe(false);

    probe.release();
    expect(await checking).toBe(true);
  });

  it('R-fallback: a probe that fails must not leave the router aimed at the incompatible server', async () => {
    const { transport } = harness;
    transport.setActiveProfile('prof-a');

    // The user clicks a server that speaks an incompatible API: the
    // shell falls back to that server's own page, and the embedded
    // router has no business pointing at it. The click is the probe
    // alone; a failed probe commits nothing.
    const probe = harness.gate(`${ORIGIN_B}/api/version`);
    const checking = transport.checkCompatibility('prof-b');
    probe.release({ api: '999' });
    expect(await checking).toBe(false);

    // The page never switched to B. Headerless requests must not reach
    // it — not during the probe, and not after the fallback — and the
    // pointer still says A, the server the page actually shows.
    await transport.handleRequest(headerless('/api/peers/status'));
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_B}/api/peers`),
      ),
    ).toBe(false);
    expect(transport.getActiveProfileId()).toBe('prof-a');
  });

  it('R-active: when two /__phi/active POSTs interleave, the later click wins', async () => {
    const { transport } = harness;
    transport.setActiveProfile('prof-a');

    // A's POST body is held by a slow stream; B's POST is issued after
    // it and answers immediately. The pointer must end on B: it is the
    // click the user made last. (Today's callers serialize their POSTs;
    // this pins the transport against future callers that do not.)
    let releaseA!: () => void;
    const bodyA = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseA = () => {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ profileId: 'prof-a' })),
          );
          controller.close();
        };
      },
    });
    const first = transport.handleRequest(
      new Request('phi-app://app/__phi/active', {
        method: 'POST',
        body: bodyA,
        duplex: 'half',
      } as RequestInit),
    );
    const second = transport.handleRequest(
      new Request('phi-app://app/__phi/active', {
        method: 'POST',
        body: JSON.stringify({ profileId: 'prof-b' }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(await (await second).json()).toMatchObject({
      ok: true,
      profileId: 'prof-b',
    });
    releaseA();
    await first;

    expect(transport.getActiveProfileId()).toBe('prof-b');
  });

  it('pin: a request answered by one profile is never re-aimed by a later flip', async () => {
    const { transport } = harness;
    transport.setActiveProfile('prof-a');
    const inFlight = transport.handleRequest(headerless('/api/peers/status'));
    // The flip happens while the row is in flight.
    transport.setActiveProfile('prof-b');
    await inFlight;
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_A}/api/peers`),
      ),
    ).toBe(true);
  });

  it('pin: after the flip completes, headerless requests go to the new profile', async () => {
    const { transport } = harness;
    transport.setActiveProfile('prof-a');
    transport.setActiveProfile('prof-b');
    await transport.handleRequest(headerless('/api/peers/status'));
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_B}/api/peers`),
      ),
    ).toBe(true);
    expect(
      harness.upstream.mock.calls.some(([url]) =>
        String(url).startsWith(`${ORIGIN_A}/api/peers`),
      ),
    ).toBe(false);
  });

  it('pin: interleaved proxied rows keep the two servers’ cookie jars apart', async () => {
    const { transport } = harness;
    transport.setActiveProfile('prof-a');
    const jarA = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'phi_access_session=cookie-A; Path=/' },
    });
    const jarB = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'phi_access_session=cookie-B; Path=/' },
    });
    harness.queue(jarA);
    harness.queue(jarB);

    await Promise.all([
      transport.handleRequest(headerless('/api/peers/status')),
      transport.handleRequest(
        new Request('phi-app://app/api/peers/status', {
          headers: { 'x-phi-backend': 'prof-b' },
        }),
      ),
    ]);

    expect(transport.getCookieHeader('prof-a')).toBe(
      'phi_access_session=cookie-A',
    );
    expect(transport.getCookieHeader('prof-b')).toBe(
      'phi_access_session=cookie-B',
    );
  });
});
