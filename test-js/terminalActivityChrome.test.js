// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

const tab = (overrides = {}) => ({
    isDead: false,
    isBusy: false,
    isAttention: false,
    ...overrides,
});

function renderChrome(manager) {
    TabManager.prototype.updateDocumentTitle.call(manager);
}

describe('terminal activity chrome rendering', () => {
    let app;
    let manager;

    beforeEach(() => {
        document.body.innerHTML = `
            <span id="terminal-activity-indicator" class="terminal-activity-indicator hidden">—</span>
        `;
        app = { hostname: 'atlas', setTerminalActivity: vi.fn() };
        manager = { tabs: new Map(), app };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders the fixed-width quiet dash and settled Phi title', () => {
        renderChrome(manager);

        const indicator = document.getElementById('terminal-activity-indicator');
        expect(document.title).toBe('Φ atlas');
        expect(indicator.textContent).toBe('—');
        expect(indicator.classList.contains('hidden')).toBe(false);
        expect(indicator.classList.contains('is-active')).toBe(false);
        expect(indicator.getAttribute('aria-label')).toBe('All terminal tabs are quiet');
        expect(app.setTerminalActivity).toHaveBeenCalledWith(false);
    });

    it('renders the cursor and curly Phi when any live tab writes', () => {
        manager.tabs.set('live', tab({ isBusy: true }));
        renderChrome(manager);

        const indicator = document.getElementById('terminal-activity-indicator');
        expect(document.title).toBe('ϕ atlas');
        expect(indicator.textContent).toBe('▍');
        expect(indicator.classList.contains('is-active')).toBe(true);
        expect(indicator.getAttribute('aria-label')).toBe('Terminal output on one or more tabs');
        expect(app.setTerminalActivity).toHaveBeenCalledWith(true);
    });

    it('composes rather than repurposes the existing attention dot', () => {
        manager.tabs.set('done', tab({ isAttention: true }));
        manager.tabs.set('live', tab({ isBusy: true }));
        renderChrome(manager);

        expect(document.title).toBe('● ϕ atlas');
    });

    it('enters the live state on the first output byte, not every byte', () => {
        const updateDocumentTitle = vi.fn();
        const syncBackendPin = vi.fn();
        const term = { write: vi.fn() };
        const tabInfo = tab({
            writeBuffer: '',
            writePending: false,
            pinned: true,
            loaderEl: null,
            term,
        });
        const writeManager = { updateDocumentTitle, syncBackendPin };
        vi.stubGlobal('requestAnimationFrame', (callback) => {
            callback();
            return 1;
        });

        TabManager.prototype.writeToTerminal.call(writeManager, tabInfo, 'one');
        TabManager.prototype.writeToTerminal.call(writeManager, tabInfo, 'two');

        expect(tabInfo.isBusy).toBe(true);
        expect(updateDocumentTitle).toHaveBeenCalledTimes(1);
        // writeToTerminal now passes a completion callback (scroll-area
        // sync) as write's 2nd arg; the data payload is what this test pins.
        expect(term.write).toHaveBeenCalledWith('one', expect.any(Function));
        expect(term.write).toHaveBeenCalledWith('two', expect.any(Function));
    });

    it('returns to quiet after the existing three-second output idle window', () => {
        const updateDocumentTitle = vi.fn();
        const idleTab = tab({
            paneId: 'background',
            isBusy: true,
            lastOutputAt: Date.now() - 3001,
            busyStartTime: Date.now(),
            pinned: true,
            coder: 'pi',
            tabEl: document.createElement('div'),
        });
        const idleManager = {
            tabs: new Map([['background', idleTab]]),
            activePaneId: null,
            updateDocumentTitle,
            syncBackendPin: vi.fn(),
            triggerAttentionNotification: vi.fn(),
        };

        TabManager.prototype.pollTerminalIdleAndNotifications.call(idleManager);

        expect(idleTab.isBusy).toBe(false);
        expect(updateDocumentTitle).toHaveBeenCalledOnce();
    });

    it('adds completion attention in the same idle pass that settles Phi', () => {
        const updateDocumentTitle = vi.fn();
        const triggerAttentionNotification = vi.fn();
        const doneTab = tab({
            paneId: 'background',
            isBusy: true,
            lastOutputAt: Date.now() - 3001,
            busyStartTime: Date.now() - 8001,
            pinned: true,
            coder: 'pi',
            tabEl: document.createElement('div'),
        });
        const doneManager = {
            tabs: new Map([['background', doneTab]]),
            activePaneId: null,
            updateDocumentTitle,
            syncBackendPin: vi.fn(),
            triggerAttentionNotification,
        };

        TabManager.prototype.pollTerminalIdleAndNotifications.call(doneManager);

        expect(doneTab.isBusy).toBe(false);
        expect(doneTab.isAttention).toBe(true);
        expect(updateDocumentTitle).toHaveBeenCalledOnce();
        expect(triggerAttentionNotification).toHaveBeenCalledWith(doneTab, false);
    });
});
