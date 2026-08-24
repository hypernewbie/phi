// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createReviewTranscriptView } from '../web/review-transcript.js';
import { MessageBuffer } from '../web/chat-pi/message-buffer.js';
import { renderTranscriptStructured } from '../web/chat-pi/render.js';

describe('Review Transcript renderer', () => {
    it('renders the existing review shell and role labels', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Review: demo',
            coder: 'pi',
            refresh: true,
        });

        view.setMessages([
            { role: 'user', text: 'hello' },
            { role: 'assistant', text: 'answer' },
            { role: 'toolResult', text: 'output' },
            { role: 'custom', text: 'fallback' },
        ]);

        expect(root.querySelector('.review-header-title').textContent).toBe(
            'Review: demo',
        );
        expect(root.querySelectorAll('.review-bubble')).toHaveLength(4);
        expect(root.textContent).toContain('User');
        expect(root.textContent).toContain('Assistant');
        expect(root.textContent).toContain('Tool Output');
        expect(root.textContent).toContain('Custom');
        expect(view.refreshButton).not.toBeNull();
    });

    it('keeps temporary streaming content as text and supports empty state', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: '/work/demo',
            status: 'Ready',
        });

        view.setMessages([], '<script>bad()</script>');
        expect(root.querySelector('script')).toBeNull();
        expect(root.textContent).toContain('<script>bad()</script>');

        view.showEmpty();
        expect(root.querySelector('.review-empty').textContent).toBe(
            'No messages found in this session.',
        );
    });

    it('wires copy through the existing callback', () => {
        const copyText = vi.fn();
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Review',
            coder: 'pi',
            copyText,
        });
        view.setMessages([{ role: 'assistant', text: 'copy me' }]);

        root.querySelector('.copy-bubble-btn').click();
        expect(copyText).toHaveBeenCalledWith('copy me');
    });

    // Regression: the legacy session-list bubble renderer must NOT inherit
    // the Pi export CSS reset scope. Adding the class globally bleeds the
    // vendored CSS into the host page's legacy transcript layout.
    it('omits the .pi-export-scope class in legacy mode', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Review: legacy',
            coder: 'pi',
            refresh: true,
        });
        expect(root.classList.contains('pi-export-scope')).toBe(false);
        view.setMessages([{ role: 'assistant', text: 'hi' }]);
        expect(root.classList.contains('pi-export-scope')).toBe(false);
    });
});

