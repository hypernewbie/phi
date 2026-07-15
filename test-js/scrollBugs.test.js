// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// REGRESSION: User reported "sometimes I mouse-scroll and it jumps right
// to top of page." Architect verified two distinct bug classes:
//
//   (1) switchTab() on the already-active tab called
//       activateTabViewport with scrollToBottom:true, which forced the
//       terminal scrollback to the bottom line - losing any scrollback
//       position the user was reading. This is the desktop symptom.
//
//   (2) Mobile: the global window scroll listener in app.js snaps the
//       page to top on ANY scroll event at <=768px viewports, fighting
//       user-initiated scrolls in inner scrollable surfaces.
//
//   (3) Mobile: redundant window.scrollTo(0,0) in input-bar focus/blur
//       setTimeouts. updateLayoutPosition already does this; the extra
//       call fired 50ms/150ms after the user might have started scrolling.
//
// Plus the B-set: 10 focus() calls without { preventScroll: true } that
// could scroll ancestors (kanban board, session modals, sync form,
// markdown editor, search bar) into view on focus.

// (1) Behavior: switchTab already-active does NOT scroll-to-bottom
describe('switchTab on the already-active tab', () => {
    function makeTm({ withTabs = [] } = {}) {
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map();
        tm.activePaneId = null;
        tm.dragSourceId = null;
        tm.tabsContainer = document.createElement('div');
        tm.tabsContainer.id = 'tabs-container';
        document.body.appendChild(tm.tabsContainer);
        // activateTabViewport reads tm.app.config.auto_reconnect. Give it
        // an empty object so the gate evaluates to undefined (default =
        // no auto-reconnect unless the user opts in via config).
        tm.app = { config: {} };

        for (const id of withTabs) {
            const tabEl = document.createElement('div');
            tabEl.className = 'tab';
            tabEl.setAttribute('data-pane-id', id);
            tm.tabsContainer.appendChild(tabEl);
            tm.tabs.set(id, {
                paneId: id,
                title: id,
                coder: 'shell',
                tabEl,
                termContainer: document.createElement('div'),
                isDead: false,
                isReview: false,
                isKanban: false,
                pinned: false,
                marked: false,
            });
        }
        return tm;
    }

    it('does NOT call _spamScrollToBottom when the user clicks the active tab (preserves scrollback position)', () => {
        const tm = makeTm({ withTabs: ['a', 'b'] });
        tm.activePaneId = 'a';

        const spamToBottomSpy = vi.spyOn(tm, '_spamScrollToBottom');
        const activateSpy = vi.spyOn(tm, 'activateTabViewport');

        tm.switchTab('a', { userInitiated: true });

        // activateTabViewport IS still called (for fit + reconnect logic)
        expect(activateSpy).toHaveBeenCalledTimes(1);
        // ...but with scrollToBottom: false so the user's scroll position is preserved.
        // activateTabViewport(tabInfo, options) - options is the 2nd arg.
        const optionsArg = activateSpy.mock.calls[0][1];
        expect(optionsArg).toEqual(expect.objectContaining({ scrollToBottom: false }));
        expect(spamToBottomSpy).not.toHaveBeenCalled();
    });

    it('DOES still allow auto-reconnect when clicking the active (dead) tab', () => {
        // The fit + reconnect path should still run on explicit click,
        // even though we no longer scroll-to-bottom.
        const tm = makeTm({ withTabs: ['a'] });
        tm.activePaneId = 'a';
        tm.tabs.get('a').isDead = true;
        tm.tabs.get('a').coder = 'shell';

        const reconnectSpy = vi.fn();
        tm.reconnectTab = reconnectSpy;

        tm.switchTab('a', { userInitiated: true });

        // activateTabViewport called with force: true (userInitiated) so
        // the auto-reconnect gate is bypassed.
        expect(reconnectSpy).toHaveBeenCalledTimes(1);
    });
});

