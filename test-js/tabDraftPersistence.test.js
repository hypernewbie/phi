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
