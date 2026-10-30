// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    COMPACT_VIEWPORT_QUERY,
    SIDEBAR_DRAWER_VIEWPORT_QUERY,
} from '../web-src/util.ts';
import { initDesktopSidebarToggle } from '../web-src/desktop-sidebar.ts';
import { mockFetch, setupDomHarness, stubWebSocket } from './_dom.js';

setupDomHarness();

const HIDDEN_KEY = 'phi_sidebar_hidden';
const HIDDEN_CLASS = 'desktop-sidebar-hidden';

function setViewport(width = 1440, height = 900) {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: width,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: height,
    });
}

function mount() {
    document.body.innerHTML = `
        <div class="header-actions">
            <button
                id="desktop-sidebar-toggle"
                class="header-btn icon-only hidden"
                aria-controls="sidebar-panel"
                aria-expanded="true"
                aria-label="Hide sessions"
                title="Hide sessions"
            ></button>
        </div>
        <button id="mobile-sidebar-toggle"></button>
        <aside id="sidebar-panel"><button id="inside-sidebar"></button></aside>
        <div id="left-resize-handle"></div>
        <main class="terminal-panel"><button id="outside-sidebar"></button></main>
    `;
    const fetchMock = mockFetch();
    stubWebSocket();
    const button = document.getElementById('desktop-sidebar-toggle');
    return { button, fetchMock, dispose: initDesktopSidebarToggle() };
}

function clearFeatureState() {
    document.documentElement.classList.remove(HIDDEN_CLASS);
}