// (2) + (3) + B-set: static source checks. These are the contract:
// every input/textarea focus() in web/*.js (that targets a real input)
// MUST pass { preventScroll: true }, and the input-bar focus/blur
// setTimeout MUST NOT contain a redundant window.scrollTo.
describe('scroll-related source contracts', () => {
    it('every input/textarea focus() in web/*.js uses preventScroll: true', async () => {
        const fs = await import('node:fs');
        const files = [
            'web/sessions.js',
            'web/kanban.js',
            'web/sync.js',
            'web/markdown.js',
            'web/terminal.js',
        ];
        const offenders = [];
        const NON_INPUT_FOCUS_RE = /(term|xterm|window|self|document|activeTab\.term|tabInfo\.term)\.focus\b/;
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (NON_INPUT_FOCUS_RE.test(line)) continue;
                const m = line.match(/(\w+)\.focus\(\)/);
                if (m) {
                    offenders.push(`${f}:${i + 1}: ${line.trim()}`);
                }
            }
        }
        const msg = offenders.length === 0
            ? 'all input focus() calls pass { preventScroll: true }'
            : `offending calls (missing preventScroll:true):\n  ${offenders.join('\n  ')}`;
        expect(offenders.length, msg).toBe(0);
    });

    it('input-bar focus/blur setTimeout in web/terminal.js does NOT contain redundant window.scrollTo', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');

        // Slice from the focus listener to (just before) the input listener.
        const focusStart = src.indexOf("inputTextArea.addEventListener('focus'");
        const inputStart = src.indexOf("inputTextArea.addEventListener('input'");
        expect(focusStart, 'inputTextArea focus listener not found').toBeGreaterThan(-1);
        expect(inputStart, 'inputTextArea input listener (boundary) not found').toBeGreaterThan(-1);

        const rawBlock = src.slice(focusStart, inputStart);

        // Strip block + line comments so the explanatory comment we
        // added ("updateLayoutPosition already forces window.scrollTo(0,0)
        // on mobile ...") doesn't trip the regex.
        const stripComments = (s) =>
            s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

        const focusBlock = stripComments(rawBlock);
        const blurStartInBlock = focusBlock.indexOf("addEventListener('blur'");
        const blurBlock = focusBlock.slice(blurStartInBlock);

        expect(
            /window\.scrollTo\(/.test(focusBlock),
            `Redundant window.scrollTo call found in input-bar focus handler:\n${rawBlock}`,
        ).toBe(false);
        expect(
            /window\.scrollTo\(/.test(blurBlock),
            `Redundant window.scrollTo call found in input-bar blur handler:\n${rawBlock}`,
        ).toBe(false);
    });
});

describe('terminal scroll ownership', () => {
    it('does not force a non-bottom viewport to any remembered line', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = {
            isDead: false,
            term: { scrollToBottom: vi.fn() },
        };

        tm._spamScroll(tab, false);

        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
        expect(tab.isSpammingBottom).toBeUndefined();
        expect(tab.scrollFollowRaf).toBeNull();
    });

    it('does not follow bottom after the tab dies before its frame recheck', () => {
        const tm = Object.create(TabManager.prototype);
        const frameCallbacks = [];
        vi.stubGlobal('requestAnimationFrame', (callback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const tab = {
            isDead: false,
            term: { scrollToBottom: vi.fn() },
        };

        tm._spamScroll(tab, true);
        tab.isDead = true;
        frameCallbacks[0]();

        expect(tab.term.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('leaves user scrollback alone when fitting a non-bottom terminal', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = {
            isDead: false,
            term: {
                options: { fontSize: 14 },
                buffer: { active: { viewportY: 4, baseY: 5 } },
            },
            fitAddon: { fit: vi.fn() },
        };
        tm.getActiveTab = () => tab;
        tm.isResizing = false;
        tm._spamScroll = vi.fn();
        tm.sendResizeToBackend = vi.fn();

        tm.fitActiveTerminal();

        expect(tab.fitAddon.fit).toHaveBeenCalledOnce();
        expect(tm._spamScroll).toHaveBeenCalledWith(tab, false);
    });
});

describe('scroll source contracts', () => {
    it('has one exact at-bottom predicate and no absolute scrollback restore', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        expect(src).not.toContain('baseY - 1');
        expect(src).not.toContain('scrollToLine(');
        expect(src).not.toContain('lastScrollY');
    });

    it('never resets document scroll from a generic window scroll event', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/app.js', 'utf8');
        expect(src).not.toContain("window.addEventListener('scroll'");
        expect(src).toContain("window.visualViewport.addEventListener('resize', () => this.updateLayoutPosition(true, true))");
        expect(src).toContain("window.visualViewport.addEventListener('scroll', () => this.updateLayoutPosition(false))");
    });
});

// Page-scroll invariant: on desktop viewports, body overflow is hidden,
// so the window itself cannot scroll. Defense-in-depth: even if some
// future code path forgets to gate by viewport width, the user is
// protected by the CSS.
describe('document scroll invariant on desktop', () => {
    it('html, body has overflow: hidden (window cannot scroll on desktop)', async () => {
        const fs = await import('node:fs');
        const css = fs.readFileSync('web/style.css', 'utf8');
        const m = css.match(/^html,\s*body\s*\{[\s\S]*?\}/m);
        expect(m, 'top-level html, body rule not found in style.css').toBeTruthy();
        expect(m[0]).toMatch(/overflow:\s*hidden/);
        expect(m[0]).toMatch(/height:\s*100%/);
    });
});