describe('Review Transcript renderer (structured mode)', () => {
    it('keeps the active status outside the scroll viewport and honors reduced motion', () => {
        const root = document.createElement('div');
        createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
        });
        const header = root.querySelector('.pi-active-turn');
        const transcript = root.querySelector('.review-chat-wrapper');
        expect(header.parentElement).toBe(root);
        expect(
            transcript.parentElement.classList.contains('review-content-body'),
        ).toBe(true);

        const css = readFileSync('web/style.css', 'utf8');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toMatch(/\.pi-working-dot\s*\{[^}]*animation:\s*none/);
    });

    // Regression: the structured chat-pi view relies on the Pi export CSS
    // reset scope. The class must be added only when the caller opts in
    // via `mode: 'structured'`.
    it('applies .pi-export-scope only in structured mode', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });
        expect(root.classList.contains('pi-export-scope')).toBe(true);
        view.setStructuredMessages(
            [{ role: 'user', segments: [{ kind: 'text', text: 'hi' }] }],
            '',
            new Map(),
        );
        expect(root.classList.contains('pi-export-scope')).toBe(true);
    });

    it('uses a one-character horizontal text inset only for Pi RPC transcripts', () => {
        const css = readFileSync('web/style.css', 'utf8');
        expect(css).toMatch(
            /\.pi-export-scope\s+\.review-chat-wrapper\s*\{[^}]*padding-inline:\s*0\s*;/s,
        );
        expect(css).toMatch(
            /\.pi-export-scope\s+\.user-message\s*,\s*\.pi-export-scope\s+\.assistant-text\s*\{[^}]*padding-inline:\s*1ch\s*;/s,
        );
        expect(css).toMatch(
            /^\.review-chat-wrapper\s*\{[^}]*padding:\s*24px\s*;/m,
        );
    });

    it('starts with the Pi active header and pins hidden', () => {
        const root = document.createElement('div');
        createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
        });

        const header = root.querySelector('.pi-active-turn');
        expect(header.classList.contains('hidden')).toBe(true);
        expect(
            root
                .querySelector('.pi-active-prompt-top')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(
            root
                .querySelector('.pi-active-prompt-bottom')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(
            header.previousElementSibling.classList.contains(
                'review-content-body',
            ),
        ).toBe(true);
        expect(root.lastElementChild).toBe(header);
    });

    it('keeps active markers fresh and pins against stubbed transcript geometry', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
        });
        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'authoritative' }],
                },
            ],
            '',
            new Map(),
        );
        view.setActiveTurn({
            active: true,
            promptText: 'authoritative',
            promptOrigin: 0,
            stateLabel: 'Sent to Pi',
        });
        const transcript = root.querySelector('.review-chat-wrapper');
        const source = root.querySelector('.user-message');
        const top = root.querySelector('.pi-active-prompt-top');
        const bottom = root.querySelector('.pi-active-prompt-bottom');
        transcript.getBoundingClientRect = () => ({ top: 100, bottom: 300 });
        source.getBoundingClientRect = () => ({ top: 50, bottom: 80 });
        transcript.dispatchEvent(new Event('scroll'));
        expect(top.classList.contains('hidden')).toBe(false);
        expect(bottom.classList.contains('hidden')).toBe(true);

        source.getBoundingClientRect = () => ({ top: 320, bottom: 350 });
        transcript.dispatchEvent(new Event('scroll'));
        expect(top.classList.contains('hidden')).toBe(true);
        expect(bottom.classList.contains('hidden')).toBe(false);

        view.setActiveTurn({
            active: true,
            promptText: 'optimistic',
            promptOrigin: 'optimistic',
            stateLabel: 'Sending',
        });
        expect(root.querySelector('[data-pi-active-prompt-index]')).toBeNull();
        expect(
            root.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).not.toBeNull();
        view.setActiveTurn(null);
        expect(top.classList.contains('hidden')).toBe(true);
        expect(bottom.classList.contains('hidden')).toBe(true);
    });

    it('renders .user-message and .assistant-message blocks', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                { role: 'user', segments: [{ kind: 'text', text: 'hi' }] },
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'hello back' }],
                },
            ],
            '',
            new Map(),
        );

        expect(root.querySelectorAll('.user-message')).toHaveLength(1);
        expect(root.querySelectorAll('.assistant-message')).toHaveLength(1);
        expect(root.querySelector('.user-message').textContent).toContain('hi');
        expect(root.querySelector('.assistant-message').textContent).toContain(
            'hello back',
        );
    });

    it('renders thinking text safely and visibly', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'thinking',
                            text: 'thinking **bold** <script>think()</script>',
                        },
                    ],
                },
            ],
            '',
            new Map(),
        );

        const thinking = root.querySelector('.thinking-text');
        expect(thinking).not.toBeNull();
        expect(thinking.textContent).toBe(
            'thinking bold <script>think()</script>',
        );
        expect(thinking.querySelector('strong').textContent).toBe('bold');
        expect(root.querySelector('script')).toBeNull();
    });

    // Regression: the user-block path used `.find` and rendered only the
    // first text segment. A structured user message with two text segments
    // must surface both, in order, each exactly once.
    it('renders every text segment inside a multi-segment user message', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [
                        { kind: 'text', text: 'first part' },
                        { kind: 'thinking', text: 'ignored' },
                        { kind: 'text', text: 'second part' },
                    ],
                },
            ],
            '',
            new Map(),
        );

        const userBlocks = root.querySelectorAll('.user-message');
        expect(userBlocks).toHaveLength(1);
        const segments = root.querySelectorAll('.user-message .user-text');
        expect(segments).toHaveLength(2);
        expect(segments[0].textContent).toContain('first part');
        expect(segments[1].textContent).toContain('second part');
        const text = root.querySelector('.user-message').textContent ?? '';
        expect(text.split('first part').length - 1).toBe(1);
        expect(text.split('second part').length - 1).toBe(1);
    });

    // Regression: the multi-segment user copy button must aggregate text
    // segments in source order so the clipboard matches the DOM reading.
    it('aggregates multi-segment user text for the copy button in source order', () => {
        const copyText = vi.fn();
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            copyText,
        });

        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [
                        { kind: 'text', text: 'alpha' },
                        { kind: 'text', text: 'beta' },
                    ],
                },
            ],
            '',
            new Map(),
        );

        root.querySelector('.user-message .copy-link-btn').click();
        expect(copyText).toHaveBeenCalledWith('alphabeta');
    });

    it('renders a bash toolCall as .tool-execution with .tool-command', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'call-1',
                            name: 'bash',
                            args: { command: 'ls -la' },
                        },
                    ],
                },
            ],
            '',
            new Map([
                [
                    'call-1',
                    {
                        message: { role: 'toolResult', content: 'file.txt' },
                        isError: false,
                    },
                ],
            ]),
        );

        const tool = root.querySelector('.tool-execution');
        expect(tool).not.toBeNull();
        expect(tool.id).toBe('tool-call-call-1');
        expect(tool.classList.contains('success')).toBe(true);
        expect(root.querySelector('.tool-command').textContent).toContain(
            'ls -la',
        );
        expect(root.querySelector('.tool-output').textContent).toContain(
            'file.txt',
        );
    });

    it('renders parallel bash toolCalls as sibling .tool-execution blocks', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'a',
                            name: 'bash',
                            args: { command: 'ls' },
                        },
                        {
                            kind: 'toolCall',
                            id: 'b',
                            name: 'bash',
                            args: { command: 'pwd' },
                        },
                    ],
                },
            ],
            '',
            new Map([
                [
                    'a',
                    {
                        message: { role: 'toolResult', content: 'file1' },
                        isError: false,
                    },
                ],
                [
                    'b',
                    {
                        message: { role: 'toolResult', content: '/work' },
                        isError: false,
                    },
                ],
            ]),
        );

        const tools = root.querySelectorAll('.tool-execution');
        expect(tools).toHaveLength(2);
        expect(tools[0].id).toBe('tool-call-a');
        expect(tools[1].id).toBe('tool-call-b');
    });

    it('keeps windowSize and prepends older messages on demand', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
            pageSize: 2,
        });

        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        // Initial window: last 3 messages (msg-2, msg-3, msg-4).
        expect(
            root.querySelectorAll('.user-message, .assistant-message'),
        ).toHaveLength(3);
        const initialText = root.textContent ?? '';
        expect(initialText).toContain('msg-2');
        expect(initialText).toContain('msg-4');
        expect(initialText).not.toContain('msg-0');

        // First prependOlder slides the window up by 2: now [0..3) which is
        // msg-0, msg-1, msg-2.
        const grew = view.prependOlder(2);
        expect(grew).toBe(true);
        // Slide semantics: DOM never exceeds windowSize.
        expect(
            root.querySelectorAll('.user-message, .assistant-message'),
        ).toHaveLength(3);
        const slidText = root.textContent ?? '';
        expect(slidText).toContain('msg-0');
        expect(slidText).not.toContain('msg-4');

        // Already at start of buffer: another prependOlder returns false.
        expect(view.prependOlder(2)).toBe(false);
    });

    it('appends newer messages within the bounded window', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
        });
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        expect(view.appendNewer(1)).toBe(false);

        expect(view.prependOlder(2)).toBe(true);
        const startBadge = root.querySelector('.review-start-badge');
        expect(startBadge.style.display).toBe('block');

        expect(view.appendNewer(1)).toBe(true);
        expect(
            root.querySelectorAll('.user-message, .assistant-message'),
        ).toHaveLength(3);
        expect(root.textContent).toContain('msg-1');
        expect(root.textContent).toContain('msg-3');
        expect(root.textContent).not.toContain('msg-0');
        expect(root.textContent).not.toContain('msg-4');
        expect(startBadge.style.display).toBe('none');

        expect(view.appendNewer(10)).toBe(true);
        expect(root.textContent).toContain('msg-4');
        expect(
            root.querySelectorAll('.user-message, .assistant-message'),
        ).toHaveLength(3);
        expect(view.appendNewer(1)).toBe(false);
    });

    it('anchors appendNewer on the previously-last message (boundary-top)', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
        });
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        expect(view.prependOlder(2)).toBe(true);
        // Window is now [msg-0, msg-1, msg-2]; the anchor is msg-2's node.
        const anchor = root.querySelector('.assistant-message:last-of-type');
        expect(anchor.textContent).toContain('msg-2');

        // jsdom has no layout: fake geometry. The transcript reports its
        // top at 40; the anchor node's top is 40 + 77 (i.e. 77px of content
        // above it). jsdom also clamps the real scrollTop accessor to
        // scrollHeight - clientHeight (both 0), so shadow it with a plain
        // writable instance property for the duration of the assertion.
        // Everything is restored after.
        const transcript = root.querySelector('.review-chat-wrapper');
        const realTrRect = transcript.getBoundingClientRect;
        const realAnchorRect = anchor.getBoundingClientRect;
        transcript.getBoundingClientRect = () => ({ top: 40 });
        anchor.getBoundingClientRect = () => ({ top: 117 });
        Object.defineProperty(transcript, 'scrollTop', {
            value: 0,
            writable: true,
            configurable: true,
        });
        try {
            expect(view.appendNewer(1)).toBe(true);
            // Boundary-top: scrollTop places the old last message at the
            // viewport top instead of snapping to the new bottom.
            expect(transcript.scrollTop).toBe(77);
        } finally {
            transcript.getBoundingClientRect = realTrRect;
            anchor.getBoundingClientRect = realAnchorRect;
            delete transcript.scrollTop;
        }
        // The anchor node survived the rebuild (cache reuse) and sits in
        // the new window [msg-1, msg-2, msg-3] as the SECOND block — its
        // top is now at the viewport top (boundary-top anchoring).
        const blocks = root.querySelectorAll('.assistant-message');
        expect(blocks[1]).toBe(anchor);
        expect(blocks[1].textContent).toContain('msg-2');
        expect(root.textContent).toContain('msg-3');
        expect(root.textContent).not.toContain('msg-0');
        expect(root.querySelectorAll('[data-append-anchor]')).toHaveLength(0);
    });

    it('shows a jump-to-bottom button only when detached, and it returns to the live tail', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 100,
        });
        const messages = Array.from({ length: 150 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        const transcript = root.querySelector('.review-chat-wrapper');
        const btn = root.querySelector('.scroll-to-bottom-btn');
        expect(btn).not.toBeNull();
        // Newest window and jsdom's zero scrollHeight → treated as at bottom.
        expect(btn.classList.contains('hidden')).toBe(true);

        // Page up: window no longer at newest → button appears.
        expect(view.prependOlder(50)).toBe(true);
        expect(btn.classList.contains('hidden')).toBe(false);

        btn.click();
        // Back at the newest window, snapped to bottom, hidden again.
        expect(root.textContent).toContain('msg-149');
        expect(root.textContent).not.toContain('msg-0');
        // jsdom reports 0/0 geometry, which made the original
        // `scrollTop === scrollHeight` assertion vacuous (0 === 0).
        // Shadow real geometry so the snap assignment is observable.
        Object.defineProperty(transcript, 'scrollHeight', {
            value: 900,
            configurable: true,
        });
        Object.defineProperty(transcript, 'clientHeight', {
            value: 300,
            configurable: true,
        });
        Object.defineProperty(transcript, 'scrollTop', {
            value: 0,
            writable: true,
            configurable: true,
        });
        try {
            btn.click();
            expect(transcript.scrollTop).toBe(900);
            expect(btn.classList.contains('hidden')).toBe(true);
        } finally {
            delete transcript.scrollHeight;
            delete transcript.clientHeight;
            delete transcript.scrollTop;
        }
    });

    it('does not re-trigger window slides when the anchoring scroll settles mid-content', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
        });
        const messages = Array.from({ length: 8 }, (_, i) => ({
            role: 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        view.prependOlder(4); // window [1..4), far from newestStart (5)

        const transcript = root.querySelector('.review-chat-wrapper');
        const appendSpy = vi.spyOn(view, 'appendNewer');
        const prependSpy = vi.spyOn(view, 'prependOlder');
        // Real-browser shape: appendNewer's programmatic scrollTop write
        // fires a scroll event. Fake a mid-content position (250 within
        // 1000/500) — geometry the near-top/near-bottom triggers must
        // both reject — and replay that event.
        Object.defineProperty(transcript, 'scrollHeight', {
            value: 1000,
            configurable: true,
        });
        Object.defineProperty(transcript, 'clientHeight', {
            value: 500,
            configurable: true,
        });
        Object.defineProperty(transcript, 'scrollTop', {
            value: 250,
            writable: true,
            configurable: true,
        });
        try {
            expect(view.appendNewer(1)).toBe(true);
            transcript.dispatchEvent(new Event('scroll'));
            // Only the direct appendNewer call ran; the replayed scroll
            // event re-entered neither slide direction.
            expect(appendSpy).toHaveBeenCalledTimes(1);
            expect(prependSpy).not.toHaveBeenCalled();
        } finally {
            delete transcript.scrollHeight;
            delete transcript.clientHeight;
            delete transcript.scrollTop;
        }
        appendSpy.mockRestore();
        prependSpy.mockRestore();
    });

    it('keeps the live streaming partial visible when jumping to bottom while paged up mid-stream', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
        });
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, 'streaming-delta', new Map());
        expect(view.prependOlder(2)).toBe(true);
        // Paging older rebuilds the window without dropping the live tail.
        const liveBeforeJump = root.querySelector(
            '.assistant-message.pi-streaming',
        );
        expect(liveBeforeJump).not.toBeNull();
        const partialBeforeJump = root.querySelector('.pi-partial');
        expect(partialBeforeJump).not.toBeNull();
        expect(partialBeforeJump?.textContent).toBe('streaming-delta');
        // Paged up mid-stream: the jump button appears even while the
        // live partial is streaming.
        const btn = root.querySelector('.scroll-to-bottom-btn');
        expect(btn).not.toBeNull();
        expect(btn.classList.contains('hidden')).toBe(false);

        btn.click();
        // Click lands on the newest window…
        expect(root.textContent).toContain('msg-4');
        expect(root.textContent).not.toContain('msg-0');
        // …and the slide rebuild re-emits the stashed live tail instead
        // of dropping it for one paint.
        const live = root.querySelector('.assistant-message.pi-streaming');
        expect(live).not.toBeNull();
        const partial = root.querySelector('.pi-partial');
        expect(partial).not.toBeNull();
        expect(partial?.textContent).toBe('streaming-delta');
        expect(btn.classList.contains('hidden')).toBe(true);
    });

    it('never creates a jump-to-bottom button in legacy mode', () => {
        const root = document.createElement('div');
        createReviewTranscriptView(root, {
            title: 'Review',
            coder: 'pi',
            refresh: true,
        });
        expect(root.querySelector('.scroll-to-bottom-btn')).toBeNull();
    });

    // Regression for streaming partial: the partial text must render
    // even when the last settled message in the slice is a user message
    // (the most common flow — user sends prompt, assistant starts
    // streaming before messageEnd lands).
    it('renders streaming partial as a virtual .pi-partial block when the last settled message is a user message', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [{ role: 'user', segments: [{ kind: 'text', text: 'hello' }] }],
            'streaming-delta',
            new Map(),
        );

        const partial = root.querySelector('.pi-partial');
        expect(partial).not.toBeNull();
        expect(partial?.textContent).toBe('streaming-delta');
        // The virtual block is an assistant-message with pi-streaming.
        const live = root.querySelector('.assistant-message.pi-streaming');
        expect(live).not.toBeNull();
        // The user message still renders.
        expect(root.querySelector('.user-message')).not.toBeNull();
    });

    // Regression for bash error status: the renderer must surface a
    // failed tool result with the `.tool-execution.error` class so the
    // vendored CSS can apply --toolErrorBg.
    it('renders a bash toolCall with isError as .tool-execution.error', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'call-err',
                            name: 'bash',
                            args: { command: 'false' },
                        },
                    ],
                },
            ],
            '',
            new Map([
                [
                    'call-err',
                    {
                        message: {
                            role: 'toolResult',
                            content: 'exit code 1',
                        },
                        isError: true,
                    },
                ],
            ]),
        );

        const tool = root.querySelector('.tool-execution');
        expect(tool).not.toBeNull();
        expect(tool.classList.contains('error')).toBe(true);
        expect(tool.classList.contains('success')).toBe(false);
    });

    it('repaints a pending tool call as folded once its result settles to an error', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });
        const messages = [
            {
                role: 'assistant',
                segments: [
                    {
                        kind: 'toolCall',
                        id: 'call-p2e',
                        name: 'bash',
                        args: { command: 'false' },
                    },
                ],
            },
        ];

        // First paint: no result yet → pending, running… visible (not folded).
        view.setStructuredMessages(messages, '', new Map());
        let tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('pending')).toBe(true);
        expect(tool.classList.contains('folded')).toBe(false);

        // Result arrives as an error: the paired-state cache key changes,
        // the node rebuilds, and the settled error arrives folded.
        view.setStructuredMessages(
            messages,
            '',
            new Map([
                [
                    'call-p2e',
                    {
                        message: {
                            role: 'toolResult',
                            content: 'exit code 1',
                        },
                        isError: true,
                    },
                ],
            ]),
        );
        tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('error')).toBe(true);
        expect(tool.classList.contains('folded')).toBe(true);
        // Fold hides via CSS; the output stays in the DOM.
        expect(tool.querySelector('.tool-output').textContent).toContain(
            'exit code 1',
        );
    });

    it('keeps a user-unfolded error block unfolded across repaints (cache reuse)', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });
        const messages = [
            {
                role: 'assistant',
                segments: [
                    {
                        kind: 'toolCall',
                        id: 'call-unfold',
                        name: 'bash',
                        args: { command: 'false' },
                    },
                ],
            },
        ];
        const results = new Map([
            [
                'call-unfold',
                {
                    message: { role: 'toolResult', content: 'exit code 1' },
                    isError: true,
                },
            ],
        ]);

        view.setStructuredMessages(messages, '', results);
        const tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('folded')).toBe(true);

        // User unfolds (header click toggles `.folded`).
        tool.querySelector('.tool-command').dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        );
        expect(tool.classList.contains('folded')).toBe(false);

        // Repaint with identical inputs: the cache key is unchanged, so
        // the same DOM node is reused and its unfolded state survives.
        view.setStructuredMessages(messages, '', results);
        const after = root.querySelector('.tool-execution');
        expect(after).toBe(tool);
        expect(after.classList.contains('folded')).toBe(false);
    });

    // Lock in the markdown-content class on both text-segment kinds.
    // The vendored Pi export styles (.pi-export-scope) reset margins
    // and padding on every descendant, so the chat pane needs an
    // opt-in class to opt into the markdown typography. The chat
    // uses the same `markdown-content` class that Pi's own exporter
    // emits; both `assistant-text` and `user-text` must carry it,
    // and the live streaming partial block must stay plain so it
    // does not re-parse mid-stream.
    it('applies markdown-content to assistant and user text segments', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
        });
        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'ask' }],
                },
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'reply' }],
                },
            ],
            '',
            new Map(),
        );
        const assistantText = root.querySelector('.assistant-text');
        const userText = root.querySelector('.user-text');
        expect(assistantText).not.toBeNull();
        expect(userText).not.toBeNull();
        expect(assistantText.classList.contains('markdown-content')).toBe(true);
        expect(userText.classList.contains('markdown-content')).toBe(true);
        // Streaming partial blocks render plain until they settle.
        view.setStructuredPartial('streaming-partial');
        const streaming = root.querySelector('.pi-streaming');
        if (streaming) {
            const segs = streaming.querySelectorAll('.assistant-text');
            segs.forEach((seg) => {
                expect(seg.classList.contains('markdown-content')).toBe(false);
            });
        }
    });
});

