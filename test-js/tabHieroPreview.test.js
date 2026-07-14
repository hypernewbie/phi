// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Hover preview card - glassmorphism popup showing the big hieroglyph
// + worktree label + path when the user mouses over a tab. Added in
// v0.8.5 alongside the hieroglyph-pool swap (96 real Egyptian
// hieroglyphs from U+13000-U+1342F) - the preview is what makes the
// distinct glyphs actually useful for identifying a worktree.

setupDomHarness();

function mountChromeDom() {
    document.body.innerHTML = `
        <div id="tabs-container"></div>
        <div id="terminals-wrapper"></div>
        <div id="input-bar-container" class="hidden"></div>
        <textarea id="input-textarea"></textarea>
        <button id="send-input-btn"></button>
        <button id="cancel-input-btn"></button>
        <button id="copy-input-btn"></button>
        <button id="direct-mode-toggle"></button>
        <div id="presets-container"></div>
        <button id="ctrl-t-btn" class="hidden"></button>
    `;
}

// buildTab wires a minimal tab object + DOM element the preview cares
// about. The full createTab() flow touches xterm.js + WS + PTY spawn
// and is tested elsewhere; for the preview we only need the bits the
// preview reads.
function attachTab(tm, { paneId, glyph, cwd, label }) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-pane-id', paneId);
    tabEl.dataset.worktreeGlyph = glyph;
    tm.tabsContainer.appendChild(tabEl);
    tm.tabs.set(paneId, {
        paneId,
        title: 'test',
        coder: 'bash',
        workspace: cwd,
        cwd,
        tabEl,
        termContainer: document.createElement('div'),
    });
    return tabEl;
}

beforeEach(() => {
    mountChromeDom();
});

function makeManager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.tabsContainer = document.getElementById('tabs-container');
    return tm;
}

describe('_initHieroPreview', () => {
    it('creates a single shared preview element appended to <body>', () => {
        const tm = makeManager();
        expect(document.getElementById('tab-hiero-preview')).toBeNull();
        tm._initHieroPreview();
        const el = document.getElementById('tab-hiero-preview');
        expect(el).toBeTruthy();
        expect(el.querySelector('.tab-hiero-preview-glyph')).toBeTruthy();
        expect(el.querySelector('.tab-hiero-preview-label')).toBeTruthy();
        expect(el.querySelector('.tab-hiero-preview-path')).toBeTruthy();
        expect(el.querySelector('.tab-hiero-preview-count')).toBeTruthy();
        expect(el.classList.contains('visible')).toBe(false);
    });

    it('is idempotent: a second call does not create a second element', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const first = document.getElementById('tab-hiero-preview');
        tm._initHieroPreview();
        // Same node still present; no duplicate.
        expect(document.getElementById('tab-hiero-preview')).toBe(first);
        expect(document.querySelectorAll('#tab-hiero-preview').length).toBe(1);
    });
});

