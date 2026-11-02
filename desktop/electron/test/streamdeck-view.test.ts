import { describe, expect, it, vi } from 'vitest';
import {
  StreamDeckViewSession,
  type StreamDeckActivePage,
} from '../src/streamdeck-view.js';
import type { StreamDeckRelayRequestContext } from '../src/streamdeck-relay.js';

function makePageState(
  activePaneId = 'pane-a',
  documentNonce = 'a'.repeat(32),
  revision = 0,
) {
  return {
    version: 1,
    documentNonce,
    revision,
    activePaneId,
    tabs: [
      {
        paneId: 'pane-a',
        label: 'Alpha',
        type: 'pi',
        selected: activePaneId === 'pane-a',
        connection: 'connected',
        draft: 'must not escape',
      },
      {
        paneId: 'pane-b',
        label: 'Beta',
        type: 'claude',
        selected: activePaneId === 'pane-b',
        connection: 'connecting',
      },
    ],
    sessionPath: '/private/session.jsonl',
  };
}

function makePage(initial = makePageState()) {
  let state = initial;
  let destroyed = false;
  const waiters = new Set<(result: string) => void>();
  const webContents = {
    isDestroyed: () => destroyed,
    executeJavaScript: vi.fn(async (script: string): Promise<unknown> => {
      if (script.includes('cancelWait')) {
        for (const resolve of waiters)
          resolve(JSON.stringify({ kind: 'cancelled' }));
        waiters.clear();
        return undefined;
      }
      if (script.includes('waitForRevision')) {
        return new Promise<string>((resolve) => waiters.add(resolve));
      }
      if (script.includes('selectTab')) {
        const match = script.match(/selectTab\?\.\((".*?")\)/);
        const paneId = match ? (JSON.parse(match[1]) as string) : '';
        if (!state.tabs.some((tab) => tab.paneId === paneId)) return false;
        state = makePageState(paneId, state.documentNonce, state.revision + 1);
        return true;
      }
      if (script.includes('getState')) return JSON.stringify(state);
      return null;
    }),
  };
  return {
    context: {
      profileId: 'profile-a',
      webContents,
    } as StreamDeckActivePage,
    webContents,
    waiters,
    replaceState(next: ReturnType<typeof makePageState>) {
      state = next;
      for (const resolve of waiters) {
        resolve(
          JSON.stringify({ kind: 'changed', state: JSON.stringify(state) }),
        );
      }
      waiters.clear();
    },
    destroy() {
      destroyed = true;
    },
  };
}

function context(
  isCurrent: () => boolean = () => true,
): StreamDeckRelayRequestContext {
  return { isCurrent };
}

