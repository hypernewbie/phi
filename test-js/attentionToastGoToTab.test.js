// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

describe('attention toast Go to tab action', () => {
    let showToast;
    let switchTab;
    let manager;

    beforeEach(() => {
        // triggerAttentionNotification plays a bell chime; jsdom has no
        // real HTMLMediaElement.play, so stub the Audio constructor.
        vi.stubGlobal(
            'Audio',
            class {
                play() {
                    return Promise.resolve();
                }
            },
        );
        showToast = vi.fn();
        switchTab = vi.fn();
        manager = { app: { showToast }, switchTab };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('offers a Go to tab action that switches to the pane', () => {
        const tab = { paneId: 'pane-7', title: 'build' };

        TabManager.prototype.triggerAttentionNotification.call(
            manager,
            tab,
            true,
        );

        const [message, opts] = showToast.mock.calls[0];
        expect(message).toContain('waiting at a prompt');
        expect(opts.action.text).toBe('Go to tab');

        opts.action.callback();
        expect(switchTab).toHaveBeenCalledWith('pane-7', {
            userInitiated: true,
        });
    });

    it('keeps the action on the completed-execution variant', () => {
        const tab = { paneId: 'pane-9', title: 'tests' };

        TabManager.prototype.triggerAttentionNotification.call(
            manager,
            tab,
            false,
        );

        const [message, opts] = showToast.mock.calls[0];
        expect(message).toContain('completed execution');

        opts.action.callback();
        expect(switchTab).toHaveBeenCalledWith('pane-9', {
            userInitiated: true,
        });
    });
});