describe('Review Transcript renderer (generic tool calls)', () => {
    // Regression for "subagents execution not rendered correctly": every
    // non-bash toolCall used to render as a raw `name({...})` JSON dump
    // that never resolved its status. It must render an upstream-shaped
    // .tool-execution block with a .tool-header and expandable result.
    it('renders a subagent toolCall with header, args and result', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'sub-1',
                            name: 'subagent',
                            args: {
                                agent: 'worker',
                                action: 'run',
                                task: 'Do a thing',
                            },
                        },
                    ],
                },
            ],
            '',
            new Map([
                [
                    'sub-1',
                    {
                        message: {
                            role: 'toolResult',
                            content: [{ type: 'text', text: 'done' }],
                        },
                        isError: false,
                    },
                ],
            ]),
        );

        const tool = root.querySelector('.tool-execution');
        expect(tool).not.toBeNull();
        expect(tool.classList.contains('success')).toBe(true);
        expect(tool.id).toBe('tool-call-sub-1');
        expect(root.querySelector('.tool-name').textContent).toBe('subagent');
        expect(root.querySelector('.tool-path').textContent).toContain(
            'worker',
        );
        expect(root.textContent).toContain('"agent"');
        expect(root.textContent).toContain('done');
    });

    it('renders a read toolCall with a shortened path header', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'rd-1',
                            name: 'read',
                            args: {
                                file_path: '/Users/n0mad/code/x.ts',
                                offset: 10,
                                limit: 40,
                            },
                        },
                    ],
                },
            ],
            '',
            new Map([
                [
                    'rd-1',
                    {
                        message: { role: 'toolResult', content: 'line1' },
                        isError: false,
                    },
                ],
            ]),
        );

        expect(root.querySelector('.tool-name').textContent).toBe('read');
        expect(root.querySelector('.tool-path').textContent).toBe(
            '~/code/x.ts',
        );
        expect(root.querySelector('.line-numbers').textContent).toBe(':10-49');
        expect(root.querySelector('.tool-output').textContent).toContain(
            'line1',
        );
    });

    // Paired toolResult messages must not duplicate the tool output as a
    // dim assistant block — the call site already renders it inline.
    it('skips toolResult messages whose output is rendered at the call', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                { role: 'user', segments: [{ kind: 'text', text: 'go' }] },
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'call-2',
                            name: 'bash',
                            args: { command: 'ls' },
                        },
                    ],
                },
                { role: 'toolResult', toolCallId: 'call-2', segments: [] },
            ],
            '',
            new Map([
                [
                    'call-2',
                    {
                        message: { role: 'toolResult', content: 'file.txt' },
                        isError: false,
                    },
                ],
            ]),
        );

        expect(root.querySelectorAll('.tool-execution')).toHaveLength(1);
        // The assistant wrapper owns the tool call; the paired result must
        // not render a second block, so the output text appears once.
        const occurrences =
            (root.textContent ?? '').split('file.txt').length - 1;
        expect(occurrences).toBe(1);
    });

    it('keeps an orphaned toolResult as a dim assistant block', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

        view.setStructuredMessages(
            [
                {
                    role: 'toolResult',
                    toolCallId: 'gone',
                    segments: [{ kind: 'text', text: 'late output' }],
                },
            ],
            '',
            new Map(),
        );

        const block = root.querySelector('.assistant-message');
        expect(block).not.toBeNull();
        expect(block.textContent).toContain('late output');
    });
});