describe('desktop sessions-panel toggle', () => {
    it('toggles synchronously and updates its accessible state', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const { button, fetchMock, dispose } = mount();
        try {
            expect(button.classList.contains('hidden')).toBe(false);
            expect(button.getAttribute('aria-controls')).toBe('sidebar-panel');
            expect(button.getAttribute('aria-expanded')).toBe('true');
            expect(button.getAttribute('aria-label')).toBe('Hide sessions');
            expect(button.title).toBe('Hide sessions');

            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);
            expect(button.getAttribute('aria-expanded')).toBe('false');
            expect(button.getAttribute('aria-label')).toBe('Show sessions');
            expect(button.title).toBe('Show sessions');

            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);
            expect(button.getAttribute('aria-expanded')).toBe('true');
            expect(button.getAttribute('aria-label')).toBe('Hide sessions');
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            dispose();
            clearFeatureState();
        }
    });

    it('keeps desktop visibility separate from drawer topology', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const { button, dispose } = mount();
        try {
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);

            window.innerWidth = 900;
            window.dispatchEvent(new Event('resize'));
            expect(button.classList.contains('hidden')).toBe(true);
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);

            window.innerWidth = 1440;
            window.dispatchEvent(new Event('resize'));
            expect(button.classList.contains('hidden')).toBe(false);
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);
            expect(button.getAttribute('aria-expanded')).toBe('false');
        } finally {
            dispose();
            clearFeatureState();
        }
    });

    it('returns a no-op cleanup when the feature markup is absent', () => {
        document.body.innerHTML = '';
        expect(() => initDesktopSidebarToggle()).not.toThrow();
        clearFeatureState();
    });

    it('removes click and resize listeners on cleanup', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const { button, dispose } = mount();
        dispose();
        try {
            button.click();
            window.innerWidth = 900;
            window.dispatchEvent(new Event('resize'));
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);
            expect(button.getAttribute('aria-expanded')).toBe('true');
        } finally {
            clearFeatureState();
        }
    });

    it.each([
        ['visible', '0', false],
        ['malformed', 'hidden', false],
        ['missing', null, false],
        ['hidden', '1', true],
    ])('reads the %s preference', (_label, stored, hidden) => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        localStorage.clear();
        if (stored !== null) localStorage.setItem(HIDDEN_KEY, stored);
        const { button, dispose } = mount();
        try {
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(hidden);
            expect(button.getAttribute('aria-expanded')).toBe(
                hidden ? 'false' : 'true',
            );
            expect(button.classList.contains('hidden')).toBe(false);
        } finally {
            dispose();
            clearFeatureState();
        }
    });

    it('changes the view when the preference read throws', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const getItem = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
            function (key) {
                if (key === HIDDEN_KEY)
                    throw new DOMException('blocked', 'SecurityError');
                return getItem.call(this, key);
            },
        );
        const { button, dispose } = mount();
        try {
            expect(button.getAttribute('aria-expanded')).toBe('true');
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);
        } finally {
            vi.restoreAllMocks();
            dispose();
            clearFeatureState();
        }
    });

    it('keeps repeated toggles responsive when preference writes throw', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            function (key, value) {
                if (key === HIDDEN_KEY)
                    throw new DOMException('full', 'QuotaExceededError');
                return setItem.call(this, key, value);
            },
        );
        const { button, dispose } = mount();
        try {
            for (let index = 0; index < 4; index++) button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);
            expect(button.getAttribute('aria-expanded')).toBe('true');
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);
            expect(button.getAttribute('aria-expanded')).toBe('false');
        } finally {
            vi.restoreAllMocks();
            dispose();
            clearFeatureState();
        }
    });

    it('works when the localStorage accessor throws', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const descriptor = Object.getOwnPropertyDescriptor(
            window,
            'localStorage',
        );
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('blocked', 'SecurityError');
            },
        });
        const { button, dispose } = mount();
        try {
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);
            expect(button.getAttribute('aria-expanded')).toBe('false');
            button.click();
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);
        } finally {
            if (descriptor)
                Object.defineProperty(window, 'localStorage', descriptor);
            else delete window.localStorage;
            dispose();
            clearFeatureState();
        }
    });

    it('does not change panel widths or narrow-mode state', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        localStorage.setItem('phi_panel_left_width', '96');
        localStorage.setItem('phi_drawer_left_width', '280');
        const { button, dispose } = mount();
        try {
            const panel = document.getElementById('sidebar-panel');
            panel.style.width = '96px';
            panel.classList.add('sidebar-narrow');
            button.click();
            button.click();
            expect(panel.style.width).toBe('96px');
            expect(panel.classList.contains('sidebar-narrow')).toBe(true);
            expect(localStorage.getItem('phi_panel_left_width')).toBe('96');
            expect(localStorage.getItem('phi_drawer_left_width')).toBe('280');
        } finally {
            dispose();
            clearFeatureState();
        }
    });

    it('moves focus only when hiding the focused panel or toggle', () => {
        setViewport();
        vi.stubGlobal('matchMedia', undefined);
        const { button, dispose } = mount();
        const inside = document.getElementById('inside-sidebar');
        const outside = document.getElementById('outside-sidebar');
        const mobile = document.getElementById('mobile-sidebar-toggle');
        try {
            inside.focus();
            button.click();
            expect(document.activeElement).toBe(button);

            outside.focus();
            button.click();
            expect(document.activeElement).toBe(outside);
            button.click();
            expect(document.activeElement).toBe(outside);

            button.focus();
            window.innerWidth = 900;
            window.dispatchEvent(new Event('resize'));
            expect(document.activeElement).toBe(mobile);
        } finally {
            dispose();
            clearFeatureState();
        }
    });

    it('rerenders on both viewport media-query changes and removes listeners', () => {
        const state = new Map([
            [COMPACT_VIEWPORT_QUERY, false],
            [SIDEBAR_DRAWER_VIEWPORT_QUERY, false],
            ['(pointer: coarse)', false],
        ]);
        const lists = new Map();
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = vi.fn((query) => {
            if (!lists.has(query)) {
                const callbacks = new Set();
                lists.set(query, {
                    media: query,
                    get matches() {
                        return state.get(query) ?? false;
                    },
                    addEventListener: (_type, callback) =>
                        callbacks.add(callback),
                    removeEventListener: (_type, callback) =>
                        callbacks.delete(callback),
                    dispatch() {
                        for (const callback of callbacks)
                            callback(new Event('change'));
                    },
                });
            }
            return lists.get(query);
        });
        setViewport();
        const { button, dispose } = mount();
        try {
            button.click();
            state.set(SIDEBAR_DRAWER_VIEWPORT_QUERY, true);
            lists.get(SIDEBAR_DRAWER_VIEWPORT_QUERY).dispatch();
            expect(button.classList.contains('hidden')).toBe(true);
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);

            state.set(SIDEBAR_DRAWER_VIEWPORT_QUERY, false);
            lists.get(SIDEBAR_DRAWER_VIEWPORT_QUERY).dispatch();
            expect(button.classList.contains('hidden')).toBe(false);
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(true);

            window.innerHeight = 400;
            state.set('(pointer: coarse)', true);
            state.set(COMPACT_VIEWPORT_QUERY, true);
            lists.get(COMPACT_VIEWPORT_QUERY).dispatch();
            expect(button.classList.contains('hidden')).toBe(true);
            expect(
                document.documentElement.classList.contains(HIDDEN_CLASS),
            ).toBe(false);

            dispose();
            state.set('(pointer: coarse)', false);
            state.set(COMPACT_VIEWPORT_QUERY, false);
            lists.get(COMPACT_VIEWPORT_QUERY).dispatch();
            expect(button.classList.contains('hidden')).toBe(true);
        } finally {
            dispose();
            if (originalMatchMedia === undefined) delete window.matchMedia;
            else window.matchMedia = originalMatchMedia;
            clearFeatureState();
        }
    });
});
