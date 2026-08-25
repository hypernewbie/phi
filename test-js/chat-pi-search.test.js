// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildSearchCorpus,
    createPiSearchController,
    findSearchMatches,
} from '../web/chat-pi/search.js';

function source(messages) {
    return {
        length: messages.length,
        slice(start, end) {
            return messages.slice(start, end);
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('Pi transcript search corpus', () => {
    it('flattens settled text and excludes unsupported segments', () => {
        const corpus = buildSearchCorpus(
            source([
                {
                    role: 'user',
                    segments: [
                        { kind: 'text', text: 'Oldest target' },
                        { kind: 'unsupported', label: 'future' },
                    ],
                },
                {
                    role: 'assistant',
                    segments: [
                        { kind: 'text', text: 'same target' },
                        { kind: 'thinking', text: 'thinking target' },
                    ],
                },
            ]),
        );
        expect(corpus).toEqual([
            {
                bufferIndex: 0,
                role: 'user',
                flatText: 'Oldest target',
            },
            {
                bufferIndex: 1,
                role: 'assistant',
                flatText: 'same target\nthinking target',
            },
        ]);
        expect(corpus[0].flatText).not.toContain('future');
    });

    it('continues occurrence ordinals across a paired tool call and result', () => {
        const corpus = buildSearchCorpus(
            source([
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'tool-1',
                            name: 'needle-tool',
                            args: {},
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'tool-1',
                    segments: [{ kind: 'text', text: 'needle-result' }],
                },
            ]),
        );
        const matches = findSearchMatches(corpus, 'needle');
        expect(matches.map((match) => match.bufferIndex)).toEqual([0, 0]);
        expect(matches.map((match) => match.occurrence)).toEqual([0, 1]);
    });

    it('matches case-insensitively, preserves duplicate entries, and returns context', () => {
        const corpus = [
            { bufferIndex: 3, role: 'user', flatText: 'prefix Target suffix' },
            { bufferIndex: 8, role: 'assistant', flatText: 'TARGET again' },
        ];
        const matches = findSearchMatches(corpus, 'target');
        expect(matches).toHaveLength(2);
        expect(matches.map((match) => match.bufferIndex)).toEqual([3, 8]);
        expect(matches[0].snippet.toLocaleLowerCase()).toContain('target');
        expect(findSearchMatches(corpus, '')).toEqual([]);
    });
});

describe('Pi transcript search controller', () => {
    it('debounces, reports matches, reveals, marks, and preserves state across close/reopen', () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const revealMessage = vi.fn(() => true);
        const markSearchMatch = vi.fn(() => true);
        const clearSearchMarks = vi.fn();
        const controller = createPiSearchController({
            root,
            revealMessage,
            markSearchMatch,
            clearSearchMarks,
        });
        controller.setSource(
            source([
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'target one' }],
                },
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'target two' }],
                },
            ]),
        );
        expect(controller.toggle()).toBe(true);
        const input = root.querySelector('[data-pi-search-input]');
        input.value = 'target';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(119);
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '0 / 0',
        );
        vi.advanceTimersByTime(1);
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '1 / 2',
        );
        expect(revealMessage).toHaveBeenLastCalledWith(0);
        expect(markSearchMatch).toHaveBeenLastCalledWith(0, 'target', 0);

        root.querySelector('[data-pi-search-next]').click();
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '2 / 2',
        );
        expect(revealMessage).toHaveBeenLastCalledWith(1);
        root.querySelector('[data-pi-search-prev]').click();
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '1 / 2',
        );

        expect(controller.close()).toBe(true);
        expect(
            root.querySelector('.pi-search-bar').classList.contains('hidden'),
        ).toBe(true);
        expect(controller.toggle()).toBe(true);
        expect(input.value).toBe('target');
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '1 / 2',
        );
        controller.destroy();
        expect(root.querySelector('.pi-search-bar')).toBeNull();
    });

    it('selects duplicate occurrences within one message independently', () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const markSearchMatch = vi.fn(() => true);
        const controller = createPiSearchController({
            root,
            revealMessage: vi.fn(() => true),
            markSearchMatch,
            clearSearchMarks: vi.fn(),
        });
        controller.setSource(
            source([
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'target then target' }],
                },
            ]),
        );
        controller.open();
        const input = root.querySelector('[data-pi-search-input]');
        input.value = 'target';
        input.dispatchEvent(new Event('input'));
        vi.advanceTimersByTime(120);
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '1 / 2',
        );
        expect(markSearchMatch).toHaveBeenLastCalledWith(0, 'target', 0);
        root.querySelector('[data-pi-search-next]').click();
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '2 / 2',
        );
        expect(markSearchMatch).toHaveBeenLastCalledWith(0, 'target', 1);
    });

    it('types plain n/N into the query and navigates with Enter/Shift+Enter', () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const revealMessage = vi.fn(() => true);
        const controller = createPiSearchController({
            root,
            revealMessage,
            markSearchMatch: vi.fn(() => true),
            clearSearchMarks: vi.fn(),
        });
        controller.setSource(
            source([
                { role: 'user', segments: [{ kind: 'text', text: 'nNsame' }] },
                { role: 'user', segments: [{ kind: 'text', text: 'nNsame' }] },
            ]),
        );
        controller.open();
        const input = root.querySelector('[data-pi-search-input]');
        for (const key of ['n', 'N', 's', 'a', 'm', 'e']) {
            const event = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
            });
            expect(input.dispatchEvent(event)).toBe(true);
            expect(event.defaultPrevented).toBe(false);
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            input.setRangeText(key, start, end, 'end');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        expect(input.value).toBe('nNsame');
        vi.advanceTimersByTime(120);
        expect(root.querySelector('[data-pi-search-count]').textContent).toBe(
            '1 / 2',
        );
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(revealMessage).toHaveBeenLastCalledWith(1);
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(revealMessage).toHaveBeenLastCalledWith(0);
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(controller.isOpen()).toBe(false);
    });
});