describe('Review Transcript renderer (dynamic tool state)', () => {
    it('rebuilds pending bash and subagent calls when their results arrive', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });
        const calls = [
            {
                role: 'assistant',
                segments: [
                    {
                        kind: 'toolCall',
                        id: 'bash-1',
                        name: 'bash',
                        args: { command: 'pwd' },
                    },
                    {
                        kind: 'toolCall',
                        id: 'sub-2',
                        name: 'subagent',
                        args: { agent: 'worker', action: 'run' },
                    },
                ],
            },
        ];

        view.setStructuredMessages(calls, '', new Map());
        let tools = root.querySelectorAll('.tool-execution');
        expect(tools).toHaveLength(2);
        expect(tools[0].classList.contains('pending')).toBe(true);
        expect(tools[1].classList.contains('pending')).toBe(true);

        view.setStructuredMessages(
            [
                ...calls,
                {
                    role: 'toolResult',
                    toolCallId: 'bash-1',
                    segments: [{ kind: 'text', text: '/work/demo' }],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'sub-2',
                    segments: [{ kind: 'text', text: 'worker failed' }],
                },
            ],
            '',
            new Map([
                [
                    'bash-1',
                    {
                        message: { role: 'toolResult', content: '/work/demo' },
                        isError: false,
                    },
                ],
                [
                    'sub-2',
                    {
                        message: {
                            role: 'toolResult',
                            content: 'worker failed',
                        },
                        isError: true,
                    },
                ],
            ]),
        );

        tools = root.querySelectorAll('.tool-execution');
        expect(tools[0].classList.contains('success')).toBe(true);
        expect(tools[1].classList.contains('error')).toBe(true);
        expect(root.textContent).toContain('/work/demo');
        expect(root.textContent).toContain('worker failed');
    });

    it('forwards paired bash exit details through structured rendering', () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 2,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'bash-exit',
                            name: 'bash',
                            arguments: { command: 'false' },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'bash-exit',
                    content: [{ type: 'text', text: 'Command failed' }],
                    isError: true,
                    details: { exitCode: 1 },
                },
            ],
        });

        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });
        view.setStructuredMessages(
            renderTranscriptStructured(buffer.getMessages()),
            '',
            buffer.getToolResultMap(),
        );

        expect(root.querySelector('.tool-status-footer').textContent).toBe(
            '(exit 1)',
        );
    });

    it('renders a result when its paired call is outside the DOM window', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 1,
        });

        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'old-call',
                            name: 'bash',
                            args: { command: 'ls' },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'old-call',
                    segments: [{ kind: 'text', text: 'old-result.txt' }],
                },
            ],
            '',
            new Map(),
        );

        expect(root.querySelector('.tool-execution')).toBeNull();
        expect(root.textContent).toContain('old-result.txt');
    });

    it('keeps a prepended history window across a later transcript update', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
            windowSize: 3,
            pageSize: 2,
        });
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));

        view.setStructuredMessages(messages, '', new Map());
        expect(view.prependOlder(2)).toBe(true);
        view.setStructuredMessages(
            [
                ...messages,
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'msg-5' }],
                },
            ],
            '',
            new Map(),
        );

        expect(root.textContent).toContain('msg-0');
        expect(root.textContent).not.toContain('msg-5');
    });
});

