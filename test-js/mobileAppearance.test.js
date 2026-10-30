// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    EMPTY_MOBILE,
    selectAppearanceProfile,
    currentAppearanceProfile,
    writeProfileOverride,
    effectiveAppearance,
    applyAppearanceFonts,
    mobileSystemTextRatio,
    captureAppearanceScope,
    appearanceOwner,
    appearanceCacheKey,
    readAppearanceCache,
} from '../web/mobile-appearance.js';
import { BackendScope } from '../web/backend-scope.js';
import { openSettingsModal } from '../web/settings.js';
import { App } from '../web/app.js';
import { TabManager } from '../web/terminal.js';
import { applyPrepaintAppearance } from '../web/theme.js';

setupDomHarness();
afterEach(() => {
    document.querySelector('.settings-overlay .modal-close-btn')?.click();
    applyAppearanceFonts(
        'desktop',
        effectiveAppearance('desktop', {}, EMPTY_MOBILE),
    );
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    writeProfileOverride('auto');
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    document.getElementById('phi-prepaint-appearance')?.remove();
    document.documentElement.removeAttribute('data-appearance-profile');
});

describe('appearance profile, not viewport layout', () => {
    it.each([
        ['iPhone', 'iPhone', 5, 'mobile'],
        ['Android', 'Linux armv8l', 5, 'mobile'],
        ['iPad', 'iPad', 5, 'mobile'],
        ['Desktop Safari', 'MacIntel', 5, 'mobile'],
        ['Desktop Chrome', 'Win32', 5, 'desktop'],
        ['Desktop Chrome', 'MacIntel', 0, 'desktop'],
        ['', '', 0, 'desktop'],
    ])(
        '%s / %s / %i chooses %s',
        (userAgent, platform, touchPoints, expected) => {
            expect(
                selectAppearanceProfile({
                    native: false,
                    userAgent,
                    platform,
                    touchPoints,
                }),
            ).toBe(expected);
        },
    );
    it.each(['desktop', 'mobile'])(
        'honors explicit %s unless native',
        (override) => {
            const identity = {
                native: false,
                override,
                userAgent: 'iPhone',
                platform: 'iPhone',
                touchPoints: 5,
            };
            expect(selectAppearanceProfile(identity)).toBe(override);
            expect(selectAppearanceProfile({ ...identity, native: true })).toBe(
                'desktop',
            );
        },
    );
    it.each(['desktop=1', 'desktop-popout=1'])(
        'forces desktop for %s',
        (marker) => {
            writeProfileOverride('mobile');
            window.history.replaceState(null, '', `/?${marker}`);
            expect(currentAppearanceProfile()).toBe('desktop');
        },
    );
    it('never imports desktop sizes as mobile overrides', () => {
        const desktop = {
            ui_font_size: 24,
            terminal_font_size: 28,
            ui_font_family: 'serif',
            terminal_font_family: 'monospace',
        };
        expect(
            effectiveAppearance('mobile', desktop, EMPTY_MOBILE),
        ).toMatchObject({
            ui_font_size: 17,
            terminal_font_size: 14,
            ui_font_family: 'serif',
        });
        expect(
            effectiveAppearance('desktop', desktop, {
                ...EMPTY_MOBILE,
                ui_font_size: 21,
            }),
        ).toMatchObject({ ui_font_size: 24 });
        expect(
            effectiveAppearance('mobile', desktop, {
                ...EMPTY_MOBILE,
                ui_font_family: '',
            }).ui_font_family,
        ).toBe('');
    });
    it('assigns hostile cached fonts as properties, not stylesheet rules', () => {
        const values = effectiveAppearance(
            'mobile',
            {},
            { ...EMPTY_MOBILE, ui_font_family: 'serif;} html{display:none}/*' },
        );
        applyAppearanceFonts('mobile', values);
        const sheet = document.getElementById('phi-prepaint-appearance').sheet;
        expect(sheet.cssRules).toHaveLength(1);
        expect(sheet.cssRules[0].selectorText).toBe('body');
        expect(document.documentElement.style.display).toBe('');
        expect(sheet.cssRules[0].style.fontSize).toBe('17px');
    });
    it.each([
        [-1, 1],
        [0, 1],
        [NaN, 1],
        [Infinity, 1],
        [10, 1],
        [17, 1],
        [34, 2],
        [53, 53 / 17],
    ])('normalizes system body %s to ratio %s', (size, ratio) => {
        expect(mobileSystemTextRatio(size)).toBe(ratio);
    });
    it('scales the selected mobile UI once on live resize, preserves family and terminal preference, and disposes on desktop', () => {
        let resize;
        const disconnect = vi.fn();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback) {
                    resize = callback;
                }
                observe() {}
                disconnect = disconnect;
            },
        );
        let systemSize = '17px';
        const computed = window.getComputedStyle.bind(window);
        vi.stubGlobal('getComputedStyle', (element) =>
            element.id === 'phi-system-text-probe'
                ? { fontSize: systemSize }
                : computed(element),
        );
        const appearance = effectiveAppearance(
            'mobile',
            {},
            {
                ...EMPTY_MOBILE,
                ui_font_size: 22,
                ui_font_family: 'Georgia, serif',
                terminal_font_size: 19,
            },
        );
        applyAppearanceFonts('mobile', appearance);
        expect(document.body.style.fontSize).toBe('22px');
        systemSize = '34px';
        resize();
        expect(document.body.style.fontSize).toBe('44px');
        applyAppearanceFonts('mobile', appearance);
        expect(document.body.style.fontSize).toBe('44px');
        expect(document.body.style.fontFamily).toBe('Georgia, serif');
        expect(appearance.terminal_font_size).toBe(19);
        expect(
            document.querySelectorAll('#phi-system-text-probe'),
        ).toHaveLength(1);
        systemSize = '17px';
        resize();
        expect(document.body.style.fontSize).toBe('22px');
        applyAppearanceFonts(
            'desktop',
            effectiveAppearance('desktop', { ui_font_size: 16 }, EMPTY_MOBILE),
        );
        expect(document.body.style.fontSize).toBe('16px');
        expect(document.getElementById('phi-system-text-probe')).toBeNull();
        expect(disconnect).toHaveBeenCalledOnce();
    });
    it('scopes caches by profile and backend origin and rejects malformed snapshots', () => {
        const a = new BackendScope('same', 'http://a.test'),
            b = new BackendScope('same', 'http://b.test');
        expect(appearanceOwner(a)).not.toBe(appearanceOwner(b));
        localStorage.setItem(
            appearanceCacheKey(a),
            JSON.stringify({
                schema: 1,
                mobile: { ...EMPTY_MOBILE, ui_font_size: 21 },
            }),
        );
        expect(readAppearanceCache(a).ui_font_size).toBe(21);
        expect(readAppearanceCache(b)).toBeNull();
        localStorage.setItem(
            appearanceCacheKey(a),
            JSON.stringify({
                schema: 1,
                mobile: { ...EMPTY_MOBILE, ui_font_size: 0 },
            }),
        );
        expect(readAppearanceCache(a)).toBeNull();
    });
    it('rejects ownerless embedded startup before requests', () => {
        window.history.replaceState(null, '', '/config.html?embedded=1');
        expect(captureAppearanceScope).toThrow(/ownership/);
    });
});

