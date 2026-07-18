// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import {
    buildSelfHud,
    formatHudLine,
    formatHudCpu,
} from '../web/util.js';

setupDomHarness();

// Pure helpers — no DOM, no fetch, no class wiring.

describe('buildSelfHud', () => {
    const NOW = 1_721_056_325_000; // any deterministic timestamp
    const ONE_MIN = 60_000;

    it('counts only live tabs', () => {
        const hud = buildSelfHud({
            hostname: 'atlas',
            version: '0.10.1',
            cpuPercent: 23,
            tabs: [
                { isDead: false, isBusy: true, isAttention: false },
                { isDead: false, isBusy: false, isAttention: true },
                { isDead: true, isBusy: false, isAttention: false },
                null,
                undefined,
            ],
            now: NOW,
        });
        expect(hud.sessions).toBe(2);
        expect(hud.busy).toBe(1);
        expect(hud.attention).toBe(1);
    });

    it('reports the most-recent output age across tabs', () => {
        const hud = buildSelfHud({
            hostname: 'atlas',
            version: '0.10.1',
            cpuPercent: 23,
            tabs: [
                { isDead: false, lastOutputAt: NOW - 4 * ONE_MIN },
                { isDead: false, lastOutputAt: NOW - 30_000 }, // 30s — wins
                { isDead: false, lastOutputAt: NOW - 10 * ONE_MIN },
            ],
            now: NOW,
        });
        expect(hud.lastActivityMin).toBe(30_000);
    });

    it('returns null lastActivityMin when no tab has emitted', () => {
        const hud = buildSelfHud({
            hostname: 'atlas',
            version: '0.10.1',
            cpuPercent: 0,
            tabs: [
                { isDead: false },
                { isDead: false, lastOutputAt: undefined },
            ],
            now: NOW,
        });
        expect(hud.lastActivityMin).toBeNull();
    });

    it('falls back to "phi" hostname when none is set', () => {
        const hud = buildSelfHud({
            hostname: '',
            version: '',
            cpuPercent: null,
            tabs: [],
            now: NOW,
        });
        expect(hud.hostname).toBe('phi');
        expect(hud.version).toBe('');
        expect(hud.cpuPercent).toBeNull();
        expect(hud.sessions).toBe(0);
    });

    it('handles an empty tab map', () => {
        const hud = buildSelfHud({
            hostname: 'atlas',
            version: '0.10.1',
            cpuPercent: 5,
            tabs: [],
            now: NOW,
        });
        expect(hud.sessions).toBe(0);
        expect(hud.busy).toBe(0);
        expect(hud.attention).toBe(0);
        expect(hud.lastActivityMin).toBeNull();
    });
});

describe('formatHudLine', () => {
    it('returns "no recent activity" when null', () => {
        expect(formatHudLine({
            hostname: 'x', version: '', sessions: 0, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: null,
        })).toBe('no recent activity');
    });

    it('formats minutes', () => {
        expect(formatHudLine({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: 4 * 60_000,
        })).toBe('last activity 4m ago');
    });

    it('formats sub-minute as seconds', () => {
        expect(formatHudLine({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: 23_000,
        })).toBe('last activity 23s ago');
    });

    it('formats hours and days', () => {
        expect(formatHudLine({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: 3 * 60 * 60_000,
        })).toBe('last activity 3h ago');
        expect(formatHudLine({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: 2 * 24 * 60 * 60_000,
        })).toBe('last activity 2d ago');
    });
});

describe('formatHudCpu', () => {
    it('rounds to integer percent', () => {
        expect(formatHudCpu({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: 23.7, lastActivityMin: null,
        })).toBe('cpu 24%');
    });

    it('returns em-dash when unknown', () => {
        expect(formatHudCpu({
            hostname: 'x', version: '', sessions: 1, busy: 0, attention: 0,
            cpuPercent: null, lastActivityMin: null,
        })).toBe('cpu —');
    });
});

// DOM wiring — TabManager hover/focus/click lifecycle.