describe('Review Transcript renderer (edit result details)', () => {
    const editCall = (id) => ({
        role: 'assistant',
        segments: [
            {
                kind: 'toolCall',
                id,
                name: 'edit',
                args: { file_path: '/work/example.ts' },
            },
        ],
    });

    const resultMap = (id, diff) =>
        new Map([
            [
                id,
                {
                    message: {
                        role: 'toolResult',
                        content: [{ type: 'text', text: 'fallback output' }],
                        details: { diff },
                    },
                    isError: false,
                },
            ],
        ]);

    const viewFor = (root) =>
        createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            status: 'Ready',
            mode: 'structured',
        });

    it('renders live and hydrated paired edit details without a duplicate result block', () => {
        const liveBuffer = new MessageBuffer();
        liveBuffer.applySnapshot({ lastSeq: 0, messages: [] });
        liveBuffer.applyEvent({
            seq: 1,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'edit-live',
                            name: 'edit',
                            arguments: { file_path: '/work/live.ts' },
                        },
                    ],
                },
            },
        });
        liveBuffer.applyEvent({
            seq: 2,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'toolResult',
                    toolCallId: 'edit-live',
                    content: [{ type: 'text', text: 'fallback output' }],
                    details: { diff: '-4 old\n+4 new' },
                },
            },
        });

        const liveRoot = document.createElement('div');
        const liveView = viewFor(liveRoot);
        liveView.setStructuredMessages(
            renderTranscriptStructured(liveBuffer.getMessages()),
            '',
            liveBuffer.getToolResultMap(),
        );
        expect(liveRoot.querySelector('.tool-diff')).not.toBeNull();
        expect(liveRoot.querySelectorAll('.tool-execution')).toHaveLength(1);
        expect(liveRoot.textContent).not.toContain('fallback output');

        const hydratedBuffer = new MessageBuffer();
        hydratedBuffer.applySnapshot({
            lastSeq: 2,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'edit-hydrated',
                            name: 'edit',
                            arguments: { file_path: '/work/hydrated.ts' },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'edit-hydrated',
                    content: [{ type: 'text', text: 'fallback output' }],
                    details: { diff: '-8 old\n+8 new' },
                },
            ],
        });
        const hydratedRoot = document.createElement('div');
        const hydratedView = viewFor(hydratedRoot);
        hydratedView.setStructuredMessages(
            renderTranscriptStructured(hydratedBuffer.getMessages()),
            '',
            hydratedBuffer.getToolResultMap(),
        );
        expect(hydratedRoot.querySelector('.tool-diff')).not.toBeNull();
        expect(hydratedRoot.querySelector('.diff-removed').textContent).toBe(
            '-8 old',
        );
        expect(hydratedRoot.querySelectorAll('.tool-execution')).toHaveLength(
            1,
        );
        expect(hydratedRoot.textContent).not.toContain('fallback output');
    });

    it('refreshes the cached edit block when only the validated diff changes', () => {
        const root = document.createElement('div');
        const view = viewFor(root);
        const messages = [editCall('edit-cache')];

        view.setStructuredMessages(
            messages,
            '',
            resultMap('edit-cache', '-1 old\n+1 new'),
        );
        const first = root.querySelector('.tool-execution');
        expect(first.querySelector('.diff-added').textContent).toBe('+1 new');

        view.setStructuredMessages(
            messages,
            '',
            resultMap('edit-cache', '-1 old\n+1 new'),
        );
        expect(root.querySelector('.tool-execution')).toBe(first);

        view.setStructuredMessages(
            messages,
            '',
            resultMap('edit-cache', '-1 old\n+1 newer'),
        );
        const refreshed = root.querySelector('.tool-execution');
        expect(refreshed).not.toBe(first);
        expect(refreshed.querySelector('.diff-added').textContent).toBe(
            '+1 newer',
        );
    });

    it('renders resumed Pi snapshot as one structured tool block without legacy prose', () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 2,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'read-resume',
                            name: 'read',
                            arguments: {
                                file_path: '/work/resumed.ts',
                                offset: 1,
                                limit: 3,
                            },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'read-resume',
                    toolName: 'read',
                    content: [{ type: 'text', text: 'first line' }],
                    isError: false,
                },
            ],
        });
        const root = document.createElement('div');
        const view = viewFor(root);
        view.setStructuredMessages(
            renderTranscriptStructured(buffer.getMessages()),
            '',
            buffer.getToolResultMap(),
        );
        const tools = root.querySelectorAll('.tool-execution');
        expect(tools).toHaveLength(1);
        expect(tools[0].id).toBe('tool-call-read-resume');
        const header = tools[0].querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe('read');
        expect(header.querySelector('.tool-path').textContent).toContain(
            'resumed.ts',
        );
        expect(root.querySelector('.tool-output').textContent).toContain(
            'first line',
        );
        expect(root.textContent).not.toContain('Used tool');
        expect(root.textContent).not.toContain('Tool Output');
        expect(root.querySelectorAll('.tool-execution')).toHaveLength(1);
    });

    it('extracts singleton-object toolResult text and shows it exactly once', () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 2,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'singleton-call',
                            name: 'read',
                            arguments: { file_path: '/work/singleton.ts' },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'singleton-call',
                    toolName: 'read',
                    content: { type: 'text', text: 'singleton output' },
                    isError: false,
                },
            ],
        });
        const root = document.createElement('div');
        const view = viewFor(root);
        view.setStructuredMessages(
            renderTranscriptStructured(buffer.getMessages()),
            '',
            buffer.getToolResultMap(),
        );
        expect(root.querySelectorAll('.tool-execution')).toHaveLength(1);
        const combined = root.textContent ?? '';
        const occurrences = combined.split('singleton output').length - 1;
        expect(occurrences).toBe(1);
        expect(root.querySelector('.tool-output').textContent).toContain(
            'singleton output',
        );
    });
});

