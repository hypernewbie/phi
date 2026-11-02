import { afterEach, describe, expect, it, vi } from 'vitest';
import { installStreamDeckAdapter } from '../web/streamdeck-adapter.js';

function makeManager(tabs, activePaneId = null) {
    const manager = {
        tabs: new Map(tabs.map((tab) => [tab.paneId, tab])),
        activePaneId,
        switchTab(paneId) {
            this.activePaneId = paneId;
            this._streamDeckAdapterChanged?.();
        },
        getActiveTab() {
            return this.tabs.get(this.activePaneId);
        },
        _streamDeckAdapterChanged: null,
    };
    return manager;
}

function tab(paneId, overrides = {}) {
    return {
        paneId,
        title: paneId,
        coder: 'pi',
        isDead: false,
        ws: { readyState: 1 },
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Stream Deck page adapter', () => {
    it('projects bounded tab metadata without drafts or session paths', () => {
        const manager = makeManager(
            [
                tab('pane-a', {
                    title: 'Build',
                    draft: 'private prompt',
                    sessionPath: '/private/session.jsonl',
                }),
                tab('pane-b', { coder: 'pi-rpc', ws: null }),
            ],
            'pane-a',
        );
        const adapter = installStreamDeckAdapter(manager);
        expect(adapter).not.toBeNull();
        const state = adapter.getState();
        expect(state).toMatchObject({
            version: 1,
            revision: 0,
            activePaneId: 'pane-a',
            tabs: [
                {
                    paneId: 'pane-a',
                    label: 'Build',
                    type: 'pi',
                    selected: true,
                    connection: 'connected',
                },
                {
                    paneId: 'pane-b',
                    type: 'pi-rpc',
                    connection: 'local',
                },
            ],
        });
        expect(state.documentNonce).toMatch(/^[0-9a-f]{32}$/);
        expect(JSON.stringify(state)).not.toContain('private prompt');
        expect(JSON.stringify(state)).not.toContain('session.jsonl');
        adapter.dispose();
    });

    it('selects only existing, visible pane IDs and returns authoritative readback', () => {
        const manager = makeManager([tab('pane-a'), tab('pane-b')], 'pane-a');
        const adapter = installStreamDeckAdapter(manager);
        expect(adapter.selectTab('missing')).toEqual({
            ok: false,
            reason: 'missing',
        });
        expect(manager.activePaneId).toBe('pane-a');
        const result = adapter.selectTab('pane-b');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.state.activePaneId).toBe('pane-b');
            expect(result.state.revision).toBe(1);
        }
        adapter.dispose();
    });

    it('hides soft-closing panes and refuses to select them', () => {
        const manager = makeManager(
            [tab('pane-a'), tab('pane-b', { softClosing: true })],
            'pane-b',
        );
        const adapter = installStreamDeckAdapter(manager);
        expect(adapter.getState()?.tabs.map((item) => item.paneId)).toEqual([
            'pane-a',
        ]);
        expect(adapter.getState()?.activePaneId).toBeNull();
        expect(adapter.selectTab('pane-b')).toEqual({
            ok: false,
            reason: 'missing',
        });
        adapter.dispose();
    });

    it('notifies the single revision waiter after tab rename, reorder, or selection', async () => {
        const manager = makeManager([tab('pane-a'), tab('pane-b')], 'pane-a');
        const adapter = installStreamDeckAdapter(manager);
        const waiting = adapter.waitForRevision(0, 10_000);
        manager.tabs.get('pane-a').title = 'Renamed';
        manager.tabs = new Map([
            ['pane-b', manager.tabs.get('pane-b')],
            ['pane-a', manager.tabs.get('pane-a')],
        ]);
        manager.activePaneId = 'pane-b';
        manager._streamDeckAdapterChanged();
        await expect(waiting).resolves.toMatchObject({
            kind: 'changed',
            state: {
                revision: 1,
                activePaneId: 'pane-b',
                tabs: [
                    { paneId: 'pane-b' },
                    { paneId: 'pane-a', label: 'Renamed' },
                ],
            },
        });
        adapter.dispose();
    });

    it('replaces or cancels the one outstanding wait instead of accumulating timers', async () => {
        const adapter = installStreamDeckAdapter(
            makeManager([tab('pane-a')], 'pane-a'),
        );
        const first = adapter.waitForRevision(0, 10_000);
        const second = adapter.waitForRevision(0, 10_000);
        await expect(first).resolves.toEqual({ kind: 'cancelled' });
        adapter.cancelWait();
        await expect(second).resolves.toEqual({ kind: 'cancelled' });
        adapter.dispose();
    });

    it('caps heartbeat waits at ten seconds and wakes a waiter on disposal', async () => {
        vi.useFakeTimers();
        const adapter = installStreamDeckAdapter(
            makeManager([tab('pane-a')], 'pane-a'),
        );
        const waiting = adapter.waitForRevision(0, 20_000);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(waiting).resolves.toEqual({ kind: 'timeout' });
        const disposedWait = adapter.waitForRevision(0, 10_000);
        adapter.dispose();
        await expect(disposedWait).resolves.toEqual({ kind: 'disposed' });
    });

    it('fails closed instead of truncating an oversized tab list', () => {
        const manager = makeManager(
            Array.from({ length: 129 }, (_, index) => tab(`pane-${index}`)),
            'pane-0',
        );
        const adapter = installStreamDeckAdapter(manager);
        expect(adapter.getState()).toBeNull();
        adapter.dispose();
    });

    it('does not install when secure random bytes are unavailable', () => {
        vi.stubGlobal('crypto', undefined);
        expect(
            installStreamDeckAdapter(makeManager([tab('pane-a')])),
        ).toBeNull();
    });
});