function mobileApp() {
    writeProfileOverride('mobile');
    const app = Object.create(App.prototype);
    const store = {
        values: { ...EMPTY_MOBILE, ui_font_size: 21 },
        status: 'Saved',
        error: '',
        draft: {},
        records: { drafts: [] },
        subscribe: vi.fn(() => vi.fn()),
        refresh: vi.fn(),
        edit: vi.fn(),
        invalidateInput: vi.fn(),
    };
    Object.assign(app, {
        mobileAppearanceStore: store,
        uiFontSize: 21,
        terminalFontSize: 14,
        desktopAppearance: {
            ui_font_size: 16,
            terminal_font_size: 18,
            ui_font_family: 'serif',
            terminal_font_family: 'monospace',
        },
        config: {},
        sessionsManager: { workspaces: [] },
        tabManager: {},
    });
    openSettingsModal(
        app,
        { purple: { accent: '#765' } },
        { standalone: true },
    );
    return { app, store };
}

describe('existing Settings mobile event handlers', () => {
    it('names the dialog, wraps keyboard focus, yields to authentication and cleans up on close', () => {
        mobileApp();
        const modal = document.querySelector('.settings-modal');
        const close = modal.querySelector('.modal-close-btn');
        const done = modal.querySelector('.settings-footer button');
        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-label')).toBe('Phi Settings');
        expect(document.activeElement).toBe(close);
        close.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(done);
        done.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(close);
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.focus();
        expect(document.activeElement).toBe(close);
        outside.className = 'access-auth-overlay';
        outside.focus();
        expect(document.activeElement).toBe(outside);
        outside.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(modal.isConnected).toBe(true);
        outside.className = '';
        close.click();
        outside.focus();
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });
    it('hides desktop controls and queues only valid integer mobile sizes', () => {
        const { store } = mobileApp();
        expect(
            document
                .getElementById('settings-ui-font-size')
                .closest('.settings-row').hidden,
        ).toBe(true);
        const input = document.getElementById('settings-mobile-ui-font-size');
        for (const value of ['22', '', '17.5', '25', '20']) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        expect(store.edit.mock.calls).toEqual([
            [{ ui_font_size: 22 }],
            [{ ui_font_size: 20 }],
        ]);
        expect(store.invalidateInput).toHaveBeenCalledTimes(3);
        document.getElementById('settings-mobile-size-reset').click();
        expect(store.edit).toHaveBeenLastCalledWith({ ui_font_size: null });
    });
    it('offers inheritance, built-in families and an atomic reset without touching shared assets', () => {
        const { store } = mobileApp();
        const select = document.getElementById('settings-mobile-ui-font');
        select.value = JSON.stringify('');
        select.dispatchEvent(new Event('change'));
        expect(store.edit).toHaveBeenLastCalledWith({ ui_font_family: '' });
        select.value = 'null';
        select.dispatchEvent(new Event('change'));
        expect(store.edit).toHaveBeenLastCalledWith({ ui_font_family: null });
        document.getElementById('settings-mobile-reset').click();
        expect(store.edit).toHaveBeenLastCalledWith({
            ui_font_size: null,
            terminal_font_size: null,
            ui_font_family: null,
            terminal_font_family: null,
        });
        expect(
            document
                .getElementById('settings-font-upload')
                .closest('.settings-row').hidden,
        ).toBe(false);
    });
    it('keeps another invalid size visible and blocks dispatch when a different field changes', () => {
        const { store } = mobileApp();
        const ui = document.getElementById('settings-mobile-ui-font-size');
        ui.value = '';
        ui.dispatchEvent(new Event('input'));
        const terminal = document.getElementById(
            'settings-mobile-term-font-size',
        );
        terminal.value = '25';
        terminal.dispatchEvent(new Event('input'));
        expect(ui.value).toBe('');
        expect(ui.getAttribute('aria-invalid')).toBe('true');
        expect(store.edit).toHaveBeenLastCalledWith({ terminal_font_size: 25 });
        expect(store.invalidateInput).toHaveBeenCalledTimes(2);
    });
    it('preserves an unavailable custom choice and supplies readable UI/terminal fallbacks', () => {
        const { store } = mobileApp();
        store.values.ui_font_family = 'Phi Custom Font';
        store.values.terminal_font_family = 'Phi Custom Font';
        store.subscribe.mock.calls[0][0]();
        expect(document.getElementById('settings-mobile-ui-font').value).toBe(
            JSON.stringify('Phi Custom Font'),
        );
        expect(
            document.getElementById('settings-mobile-font-note').textContent,
        ).toMatch(/Saved font unavailable on this device/);
        const values = effectiveAppearance('mobile', {}, store.values, {});
        expect(values.ui_font_family).toContain('sans-serif');
        expect(values.terminal_font_family).toContain('monospace');
        expect(store.edit).not.toHaveBeenCalled();
    });
    it('prepaints mobile from scoped server inheritance while desktop retains legacy cache precedence', () => {
        localStorage.setItem(
            'phi_appearance',
            JSON.stringify({
                ui_font_family: 'stale legacy',
                ui_font_size: 24,
            }),
        );
        const scope = captureAppearanceScope();
        localStorage.setItem(
            appearanceCacheKey(scope),
            JSON.stringify({
                schema: 1,
                mobile: EMPTY_MOBILE,
                inheritance: {
                    ui_font_family: 'serif',
                    terminal_font_family: 'monospace',
                },
            }),
        );
        writeProfileOverride('mobile');
        applyPrepaintAppearance();
        expect(document.body.style.fontFamily).toBe('serif');
        expect(document.body.style.fontSize).toBe('17px');
        writeProfileOverride('desktop');
        applyPrepaintAppearance();
        expect(document.body.style.fontFamily).toBe('"stale legacy"');
        expect(document.body.style.fontSize).toBe('24px');
    });
    it('updates existing xterm, diff and bridge-free Pi RPC containers through the shared terminal path', () => {
        const rpc = {
            coder: 'pi-rpc',
            termContainer: document.createElement('div'),
        };
        const term = { term: { options: { fontSize: 14 } } };
        const manager = Object.create(TabManager.prototype);
        manager.tabs = new Map([
            ['rpc', rpc],
            ['term', term],
        ]);
        manager.app = {
            diffController: {
                applyFontFamily: vi.fn(),
                applyFontSize: vi.fn(),
            },
        };
        manager.getActiveTab = () => null;
        manager.applyFontToAllActiveTerminals('monospace');
        manager.applyTerminalFontSizeToAll(20);
        expect(term.term.options).toMatchObject({
            fontFamily: 'monospace',
            fontSize: 20,
        });
        expect(rpc.termContainer.style.fontFamily).toBe('monospace');
        expect(rpc.termContainer.style.fontSize).toBe('20px');
        expect(
            manager.app.diffController.applyFontFamily,
        ).toHaveBeenLastCalledWith('monospace');
        expect(manager.app.diffController.applyFontSize).toHaveBeenCalled();
    });
    it('does not write resolved mobile sizes into the legacy desktop cache', () => {
        const { app } = mobileApp();
        app._saveAppearanceLocal();
        expect(
            JSON.parse(localStorage.getItem('phi_appearance')),
        ).toMatchObject({ ui_font_size: 16, terminal_font_size: 18 });
    });
    it('leaves mobile rendering unchanged when desktop opens the mobile editing view', () => {
        writeProfileOverride('desktop');
        const app = Object.create(App.prototype);
        Object.assign(app, {
            uiFontSize: 16,
            config: {},
            sessionsManager: { workspaces: [] },
            tabManager: {},
        });
        app.applyUIFont();
        openSettingsModal(app, {}, { standalone: true, page: 'mobile' });
        expect(document.body.style.fontSize).toBe('16px');
        expect(
            document.getElementById('settings-mobile-appearance').hidden,
        ).toBe(false);
    });
});
