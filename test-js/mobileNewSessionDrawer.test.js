// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SessionsManager } from '../web/sessions.js';
import { setupDomHarness, mockFetch } from './_dom.js';

setupDomHarness();
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const height = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const matchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
afterEach(() => {
    Object.defineProperty(window, 'innerWidth', width);
    Object.defineProperty(window, 'innerHeight', height);
    if (matchMedia) Object.defineProperty(window, 'matchMedia', matchMedia);
    else delete window.matchMedia;
});
function viewport(w, h, coarse = false) {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: w,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: h,
    });
    window.matchMedia = (query) => ({
        matches: coarse && query === '(pointer: coarse)',
    });
}
function manager() {
    return {
        activeCoder: 'bash',
        activeCWD: '/repo',
        activeWorkspace: '/repo',
        loadSessions: vi.fn(),
        app: { tabManager: { createTab: vi.fn() }, showToast: vi.fn() },
    };
}
function drawer(open = true) {
    document.body.innerHTML = `<aside id="sidebar-panel" class="${open ? 'drawer-open' : ''}"></aside>`;
    return document.getElementById('sidebar-panel');
}

it('closes the compact drawer before the launch response', async () => {
    viewport(390, 844, true);
    const panel = drawer();
    const ctx = manager();
    let complete;
    mockFetch(
        () =>
            new Promise((resolve) => {
                complete = resolve;
            }),
    );
    const launch = SessionsManager.prototype.spawnNewSession.call(ctx);
    try {
        expect(panel.classList.contains('drawer-open')).toBe(false);
        expect(ctx.app.tabManager.createTab).not.toHaveBeenCalled();
    } finally {
        complete({ pane_id: 'new-pane', session_id: 'new-session' });
        await launch;
    }
    expect(ctx.app.tabManager.createTab).toHaveBeenCalledTimes(1);
});

it.each([
    [390, 844, true, true],
    [768, 900, false, true],
    [769, 900, false, false],
    [932, 430, true, true],
    [932, 430, false, false],
    [932, 500, true, true],
    [932, 501, true, false],
    [820, 1180, true, false],
    [1440, 900, false, false],
])('viewport %i×%i coarse=%s closes=%s', async (w, h, coarse, closes) => {
    viewport(w, h, coarse);
    const panel = drawer();
    const ctx = manager();
    const fetcher = mockFetch(() => ({
        pane_id: 'pane',
        session_id: 'session',
    }));
    await SessionsManager.prototype.spawnNewSession.call(ctx);
    expect(panel.classList.contains('drawer-open')).toBe(!closes);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ctx.app.tabManager.createTab).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'closed'])('launches with %s drawer', async (state) => {
    viewport(390, 844, true);
    if (state === 'closed') drawer(false);
    const ctx = manager();
    mockFetch(() => ({ pane_id: 'pane', session_id: 'session' }));
    await SessionsManager.prototype.spawnNewSession.call(ctx);
    expect(ctx.app.tabManager.createTab).toHaveBeenCalledTimes(1);
    expect(ctx.app.showToast).not.toHaveBeenCalled();
});

it.each(['rejected', 'http', 'json'])(
    'reports %s failure without a retry',
    async (failure) => {
        viewport(390, 844, true);
        const panel = drawer();
        const ctx = manager();
        const fetcher = mockFetch(() => {
            if (failure === 'rejected')
                return Promise.reject(new Error('offline'));
            if (failure === 'http')
                return { ok: false, status: 500, text: '  unavailable  ' };
            return { ok: true, text: 'not-json' };
        });
        await SessionsManager.prototype.spawnNewSession.call(ctx);
        expect(panel.classList.contains('drawer-open')).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(ctx.app.tabManager.createTab).not.toHaveBeenCalled();
        expect(ctx.app.showToast).toHaveBeenCalledOnce();
        if (failure === 'http')
            expect(ctx.app.showToast).toHaveBeenCalledWith('unavailable', {
                type: 'error',
            });
    },
);

it.each(['success', 'rejection'])(
    'does not close a reopened drawer on %s',
    async (outcome) => {
        viewport(390, 844, true);
        const panel = drawer();
        const ctx = manager();
        let resolve, reject;
        const fetcher = mockFetch(
            () =>
                new Promise((res, rej) => {
                    resolve = res;
                    reject = rej;
                }),
        );
        const launch = SessionsManager.prototype.spawnNewSession.call(ctx);
        panel.classList.add('drawer-open');
        ctx.activeCoder = 'claude';
        ctx.activeCWD = '/other';
        ctx.activeWorkspace = '/other';
        if (outcome === 'success')
            resolve({
                pane_id: 'pane',
                session_id: 'session',
                pi_bridge: { managed: true },
            });
        else reject(new Error('offline'));
        await launch;
        expect(panel.classList.contains('drawer-open')).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        if (outcome === 'success') {
            expect(ctx.app.tabManager.createTab).toHaveBeenCalledWith(
                'pane',
                'session',
                '+ Shell',
                'bash',
                '/repo',
                '/repo',
                true,
                false,
                '',
                null,
                null,
                { managed: true },
            );
        } else expect(ctx.app.showToast).toHaveBeenCalledOnce();
    },
);