describe('StreamDeckViewSession', () => {
  it('reports unavailable until the selected view is ready', async () => {
    let page: ReturnType<typeof makePage> | null = null;
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page?.context ?? null,
    });
    expect(await session.getState()).toEqual({ status: 'unavailable' });
    page = makePage();
    expect((await session.getState()).status).toBe('available');
  });

  it('projects only bounded state from the selected page', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    const state = await session.getState();
    expect(state).toMatchObject({
      status: 'available',
      profileId: 'profile-a',
      activePaneId: 'pane-a',
      tabs: [
        {
          paneId: 'pane-a',
          label: 'Alpha',
          type: 'pi',
          connection: 'connected',
        },
        {
          paneId: 'pane-b',
          label: 'Beta',
          type: 'claude',
          connection: 'connecting',
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain('must not escape');
    expect(JSON.stringify(state)).not.toContain('session.jsonl');
  });

  it('binds the current pane without exposing server origin or session data', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    await expect(
      session.handleRequest({ id: 'bind', op: 'bindCurrent' }, context()),
    ).resolves.toEqual({
      status: 'bound',
      target: {
        version: 1,
        profileId: 'profile-a',
        paneId: 'pane-a',
        label: 'Alpha',
      },
    });
  });

  it('switches only an existing pane in the same profile and verifies readback', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    const initial = await session.getState();
    if (initial.status !== 'available') throw new Error('expected ready view');
    await expect(
      session.handleRequest(
        {
          id: 'select',
          op: 'selectTab',
          epoch: initial.epoch,
          profileId: initial.profileId,
          paneId: 'pane-b',
        },
        context(),
      ),
    ).resolves.toMatchObject({
      status: 'selected',
      state: { activePaneId: 'pane-b' },
    });
    expect(page.webContents.executeJavaScript).toHaveBeenCalledTimes(4);
  });

  it('rejects stale epochs, wrong profiles, and missing pane targets', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    const initial = await session.getState();
    if (initial.status !== 'available') throw new Error('expected ready view');
    const base = {
      id: 'select',
      op: 'selectTab' as const,
      epoch: initial.epoch,
      profileId: initial.profileId,
      paneId: 'pane-b',
    };
    await expect(
      session.handleRequest({ ...base, epoch: 'stale' }, context()),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      session.handleRequest({ ...base, profileId: 'other' }, context()),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      session.handleRequest({ ...base, paneId: 'missing' }, context()),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(page.webContents.executeJavaScript).toHaveBeenCalledTimes(4);
  });

  it('invalidates an asynchronous read when the selected view is replaced', async () => {
    const oldPage = makePage();
    const newPage = makePage(makePageState('pane-b', 'b'.repeat(32)));
    let current = oldPage;
    let release!: (value: unknown) => void;
    oldPage.webContents.executeJavaScript.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => current.context,
    });
    const pending = session.getState();
    current = newPage;
    release(JSON.stringify(makePageState()));
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
  });

  it('rotates its epoch when the page document nonce changes', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    const first = await session.getState();
    page.replaceState(makePageState('pane-a', 'b'.repeat(32), 0));
    const second = await session.getState();
    expect(first.status).toBe('available');
    expect(second.status).toBe('available');
    if (first.status === 'available' && second.status === 'available') {
      expect(second.epoch).not.toBe(first.epoch);
    }
  });

  it('keeps thinking control explicitly unavailable until its separate gate passes', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    await expect(
      session.handleRequest(
        {
          id: 'thinking',
          op: 'stepThinking',
          epoch: 'x',
          paneId: 'pane-a',
          steps: 1,
        },
        context(),
      ),
    ).resolves.toEqual({ status: 'unsupported' });
    expect(page.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('pushes one initial snapshot and cancels its page wait on invalidation', async () => {
    const page = makePage();
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    const published: Array<{ status: string; epoch?: string }> = [];
    session.startWatching((state) => published.push(state));
    await vi.waitFor(() => expect(published).toHaveLength(1));
    session.invalidate();
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(1));
    await session.stopWatching();
    expect(page.waiters.size).toBe(0);
    expect(published[1].epoch).not.toBe(published[0].epoch);
  });

  it('stops promptly when renderer reads and cancellation never resolve', async () => {
    const page = makePage();
    vi.spyOn(page.webContents, 'executeJavaScript').mockImplementation(
      (script) =>
        script.includes('getState')
          ? Promise.resolve(JSON.stringify(makePageState()))
          : new Promise(() => {}),
    );
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => page.context,
    });
    session.startWatching(() => {});
    await vi.waitFor(() =>
      expect(page.webContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('waitForRevision'),
      ),
    );

    await expect(session.stopWatching()).resolves.toBeUndefined();
  }, 3000);

  it('switches to a ready view when an old renderer wait does not settle', async () => {
    const oldPage = makePage();
    const nextPage = makePage(makePageState('pane-b', 'b'.repeat(32)));
    nextPage.context.profileId = 'profile-b';
    let current = oldPage;
    const execute =
      oldPage.webContents.executeJavaScript.getMockImplementation();
    if (!execute) throw new Error('page script mock missing');
    oldPage.webContents.executeJavaScript.mockImplementation((script) =>
      script.includes('waitForRevision')
        ? new Promise(() => {})
        : execute(script),
    );
    const session = new StreamDeckViewSession({
      getActiveReadyView: () => current.context,
    });
    const published: Array<{ status: string; profileId?: string }> = [];
    session.startWatching((state) => published.push(state));
    await vi.waitFor(() =>
      expect(oldPage.webContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('waitForRevision'),
      ),
    );

    current = nextPage;
    session.invalidate();
    await vi.waitFor(() =>
      expect(published).toContainEqual(
        expect.objectContaining({
          status: 'available',
          profileId: 'profile-b',
        }),
      ),
    );
    await session.stopWatching();
  }, 3000);
});
