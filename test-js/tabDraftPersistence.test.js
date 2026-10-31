// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

function manager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.inputTextArea = document.createElement('textarea');
    tm.stagedAttachments = [];
    tm.activePaneId = 'stable-pane';
    tm.tabs.set('stable-pane', {
        paneId: 'stable-pane',
        coder: 'codex',
        draft: '',
    });
    return tm;
}

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('durable browser tab drafts', () => {
    it('round-trips source whitespace and uploaded attachment metadata across managers', () => {
        const tm = manager();
        const text = '\tunsent\n  draft\u00a0  ';
        const attachment = {
            id: 'image',
            name: 'source.png',
            path: '/uploads/source.png',
            type: 'image/png',
            sizeBytes: 42,
            source: 'paste',
        };
        tm.inputTextArea.value = text;
        tm.stagedAttachments = [attachment];
        tm.saveActiveDraft();
        expect(manager().loadTabDraft('stable-pane')).toEqual({
            draft: text,
            draftAttachments: [attachment],
        });
        expect(manager().loadTabDraft('different-pane')).toEqual({});
    });

    it('removes sent or cleared drafts rather than resurrecting stale prompts', () => {
        const tm = manager();
        tm.inputTextArea.value = 'send this';
        tm.saveActiveDraft();
        tm.inputTextArea.value = '';
        tm.saveActiveDraft();
        expect(localStorage.getItem('phi_tab_draft_stable-pane')).toBeNull();
    });

    it('does not persist hidden review/kanban input as a draft', () => {
        for (const coder of ['review', 'kanban']) {
            const tm = manager();
            tm.tabs.get('stable-pane').coder = coder;
            tm.inputTextArea.value = 'another tab text';
            tm.saveActiveDraft();
            expect(
                localStorage.getItem('phi_tab_draft_stable-pane'),
            ).toBeNull();
        }
    });

    it('ignores corrupt storage and filters malformed attachments', () => {
        const tm = manager();
        localStorage.setItem('phi_tab_draft_stable-pane', '{broken');
        expect(tm.loadTabDraft('stable-pane')).toEqual({});
        localStorage.setItem(
            'phi_tab_draft_stable-pane',
            JSON.stringify({
                text: 'keep',
                attachments: [null, {}, { path: '/bad' }],
            }),
        );
        expect(tm.loadTabDraft('stable-pane')).toEqual({
            draft: 'keep',
            draftAttachments: [],
        });
    });

    it('quota/private-mode failures cannot block typing', () => {
        const tm = manager();
        tm.inputTextArea.value = 'keep typing';
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(() => tm.saveActiveDraft()).not.toThrow();
        expect(tm.inputTextArea.value).toBe('keep typing');
    });
});

describe('paste recovery draft storage', () => {
    it('round-trips the recovery status with text and attachments', () => {
        const tm = manager();
        const tab = tm.tabs.get('stable-pane');
        tab.draft = 'held paste';
        tab.pasteRecovery = 'unconfirmed';
        expect(tm.saveTabDraft(tab)).toBe(true);
        expect(manager().loadTabDraft('stable-pane')).toEqual({
            draft: 'held paste',
            draftAttachments: [],
            pasteRecovery: 'unconfirmed',
        });
    });
    it('keeps the old return shape for records without recovery metadata', () => {
        localStorage.setItem(
            'phi_tab_draft_stable-pane',
            JSON.stringify({ text: 'plain', attachments: [] }),
        );
        const loaded = manager().loadTabDraft('stable-pane');
        expect(loaded).toEqual({ draft: 'plain', draftAttachments: [] });
        expect('pasteRecovery' in loaded).toBe(false);
    });
    it.each([
        ['bogus string', 'bogus'],
        ['number', 42],
        ['null', null],
    ])('ignores malformed recovery metadata (%s)', (_label, value) => {
        localStorage.setItem(
            'phi_tab_draft_stable-pane',
            JSON.stringify({
                text: 't',
                attachments: [],
                pasteRecovery: value,
            }),
        );
        const loaded = manager().loadTabDraft('stable-pane');
        expect(loaded.pasteRecovery).toBeUndefined();
        expect('pasteRecovery' in loaded).toBe(false);
    });
    it('reports failure without writing when the serialized draft exceeds the loader limit', () => {
        const tm = manager();
        const tab = tm.tabs.get('stable-pane');
        tab.draft = 'x'.repeat(1024 * 1024);
        expect(tm.saveTabDraft(tab)).toBe(false);
        expect(localStorage.getItem('phi_tab_draft_stable-pane')).toBeNull();
    });
    it('updates durability warnings on every save, including edits and tab switches', () => {
        const tm = manager();
        const tab = tm.getActiveTab();
        tab.pasteRecovery = 'unconfirmed';
        tm.inputTextArea.value = 'recovery';
        tm.saveActiveDraft();
        expect(tab._pasteRecoveryUnsaved).toBe(false);
        const deny = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota');
            });
        tm.inputTextArea.value = 'recovery with edits';
        tm.saveActiveDraft();
        expect(tab.draft).toBe('recovery with edits');
        expect(tab._inputRestriction).toContain('delivery unconfirmed');
        expect(tab._inputRestriction).toContain('session only');
        expect(tm.loadTabDraft(tab.paneId).draft).toBe('recovery');
        deny.mockRestore();
        // switchTab parks outgoing drafts through saveTabDraft, not saveActiveDraft.
        tm.saveTabDraft(tab);
        expect(tab._pasteRecoveryUnsaved).toBe(false);
        expect(tab._inputRestriction).not.toContain('session only');
        expect(tm.loadTabDraft(tab.paneId).draft).toBe('recovery with edits');
    });
    it('clears recovery metadata when text is cleared but attachments remain', () => {
        const tm = manager();
        const tab = tm.getActiveTab();
        tab.pasteRecovery = 'unconfirmed';
        tab._resyncNeeded = true;
        tm.stagedAttachments = [{ id: 'attachment' }];
        tm.saveActiveDraft();
        expect(tab.pasteRecovery).toBeUndefined();
        expect(tab._inputRestriction).toBe(
            'Paste held until live output is resynced.',
        );
        expect(
            JSON.parse(localStorage.getItem('phi_tab_draft_stable-pane')),
        ).not.toHaveProperty('pasteRecovery');
    });
    it('reports quota failure without losing the in-memory draft', () => {
        const tm = manager();
        const tab = tm.tabs.get('stable-pane');
        tab.draft = 'kept in memory';
        vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
            throw new Error('quota');
        });
        expect(tm.saveTabDraft(tab)).toBe(false);
        expect(tab.draft).toBe('kept in memory');
    });
});