describe('Review Transcript renderer (active-prompt pins)', () => {
    // Regression: the active-prompt pin lives in contentBody as a sibling
    // overlay of the scroll viewport, so it must not inflate the
    // transcript scrollHeight nor shift the boundary anchor used by
    // appendNewer. The hidden baseline establishes the same structured
    // messages with no active turn; the visible pin case stubs
    // geometry so the same target resolves to 'top' or 'bottom'
    // placement.
    it('visible top/bottom pin does not change scrollHeight, prepend delta, or append boundary anchor vs hidden baseline', () => {
        const messages = Array.from({ length: 6 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            segments: [{ kind: 'text', text: `msg-${i}` }],
        }));
        const measure = (activeTurn) => {
            const root = document.createElement('div');
            const view = createReviewTranscriptView(root, {
                title: 'Pi RPC',
                coder: 'pi-rpc',
                status: 'Ready',
                mode: 'structured',
                windowSize: 3,
                pageSize: 2,
            });
            view.setStructuredMessages(messages, '', new Map());
            // Slide up so currentStart = 2 (msg-2..msg-4), leaving
            // both msg-0 and msg-5 outside the window.
            view.prependOlder(2);
            const transcript = root.querySelector('.review-chat-wrapper');
            const heightBefore = transcript.scrollHeight;
            const preScrollHeight = transcript.scrollHeight;
            const preHeight = preScrollHeight;
            const prependDelta = (() => {
                const grew = view.prependOlder(2);
                return { grew, delta: transcript.scrollHeight - preHeight };
            })();
            // Stub geometry to control appendNewer's boundary-top anchor
            // and the pin's source placement.
            const realTrRect = transcript.getBoundingClientRect;
            transcript.getBoundingClientRect = () => ({ top: 40 });
            Object.defineProperty(transcript, 'scrollTop', {
                value: 0,
                writable: true,
                configurable: true,
            });
            const anchorTop = 117;
            const anchor = transcript.querySelector(
                '.user-message:last-of-type, .assistant-message:last-of-type',
            );
            const realAnchorRect = anchor?.getBoundingClientRect;
            if (anchor) {
                anchor.getBoundingClientRect = () => ({ top: anchorTop });
            }
            let appendResult = false;
            let appendScrollTop = null;
            try {
                appendResult = view.appendNewer(1);
                appendScrollTop = transcript.scrollTop;
            } finally {
                transcript.getBoundingClientRect = realTrRect;
                if (anchor && realAnchorRect) {
                    anchor.getBoundingClientRect = realAnchorRect;
                }
                delete transcript.scrollTop;
            }
            // Now apply the active turn and assert the pin state.
            transcript.getBoundingClientRect = () => ({ top: 40 });
            if (anchor) {
                anchor.getBoundingClientRect = () => ({ top: anchorTop });
            }
            try {
                view.setActiveTurn(activeTurn);
                transcript.dispatchEvent(new Event('scroll'));
            } finally {
                transcript.getBoundingClientRect = realTrRect;
                if (anchor && realAnchorRect) {
                    anchor.getBoundingClientRect = realAnchorRect;
                }
            }
            return {
                transcript,
                heightBefore,
                heightAfter: transcript.scrollHeight,
                prependDelta,
                appendResult,
                appendScrollTop,
                contentBody: transcript.parentElement,
            };
        };

        // 1. Hidden baseline: no active turn → pin stays hidden.
        const hidden = measure(null);
        expect(
            hidden.contentBody
                .querySelector('.pi-active-prompt-top')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(
            hidden.contentBody
                .querySelector('.pi-active-prompt-bottom')
                .classList.contains('hidden'),
        ).toBe(true);

        // 2. Visible top pin: promptOrigin < currentStart forces the
        //    'top' placement without requiring source geometry.
        const top = measure({
            active: true,
            promptText: 'msg-0',
            promptOrigin: 0,
            stateLabel: 'Sent to Pi',
        });
        expect(
            top.contentBody
                .querySelector('.pi-active-prompt-top')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(
            top.contentBody
                .querySelector('.pi-active-prompt-bottom')
                .classList.contains('hidden'),
        ).toBe(true);

        // 3. Visible bottom pin: promptOrigin >= currentStart + windowSize.
        const bottom = measure({
            active: true,
            promptText: 'msg-5',
            promptOrigin: 5,
            stateLabel: 'Sent to Pi',
        });
        expect(
            bottom.contentBody
                .querySelector('.pi-active-prompt-bottom')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(
            bottom.contentBody
                .querySelector('.pi-active-prompt-top')
                .classList.contains('hidden'),
        ).toBe(true);

        // The pin is an overlay, not part of the scroll viewport, so
        // all three metrics must match the hidden baseline. scrollHeight
        // before any window slide (heightBefore) and after the active
        // turn (heightAfter) are both equal to the hidden baseline.
        expect(top.heightBefore).toBe(hidden.heightBefore);
        expect(bottom.heightBefore).toBe(hidden.heightBefore);
        expect(top.heightAfter).toBe(hidden.heightAfter);
        expect(bottom.heightAfter).toBe(hidden.heightAfter);
        // Prepend delta and append boundary anchor values (scrollTop
        // written by appendNewer) are identical regardless of the pin.
        expect(top.prependDelta.grew).toBe(hidden.prependDelta.grew);
        expect(top.prependDelta.delta).toBe(hidden.prependDelta.delta);
        expect(bottom.prependDelta.grew).toBe(hidden.prependDelta.grew);
        expect(bottom.prependDelta.delta).toBe(hidden.prependDelta.delta);
        expect(top.appendResult).toBe(hidden.appendResult);
        expect(bottom.appendResult).toBe(hidden.appendResult);
        expect(top.appendScrollTop).toBe(hidden.appendScrollTop);
        expect(bottom.appendScrollTop).toBe(hidden.appendScrollTop);
    });

    // The active-prompt pin and working header are exclusive to
    // `mode: 'structured'`. Legacy session rendering must not carry
    // any of those overlay classes, otherwise the legacy page inherits
    // the vendored Pi export CSS reset scope and the structured-only
    // stylesheets.
    it('omits .pi-active-turn, .pi-active-prompt-top, and .pi-active-prompt-bottom in legacy mode', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Review: legacy',
            coder: 'pi',
            refresh: true,
        });
        expect(root.querySelector('.pi-active-turn')).toBeNull();
        expect(root.querySelector('.pi-active-prompt-top')).toBeNull();
        expect(root.querySelector('.pi-active-prompt-bottom')).toBeNull();
        // Calling setActiveTurn in legacy mode must remain a no-op:
        // no overlay nodes are created on demand.
        view.setActiveTurn({
            active: true,
            promptText: 'legacy',
            promptOrigin: 0,
            stateLabel: 'Sent to Pi',
        });
        expect(root.querySelector('.pi-active-turn')).toBeNull();
        expect(root.querySelector('.pi-active-prompt-top')).toBeNull();
        expect(root.querySelector('.pi-active-prompt-bottom')).toBeNull();
    });
});

describe('Review Transcript renderer (lazy source + ReadonlyMap)', () => {
    it('still accepts a plain StructuredMessage array (legacy call shape)', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 5,
        });
        const messages = [
            { role: 'user', segments: [{ kind: 'text', text: 'hi' }] },
            {
                role: 'assistant',
                segments: [{ kind: 'text', text: 'hello back' }],
            },
        ];
        view.setStructuredMessages(messages, '', new Map());
        expect(root.querySelectorAll('.user-message')).toHaveLength(1);
        expect(root.querySelectorAll('.assistant-message')).toHaveLength(1);
        expect(root.querySelector('.user-message').textContent).toContain('hi');
        expect(root.querySelector('.assistant-message').textContent).toContain(
            'hello back',
        );
    });

    it('renders correctly from a StructuredMessageSource (new shape)', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 5,
        });
        const source = {
            length: 2,
            slice: (s, e) => {
                const all = [
                    {
                        role: 'user',
                        segments: [{ kind: 'text', text: 'q' }],
                    },
                    {
                        role: 'assistant',
                        segments: [{ kind: 'text', text: 'a' }],
                    },
                ];
                const start = s < 0 ? 0 : s;
                const end = e === undefined ? all.length : e;
                const slice = all.slice(start, end);
                return slice;
            },
        };
        view.setStructuredMessages(source, '', new Map());
        expect(root.querySelector('.user-message').textContent).toContain('q');
        expect(root.querySelector('.assistant-message').textContent).toContain(
            'a',
        );
    });

    it('accepts a ReadonlyMap for toolResults', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 5,
        });
        const readonlyMap = new Map([
            [
                'c-1',
                {
                    message: { role: 'toolResult', content: 'first' },
                    isError: false,
                },
            ],
        ]);
        const messages = [
            { role: 'user', segments: [{ kind: 'text', text: 'go' }] },
            {
                role: 'assistant',
                segments: [
                    {
                        kind: 'toolCall',
                        id: 'c-1',
                        name: 'bash',
                        args: { command: 'echo' },
                    },
                ],
            },
        ];
        view.setStructuredMessages(messages, '', readonlyMap);
        const tool = root.querySelector('.tool-execution');
        expect(tool).not.toBeNull();
        expect(tool.classList.contains('success')).toBe(true);
        expect(root.querySelector('.tool-output').textContent).toContain(
            'first',
        );
    });

    it('repaints only the matching call when a tool result arrives after it', () => {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 10,
        });
        const messages = [
            {
                role: 'assistant',
                segments: [
                    {
                        kind: 'toolCall',
                        id: 'a',
                        name: 'bash',
                        args: { command: 'a' },
                    },
                    {
                        kind: 'toolCall',
                        id: 'b',
                        name: 'bash',
                        args: { command: 'b' },
                    },
                ],
            },
        ];

        // First paint: both calls pending.
        view.setStructuredMessages(messages, '', new Map());
        let tools = root.querySelectorAll('.tool-execution');
        expect(tools).toHaveLength(2);
        expect(tools[0].classList.contains('pending')).toBe(true);
        expect(tools[1].classList.contains('pending')).toBe(true);
        const firstCallNode = tools[0];

        // Only 'a' result arrives.
        view.setStructuredMessages(
            messages,
            '',
            new Map([
                [
                    'a',
                    {
                        message: {
                            role: 'toolResult',
                            content: 'a-out',
                        },
                        isError: false,
                    },
                ],
            ]),
        );
        tools = root.querySelectorAll('.tool-execution');
        expect(tools).toHaveLength(2);
        expect(tools[0].classList.contains('success')).toBe(true);
        // 'b' is still pending.
        expect(tools[1].classList.contains('pending')).toBe(true);
        // The 'a' DOM node has been rebuilt (success state) — its sibling
        // 'b' is unaffected.
        expect(tools[0]).not.toBe(firstCallNode);
    });
});

