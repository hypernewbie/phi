// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

vi.mock('../web/ws.js', () => ({ PTYWebSocket: class {} }));

afterEach(() => vi.unstubAllGlobals());

it('keeps pin toggles optimistic and consumes the empty backend response', async () => {
    let finish;
    const fetcher = vi.fn(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    vi.stubGlobal('fetch', fetcher);
    const tab = { pinned: false, tabEl: document.createElement('div') };
    const manager = Object.create(TabManager.prototype);
    manager.tabs = new Map([['pane', tab]]);
    manager.saveTabsState = vi.fn();
    const text = vi.fn(async () => '');

    manager.togglePinTab('pane');

    expect(tab.pinned).toBe(true);
    expect(tab.tabEl.classList.contains('pinned')).toBe(true);
    expect(manager.saveTabsState).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
        '/api/terminals/pane/pin',
        expect.objectContaining({ method: 'POST' }),
    );
    finish({ text });
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
});

it('consumes scoped pin-sync responses without blocking socket attachment', async () => {
    let finish;
    const scopedFetch = vi.fn(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const manager = Object.create(TabManager.prototype);
    manager.app = { scope: { fetch: scopedFetch } };
    manager._hotOptions = vi.fn(() => ({}));
    manager._setCurrentTabSocket = vi.fn();
    const tab = { paneId: 'pane', coder: 'bash', pinned: true };
    const text = vi.fn(async () => '');

    manager._connectTabSocket(tab);

    expect(manager._setCurrentTabSocket).toHaveBeenCalledOnce();
    expect(scopedFetch).toHaveBeenCalledWith(
        '/api/terminals/pane/pin',
        expect.objectContaining({ method: 'POST' }),
    );
    expect(globalFetch).not.toHaveBeenCalled();
    finish({ text });
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
});