describe('_showHieroPreview / _hideHieroPreview', () => {
    it('shows on mouseover and hides on mouseout', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const tabEl = attachTab(tm, {
            paneId: 'p1', glyph: '𓀀', cwd: '/Users/dev/code/phi/main',
        });
        // Stub getBoundingClientRect to predictable coords (jsdom layout
        // is fake otherwise).
        tabEl.getBoundingClientRect = () => ({ left: 100, right: 200, top: 0, bottom: 38, width: 100, height: 38 });

        const p = document.getElementById('tab-hiero-preview');
        expect(p.classList.contains('visible')).toBe(false);

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(p.classList.contains('visible')).toBe(true);

        tabEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        expect(p.classList.contains('visible')).toBe(false);
    });

    it('populates glyph, label, and path from the hovered tab', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const tabEl = attachTab(tm, {
            paneId: 'p1', glyph: '𓂀', cwd: '/Users/dev/code/phi/feat-x',
        });
        tabEl.getBoundingClientRect = () => ({ left: 50, right: 150, top: 0, bottom: 38, width: 100, height: 38 });

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const p = document.getElementById('tab-hiero-preview');
        expect(p.querySelector('.tab-hiero-preview-glyph').textContent).toBe('𓂀');
        // getProjectWorktreeLabel uses / - / so '/Users/dev/code/phi/feat-x'
        // -> 'phi/feat-x'.
        expect(p.querySelector('.tab-hiero-preview-label').textContent).toBe('phi/feat-x');
        expect(p.querySelector('.tab-hiero-preview-path').textContent).toBe('/Users/dev/code/phi/feat-x');
    });

    it('counts tabs sharing the same glyph', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        // Three tabs share glyph '𓆎', one has a different glyph.
        attachTab(tm, { paneId: 'a', glyph: '𓆎', cwd: '/repo1' });
        attachTab(tm, { paneId: 'b', glyph: '𓆎', cwd: '/repo2' });
        attachTab(tm, { paneId: 'c', glyph: '𓆎', cwd: '/repo3' });
        const targetTab = attachTab(tm, { paneId: 'd', glyph: '𓈖', cwd: '/other' });

        targetTab.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 38, width: 100, height: 38 });
        targetTab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const p = document.getElementById('tab-hiero-preview');
        expect(p.querySelector('.tab-hiero-preview-count').textContent).toBe('1 tab in this worktree');

        // Now hover one of the three '𓆎' tabs - should count 3.
        const sharedTab = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        sharedTab.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 38, width: 100, height: 38 });
        sharedTab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(p.querySelector('.tab-hiero-preview-count').textContent).toBe('3 tabs in this worktree');
    });

    it('positions the card below the hovered tab', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const tabEl = attachTab(tm, { paneId: 'p1', glyph: '𓀀', cwd: '/x' });
        tabEl.getBoundingClientRect = () => ({ left: 240, right: 340, top: 0, bottom: 38, width: 100, height: 38 });

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const p = document.getElementById('tab-hiero-preview');
        expect(p.style.left).toBe('240px');
        expect(p.style.top).toBe('46px'); // 38 + 8 gap
        expect(parseInt(p.style.minWidth, 10)).toBeGreaterThanOrEqual(180); // widened to readable min
    });

    it('clamps the left position so the card stays on screen', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        // Tab near the right edge of a narrow viewport.
        const tabEl = attachTab(tm, { paneId: 'p1', glyph: '𓀀', cwd: '/x' });
        tabEl.getBoundingClientRect = () => ({ left: 1900, right: 2000, top: 0, bottom: 38, width: 100, height: 38 });
        // Simulate a 1280px viewport.
        Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const p = document.getElementById('tab-hiero-preview');
        // Should be clamped to innerWidth - 200 = 1080, not 1900.
        expect(parseInt(p.style.left, 10)).toBeLessThanOrEqual(1280);
    });

    it('uses glyph fallback when tab.dataset.worktreeGlyph is missing', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', 'p1');
        // No dataset.worktreeGlyph set - some race or weird state.
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set('p1', { paneId: 'p1', coder: 'bash', cwd: '/x', tabEl, termContainer: document.createElement('div') });
        tabEl.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 38, width: 100, height: 38 });

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const p = document.getElementById('tab-hiero-preview');
        // Falls back to '◆' per worktreeGlyph() spec.
        expect(p.querySelector('.tab-hiero-preview-glyph').textContent).toBe('◆');
    });
});

describe('hover preview integration with multiple workspaces', () => {
    it('shows correct hieroglyph + label for each tab across projects', () => {
        const tm = makeManager();
        tm._initHieroPreview();
        const paths = [
            { paneId: 'phi',   glyph: '𓀀', cwd: '/code/github/phi/main' },
            { paneId: 'alpha', glyph: '𓂀', cwd: '/work/alpha/feat' },
            { paneId: 'beta',  glyph: '𓆎', cwd: '/work/beta/x' },
        ];
        const tabs = {};
        for (const p of paths) {
            tabs[p.paneId] = attachTab(tm, p);
            tabs[p.paneId].getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 38, width: 100, height: 38 });
        }
        const p = document.getElementById('tab-hiero-preview');
        for (const { paneId, glyph, cwd } of paths) {
            tabs[paneId].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            expect(p.querySelector('.tab-hiero-preview-glyph').textContent).toBe(glyph);
            expect(p.querySelector('.tab-hiero-preview-path').textContent).toBe(cwd);
        }
    });
});

// ---- Sidebar worktree-header hover preview ------------------------------
//
// Hovering a worktree section header in the left panel shows a compact
// variant of the preview card - smaller glyph, anchored to the right of
// the sidebar, with a count of how many tabs would land in that worktree
// (matching cwd). Same shared DOM element, toggled via the
// .tab-hiero-preview-medium size class.

function mountSidebarDom() {
    const sessionList = document.createElement('div');
    sessionList.id = 'session-list';
    document.body.appendChild(sessionList);
    return sessionList;
}