describe('Review Transcript renderer (live partial path)', () => {
    function mountStructuredView(opts = {}) {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 5,
            pageSize: 50,
            ...opts,
        });
        return { root, view };
    }

    it('setStructuredPartial("") on a fresh view is a no-op (no live block exists)', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredPartial('');
        expect(root.querySelector('.pi-streaming')).toBeNull();
        expect(root.querySelector('.pi-partial')).toBeNull();
    });

    it('setStructuredPartial("hello") lazily creates exactly one .pi-streaming block inside the transcript', () => {
        const { root, view } = mountStructuredView();
        const transcript = root.querySelector('.review-chat-wrapper');
        view.setStructuredPartial('hello');
        const live = root.querySelector('.pi-streaming');
        expect(live).not.toBeNull();
        expect(transcript.contains(live)).toBe(true);
        const partial = root.querySelector('.pi-partial');
        expect(partial).not.toBeNull();
        expect(partial.textContent).toBe('hello');
        expect(root.querySelectorAll('.pi-streaming')).toHaveLength(1);
        expect(root.querySelectorAll('.pi-partial')).toHaveLength(1);
    });

    it('mutates the same .pi-partial node for subsequent non-empty updates without rebuilding', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredPartial('hello');
        const beforeNode = root.querySelector('.pi-partial');
        view.setStructuredPartial('hello world');
        const afterNode = root.querySelector('.pi-partial');
        expect(afterNode).not.toBeNull();
        // Same node — mutating textContent, not replacing the block.
        expect(afterNode).toBe(beforeNode);
        expect(afterNode.textContent).toBe('hello world');
        // Still exactly one live block.
        expect(root.querySelectorAll('.pi-streaming')).toHaveLength(1);
    });

    it('preserves a scrolled-up reader position during a partial update', () => {
        const { root, view } = mountStructuredView();
        const transcript = root.querySelector('.review-chat-wrapper');
        Object.defineProperties(transcript, {
            scrollHeight: { configurable: true, get: () => 500 },
            clientHeight: { configurable: true, get: () => 100 },
            scrollTop: { configurable: true, writable: true, value: 123 },
        });
        view.setStructuredPartial('streaming');
        expect(transcript.scrollTop).toBe(123);
    });

    it('sticks to the bottom during a partial update when already at bottom', () => {
        const { root, view } = mountStructuredView();
        const transcript = root.querySelector('.review-chat-wrapper');
        let heightReads = 0;
        Object.defineProperties(transcript, {
            scrollHeight: {
                configurable: true,
                get: () => (heightReads++ === 0 ? 500 : 600),
            },
            clientHeight: { configurable: true, get: () => 100 },
            scrollTop: { configurable: true, writable: true, value: 400 },
        });
        view.setStructuredPartial('streaming');
        expect(transcript.scrollTop).toBe(600);
    });

    it('setStructuredPartial("") removes the live block and leaves settled transcript untouched', () => {
        const { root, view } = mountStructuredView();
        // Seed a settled block first.
        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'before-stream' }],
                },
            ],
            '',
            new Map(),
        );
        const userBlock = root.querySelector('.user-message');
        view.setStructuredPartial('streaming text');
        expect(root.querySelector('.pi-streaming')).not.toBeNull();
        view.setStructuredPartial('');
        expect(root.querySelector('.pi-streaming')).toBeNull();
        // Settled block is preserved.
        expect(root.querySelector('.user-message')).toBe(userBlock);
        expect(root.querySelector('.user-message').textContent).toContain(
            'before-stream',
        );
    });

    it('does not invoke setStructuredMessages as a side effect of partial updates', () => {
        const { root, view } = mountStructuredView();
        const spy = vi.spyOn(view, 'setStructuredMessages');
        view.setStructuredPartial('a');
        view.setStructuredPartial('ab');
        view.setStructuredPartial('abc');
        view.setStructuredPartial('');
        expect(spy).not.toHaveBeenCalled();
        expect(root.querySelector('.pi-streaming')).toBeNull();
    });

    it('appends the live block after settled blocks when setStructuredMessages runs with a non-empty partial', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredPartial('streaming');
        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'after-stream' }],
                },
            ],
            'streaming',
            new Map(),
        );
        const transcript = root.querySelector('.review-chat-wrapper');
        const kids = [...transcript.children];
        const streaming = kids.find((k) =>
            k.classList.contains('pi-streaming'),
        );
        const user = kids.find((k) => k.classList.contains('user-message'));
        expect(streaming).toBeDefined();
        expect(user).toBeDefined();
        expect(streaming).not.toBe(user);
        // The live block is appended at the end of the rendered
        // window; settled blocks precede it.
        expect(user.nextElementSibling).toBe(streaming);
        // The new messageEnd-style settle path: setting partial=''
        // and rerunning setStructuredMessages removes the live block.
        view.setStructuredMessages(
            [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'after-stream' }],
                },
            ],
            '',
            new Map(),
        );
        expect(root.querySelector('.pi-streaming')).toBeNull();
    });
});