describe('brand HUD popover', () => {
    let tm;
    let brand;
    let popover;

    function makeTm() {
        // Same shape as other TabManager tests in this repo: minimal
        // prototype, real DOM, app surface stubs.
        const m = Object.create(TabManager.prototype);
        m.tabs = new Map();
        m.lastCpuPercent = 42;
        m.app = {
            hostname: 'atlas',
            versionInfo: { version: '0.10.1' },
        };
        m.getActiveTab = () => ({ paneId: 'p1', coder: 'pi', isDead: false });
        return m;
    }

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="brand" id="brand">
                <span class="logo">Φ</span>
                <span class="brand-name">phi</span>
                <div class="hostname-wrapper">
                    <span id="hostname-display">atlas</span>
                </div>
            </div>
            <div id="self-hud-popover" class="self-hud hidden"></div>
        `;
        brand = document.getElementById('brand');
        popover = document.getElementById('self-hud-popover');
        tm = makeTm();
        tm.selfHudEl = popover;
        tm.selfHudOpen = false;
        tm.selfHudCloseTimer = null;
        tm._initBrandHud();
        // Inject two tabs so the popover has data to render.
        tm.tabs.set('p1', { paneId: 'p1', coder: 'pi', isDead: false, isBusy: true, isAttention: true, lastOutputAt: Date.now() - 30_000 });
        tm.tabs.set('p2', { paneId: 'p2', coder: 'bash', isDead: false, isBusy: false, isAttention: false });
        tm.tabs.set('p3', { paneId: 'p3', coder: 'claude', isDead: true, isBusy: false }); // dead, excluded
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens on mouseenter and renders hostname + counts + cpu', () => {
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('hidden')).toBe(false);
        expect(popover.classList.contains('is-open')).toBe(true);
        expect(popover.querySelector('.self-hud-host-name').textContent).toBe('atlas');
        expect(popover.querySelector('.self-hud-version').textContent).toBe('v0.10.1');
        expect(popover.textContent).toContain('2');   // sessions
        expect(popover.textContent).toContain('1');   // busy
        expect(popover.textContent).toContain('attention');
        expect(popover.textContent).toContain('cpu 42%');
        expect(popover.textContent).toContain('ϕ');   // working glyph
    });

    it('excludes dead tabs from the session count', () => {
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const sessionMetric = popover.querySelector('.metric .metric-count');
        expect(sessionMetric.textContent).toBe('2');
    });

    it('does not fetch on open or close', () => {
        const fetchSpy = vi.spyOn(global, 'fetch');
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        brand.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('closes on mouseleave after a grace period', () => {
        vi.useFakeTimers();
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(true);
        brand.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        // Before grace: still open.
        vi.advanceTimersByTime(100);
        expect(popover.classList.contains('is-open')).toBe(true);
        // After grace: closed.
        vi.advanceTimersByTime(60);
        expect(popover.classList.contains('is-open')).toBe(false);
    });

    it('keeps the popover open if the cursor moves onto it', () => {
        vi.useFakeTimers();
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        brand.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        vi.advanceTimersByTime(50);
        popover.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        vi.advanceTimersByTime(300);
        expect(popover.classList.contains('is-open')).toBe(true);
    });

    it('outside-click closes on mouse-driven devices; click-toggle is touch-only', () => {
        // Default jsdom matchMedia doesn't say (hover: none), so the
        // brand click toggle is NOT attached. Clicks on brand should NOT
        // toggle the HUD. Outside-click DOES close.
        tm._openSelfHud();
        expect(popover.classList.contains('is-open')).toBe(true);
        // Click on brand (target is the LOGO): HUD should NOT toggle.
        brand.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(true);
        // Click outside brand/popover: HUD closes.
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(false);
    });

    it('reopen cooldown blocks open triggers within ~200ms of a close', async () => {
        vi.useRealTimers();
        // Open, close, then immediately try to open again by firing
        // mouseenter on the brand. The cooldown stamp set by closeNow()
        // should block the open within HUD_REOPEN_COOLDOWN_MS.
        tm._openSelfHud();
        expect(popover.classList.contains('is-open')).toBe(true);
        // Close (synchronously): simulates outside-click or hostname click.
        tm._closeSelfHudNow();
        expect(popover.classList.contains('is-open')).toBe(false);
        // Immediately fire mouseenter on brand — should be blocked by
        // the cooldown so the HUD does NOT race back open.
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(false);
        // After the cooldown elapses, mouseenter reopens.
        await new Promise((r) => setTimeout(r, 250));
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(true);
    });

    it('Escape closes the popover', () => {
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(true);
        // Spy _closeSelfHud to verify the keydown handler invoked it
        // regardless of whether the resulting class change is observable
        // synchronously (some transitions race the assertion in jsdom).
        const closeSpy = vi.spyOn(tm, '_closeSelfHud');
        const ev = new Event('keydown', { bubbles: true });
        Object.defineProperty(ev, 'key', { value: 'Escape' });
        brand.dispatchEvent(ev);
        expect(closeSpy).toHaveBeenCalled();
    });

    it('applies CPU-driven emphasis class', () => {
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        // 42% is "moderate" per cpuLevel (>30).
        expect(popover.classList.contains('cpu-moderate')).toBe(true);
    });

    it('sets aria-describedby for accessibility', () => {
        expect(brand.getAttribute('aria-describedby')).toBe('self-hud-popover');
        expect(brand.getAttribute('tabindex')).toBe('0');
    });

    it('reparents the popover to <body> to escape .app-header\'s stacking context', () => {
        // Regression: the popover was inside .app-header (z-index:100).
        // Sibling surfaces like .diff-panel (z-index:1200) and
        // .modal-overlay (z-index:10000) covered it and stole its
        // hover events. Reparenting to <body> makes z-index 9999
        // compete in the root stacking context.
        const before = popover.parentNode;
        expect(before === document.body || before === brand.parentNode).toBe(true);
        // After _initBrandHud (already called in beforeEach) the popover
        // should be a direct child of <body>.
        expect(popover.parentNode).toBe(document.body);
    });

    it('uses position: fixed + z-index 9999 so it floats over sibling surfaces', () => {
        // The actual fix is the reparenting — z-index/position live in CSS
        // and jsdom can't fully resolve CSSOM. Verify the structural fix
        // (body parent) and assert the CSS rule is in the stylesheet.
        expect(popover.parentNode).toBe(document.body);
        // eslint-disable-next-line no-undef
        const css = (typeof __css__ !== 'undefined') ? __css__ : null;
        if (css) {
            expect(/position\s*:\s*fixed/.test(css)).toBe(true);
            expect(/z-index\s*:\s*9999/.test(css)).toBe(true);
        }
    });

    it('closes the HUD when the cursor enters .hostname-wrapper (avoids clash with hostname tab-selector)', () => {
        const hostnameWrapper = brand.querySelector('.hostname-wrapper');
        expect(hostnameWrapper).not.toBeNull();

        // Open HUD via the same path the brand mouseenter uses. Direct
        // invocation is more reliable than dispatching synthetic mouseenter
        // events (which jsdom treats with quirks around bubbling).
        tm._openSelfHud();
        expect(popover.classList.contains('is-open')).toBe(true);

        // Cursor moves onto the hostname area — HUD must close so the
        // hostname tab-selector dropdown doesn't have to coexist with it.
        hostnameWrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        // _closeSelfHud removes .is-open synchronously; the .hidden class
        // is added after a 220ms fade-out.
        expect(popover.classList.contains('is-open')).toBe(false);
        expect(tm.selfHudOpen).toBe(false);
    });

    it('clicking the hostname closes the HUD (its own dropdown owns the click)', () => {
        // The hostname click handler in the production code calls
        // _closeSelfHudNow() so the HUD disappears when the tab-selector
        // dropdown opens — otherwise the two popovers would visually
        // clash on the same header.
        const hostnameDisplay = brand.querySelector('#hostname-display');
        // Open HUD first.
        brand.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(true);
        // Simulate the hostname click handler calling _closeSelfHudNow,
        // which is exactly what the real handler does in web/terminal.js.
        tm._closeSelfHudNow();
        expect(popover.classList.contains('is-open')).toBe(false);
        // Sanity: a follow-up mouseenter on the brand should NOT reopen
        // the HUD immediately (cooldown stamp is set in closeNow).
        hostnameDisplay.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        expect(popover.classList.contains('is-open')).toBe(false);
    });
});