function attachWorktreeSection(sessionList, { path, glyph, name, branch }) {
    const section = document.createElement('div');
    section.className = 'worktree-section';
    section.setAttribute('data-worktree-path', path);
    const header = document.createElement('div');
    header.className = 'worktree-header';
    const glyphSpan = document.createElement('span');
    glyphSpan.className = 'worktree-section-glyph';
    glyphSpan.textContent = glyph;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'worktree-name';
    nameSpan.textContent = name;
    header.appendChild(glyphSpan);
    header.appendChild(nameSpan);
    if (branch) {
        const branchSpan = document.createElement('span');
        branchSpan.className = 'worktree-branch';
        branchSpan.textContent = `[${branch}]`;
        header.appendChild(branchSpan);
    }
    section.appendChild(header);
    sessionList.appendChild(section);
    return { section, header };
}

describe('_showWorktreeHieroPreview', () => {
    it('wires mouseover/mouseout on #session-list after _initHieroPreview', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        // Sanity check: preview should not be visible initially.
        const p = document.getElementById('tab-hiero-preview');
        expect(p.classList.contains('visible')).toBe(false);
    });

    it('shows preview on worktree-header mouseover with medium size', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓂀', name: 'phi', branch: 'main',
        });
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });

        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const p = document.getElementById('tab-hiero-preview');
        expect(p.classList.contains('visible')).toBe(true);
        // Medium variant flag set so CSS shrinks the glyph + padding.
        expect(p.classList.contains('tab-hiero-preview-medium')).toBe(true);
        expect(p.querySelector('.tab-hiero-preview-glyph').textContent).toBe('𓂀');
        expect(p.querySelector('.tab-hiero-preview-label').textContent).toBe('phi');
        expect(p.querySelector('.tab-hiero-preview-path').textContent).toBe('/code/phi');
    });

    it('positions to the right of the worktree header (sidebar anchor)', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓀀', name: 'phi',
        });
        // Worktree header sits at left:0, right:240 in the sidebar.
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });
        Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });

        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const p = document.getElementById('tab-hiero-preview');
        // Anchor 'right': left = rect.right + 8 = 248.
        expect(p.style.left).toBe('248px');
        expect(p.style.top).toBe('50px');
    });

    it('hides on worktree-header mouseout', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓀀', name: 'phi',
        });
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });
        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(document.getElementById('tab-hiero-preview').classList.contains('visible')).toBe(true);
        header.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        expect(document.getElementById('tab-hiero-preview').classList.contains('visible')).toBe(false);
    });

    it('shows how many open tabs would land in this worktree', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        // Two open tabs share cwd /code/phi.
        attachTab(tm, { paneId: 'p1', glyph: '𓂀', cwd: '/code/phi' });
        attachTab(tm, { paneId: 'p2', glyph: '𓂀', cwd: '/code/phi' });
        attachTab(tm, { paneId: 'p3', glyph: '𓆎', cwd: '/code/other' });

        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓂀', name: 'phi',
        });
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });
        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const count = document.getElementById('tab-hiero-preview')
            .querySelector('.tab-hiero-preview-count').textContent;
        expect(count).toBe('2 tabs open in this worktree');
    });

    it('reports zero open tabs when none share the worktree cwd', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        attachTab(tm, { paneId: 'p1', glyph: '𓆎', cwd: '/somewhere/else' });

        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓂀', name: 'phi',
        });
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });
        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const count = document.getElementById('tab-hiero-preview')
            .querySelector('.tab-hiero-preview-count').textContent;
        expect(count).toBe('no tabs open in this worktree');
    });

    it('toggles back to large variant when switching from worktree to tab hover', () => {
        mountSidebarDom();
        const tm = makeManager();
        tm._initHieroPreview();
        const sessionList = document.getElementById('session-list');
        const { header } = attachWorktreeSection(sessionList, {
            path: '/code/phi', glyph: '𓂀', name: 'phi',
        });
        header.getBoundingClientRect = () => ({ left: 0, right: 240, top: 50, bottom: 88, width: 240, height: 38 });
        const tabEl = attachTab(tm, { paneId: 'p1', glyph: '𓂀', cwd: '/code/phi' });
        tabEl.getBoundingClientRect = () => ({ left: 50, right: 150, top: 0, bottom: 38, width: 100, height: 38 });

        const p = document.getElementById('tab-hiero-preview');

        header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(p.classList.contains('tab-hiero-preview-medium')).toBe(true);

        tabEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(p.classList.contains('tab-hiero-preview-medium')).toBe(false);
    });
});