describe('Review Transcript renderer (pi error surfaces — Milestone 3)', () => {
    function mountStructuredView(opts = {}) {
        const root = document.createElement('div');
        const view = createReviewTranscriptView(root, {
            title: 'Pi RPC',
            coder: 'pi-rpc',
            mode: 'structured',
            windowSize: 100,
            ...opts,
        });
        return { root, view };
    }

    it('renders a red assistant-error row after the partial text for stopReason="error" with no tool calls', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'partial answer' }],
                    stopReason: 'error',
                    errorMessage: 'rate limit',
                },
            ],
            '',
            new Map(),
        );
        const block = root.querySelector('.assistant-message');
        const errorRow = block.querySelector('.assistant-error.error-text');
        expect(errorRow).not.toBeNull();
        expect(errorRow.textContent).toBe('Error: rate limit');
        // Order: text first, then the error row.
        const textDiv = block.querySelector('.assistant-text');
        expect(
            textDiv.compareDocumentPosition(errorRow) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it('uses "Error: Unknown error" when stopReason="error" omits errorMessage', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'partial' }],
                    stopReason: 'error',
                },
            ],
            '',
            new Map(),
        );
        const errorRow = root.querySelector('.assistant-error.error-text');
        expect(errorRow).not.toBeNull();
        expect(errorRow.textContent).toBe('Error: Unknown error');
    });

    it('renders the upstream "Request was aborted" sentinel as "Operation aborted" in the red row', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'mid-turn' }],
                    stopReason: 'aborted',
                    errorMessage: 'Request was aborted',
                },
            ],
            '',
            new Map(),
        );
        const errorRow = root.querySelector('.assistant-error.error-text');
        expect(errorRow).not.toBeNull();
        expect(errorRow.textContent).toBe('Operation aborted');
    });

    it('passes through non-sentinel errorMessage for stopReason="aborted"', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'mid-turn' }],
                    stopReason: 'aborted',
                    errorMessage: 'Provider dropped the connection',
                },
            ],
            '',
            new Map(),
        );
        const errorRow = root.querySelector('.assistant-error.error-text');
        expect(errorRow).not.toBeNull();
        expect(errorRow.textContent).toBe('Provider dropped the connection');
    });

    it('always renders the truncation row for stopReason="length" (even with pending tool calls)', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        { kind: 'text', text: 'partial' },
                        {
                            kind: 'toolCall',
                            id: 'call-x',
                            name: 'bash',
                            args: { command: 'ls' },
                        },
                    ],
                    stopReason: 'length',
                },
            ],
            '',
            new Map(),
        );
        const errorRow = root.querySelector('.assistant-error.error-text');
        expect(errorRow).not.toBeNull();
        expect(errorRow.textContent).toBe(
            'Response was truncated before completion.',
        );
        // Pending tool call stays pending (length never propagates as
        // a per-tool error).
        const tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('pending')).toBe(true);
    });

    it('does NOT render a message-level error row when stopReason="error" has tool calls (per-tool propagation owns the surface)', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        { kind: 'text', text: 'before' },
                        {
                            kind: 'toolCall',
                            id: 'call-y',
                            name: 'bash',
                            args: { command: 'rm -rf' },
                        },
                    ],
                    stopReason: 'error',
                    errorMessage: 'rate limit',
                },
            ],
            '',
            new Map(),
        );
        expect(root.querySelector('.assistant-error.error-text')).toBeNull();
    });

    it('propagates stopReason="error" to per-tool status with bare error text as output', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'call-z',
                            name: 'bash',
                            args: { command: 'true' },
                        },
                    ],
                    stopReason: 'error',
                    errorMessage: 'rate limit',
                },
            ],
            '',
            new Map(),
        );
        const tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('error')).toBe(true);
        expect(tool.classList.contains('pending')).toBe(false);
        // Output slot carries the BARE error text — no "Error: " prefix.
        expect(tool.querySelector('.tool-output').textContent).toBe(
            'rate limit',
        );
    });

    it('maps the upstream "Request was aborted" sentinel in per-tool error output', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [
                        {
                            kind: 'toolCall',
                            id: 'call-abort',
                            name: 'bash',
                            args: { command: 'true' },
                        },
                    ],
                    stopReason: 'aborted',
                    errorMessage: 'Request was aborted',
                },
            ],
            '',
            new Map(),
        );
        const tool = root.querySelector('.tool-execution');
        expect(tool.classList.contains('error')).toBe(true);
        expect(tool.querySelector('.tool-output').textContent).toBe(
            'Operation aborted',
        );
    });

    it('renders no error row when stopReason is absent or outside the contract', () => {
        const { root, view } = mountStructuredView();
        view.setStructuredMessages(
            [{ role: 'assistant', segments: [{ kind: 'text', text: 'ok' }] }],
            '',
            new Map(),
        );
        expect(root.querySelector('.assistant-error.error-text')).toBeNull();
        expect(root.querySelector('.pi-ephemeral-error')).toBeNull();
    });

    it('refreshes the cached error row when stopReason/errorMessage change (cache key)', () => {
        const { root, view } = mountStructuredView();
        const messages = [
            {
                role: 'assistant',
                segments: [{ kind: 'text', text: 'partial' }],
                stopReason: 'error',
                errorMessage: 'first',
            },
        ];
        view.setStructuredMessages(messages, '', new Map());
        const first = root.querySelector('.assistant-message');
        const firstError = first.querySelector('.assistant-error.error-text');
        expect(firstError.textContent).toBe('Error: first');

        // Same shape, new envelope: the cache key includes stopReason
        // and errorMessage, so the cached block is rebuilt.
        view.setStructuredMessages(
            [
                {
                    ...messages[0],
                    errorMessage: 'second',
                },
            ],
            '',
            new Map(),
        );
        const second = root.querySelector('.assistant-message');
        const secondError = second.querySelector('.assistant-error.error-text');
        expect(secondError.textContent).toBe('Error: second');
        // Node identity differs because the cache key changed.
        expect(secondError).not.toBe(firstError);
    });

    it('setEphemeralError appends .pi-ephemeral-error.error-text to the transcript', () => {
        const { root, view } = mountStructuredView();
        view.setEphemeralError('Compaction failed: provider 500');
        const row = root.querySelector('.pi-ephemeral-error.error-text');
        expect(row).not.toBeNull();
        expect(row.textContent).toBe('Compaction failed: provider 500');
    });

    it('setEphemeralError(null) removes a previously-set ephemeral row', () => {
        const { root, view } = mountStructuredView();
        view.setEphemeralError('first');
        expect(root.querySelector('.pi-ephemeral-error')).not.toBeNull();
        view.setEphemeralError(null);
        expect(root.querySelector('.pi-ephemeral-error')).toBeNull();
    });

    it('setEphemeralError mutates an existing row in place when text changes', () => {
        const { root, view } = mountStructuredView();
        view.setEphemeralError('first');
        const first = root.querySelector('.pi-ephemeral-error');
        view.setEphemeralError('second');
        const second = root.querySelector('.pi-ephemeral-error');
        expect(second).toBe(first);
        expect(second.textContent).toBe('second');
    });

    it('the ephemeral row survives a setStructuredMessages repaint (re-applied from view state)', () => {
        const { root, view } = mountStructuredView();
        view.setEphemeralError('sticky error');
        view.setStructuredMessages(
            [
                {
                    role: 'assistant',
                    segments: [{ kind: 'text', text: 'late message' }],
                },
            ],
            '',
            new Map(),
        );
        const row = root.querySelector('.pi-ephemeral-error.error-text');
        expect(row).not.toBeNull();
        expect(row.textContent).toBe('sticky error');
    });

    it('ActiveTurnState retry alone (without active) keeps the working row visible with "Retrying · attempt N of M"', () => {
        const { root, view } = mountStructuredView();
        view.setActiveTurn({
            active: false,
            promptText: '',
            promptOrigin: 'optimistic',
            stateLabel: 'Sending',
            retry: { attempt: 2, maxAttempts: 5 },
        });
        const header = root.querySelector('.pi-active-turn');
        expect(header.classList.contains('hidden')).toBe(false);
        const working = header.querySelector('.pi-working-label');
        expect(working.textContent).toBe('Retrying · attempt 2 of 5');
    });

    it('ActiveTurnState retry does NOT trigger overlay/pin markers (gated on active)', () => {
        const { root, view } = mountStructuredView();
        view.setActiveTurn({
            active: false,
            promptText: '',
            promptOrigin: 'optimistic',
            stateLabel: 'Sending',
            retry: { attempt: 1, maxAttempts: 3 },
        });
        expect(
            root
                .querySelector('.pi-active-prompt-top')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(
            root
                .querySelector('.pi-active-prompt-bottom')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(root.querySelector('[data-pi-active-prompt-index]')).toBeNull();
        expect(
            root.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).toBeNull();
    });

    it('ActiveTurnState active=true + retry shows the retry label (overrides "Pi is working")', () => {
        const { root, view } = mountStructuredView();
        view.setActiveTurn({
            active: true,
            promptText: 'go',
            promptOrigin: 'optimistic',
            stateLabel: 'Sending',
            retry: { attempt: 3, maxAttempts: 3 },
        });
        const header = root.querySelector('.pi-active-turn');
        expect(header.classList.contains('hidden')).toBe(false);
        const working = header.querySelector('.pi-working-label');
        expect(working.textContent).toBe('Retrying · attempt 3 of 3');
    });

    it('ActiveTurnState active=true without retry keeps the original "Pi is working" label', () => {
        const { root, view } = mountStructuredView();
        view.setActiveTurn({
            active: true,
            promptText: 'go',
            promptOrigin: 'optimistic',
            stateLabel: 'Sending',
        });
        const working = root.querySelector('.pi-working-label');
        expect(working.textContent).toBe('Pi is working');
    });
});
