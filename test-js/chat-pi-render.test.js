import { describe, it, expect } from 'vitest';
import {
    convertMessage,
    createStructuredTranscript,
    formatPiRpcStatus,
    renderHeader,
    renderTranscript,
    renderTranscriptFlat,
    renderTranscriptStructured,
    renderedUserText,
} from '../web/chat-pi/render.js';

describe('render', () => {
    it('renders header placeholders', () => {
        const out = renderHeader({
            sid: 'a',
            title: 'demo',
            cwd: '/w',
            model: '',
            thinking: '',
            busy: false,
            status: 'live',
            queueDepth: 0,
        });
        expect(out).toContain('title: demo');
        expect(out).toContain('model: —');
    });
    it('formats Pi RPC status values without losing zeroes', () => {
        expect(
            formatPiRpcStatus({
                cwd: '/work/demo',
                model: 'pi-4',
                thinking: 'high',
                inputTokens: 0,
                outputTokens: 1200,
                contextUsedTokens: 42000,
                contextWindowTokens: 200000,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                skills: [],
            }),
        ).toEqual({
            cwd: '/work/demo',
            model: 'pi-4',
            thinking: 'high',
            input: '0',
            output: '1.2K',
            context: '42K / 200K',
            cacheRead: '0',
            cacheWrite: '0',
            skills: 'none',
        });
        expect(
            formatPiRpcStatus({
                cwd: '/work/demo',
                contextWindowTokens: 200000,
            }).context,
        ).toBe('— / 200K');
        expect(formatPiRpcStatus({ cwd: '/work/demo' }).context).toBe('—');
        expect(
            formatPiRpcStatus({ cwd: '/work/demo', skills: ['a', 'b'] }).skills,
        ).toBe('a, b');
        const longSkills = Array.from({ length: 24 }, (_, i) => `skill-${i}`);
        expect(
            formatPiRpcStatus({ cwd: '/work/demo', skills: longSkills }).skills,
        ).toBe(longSkills.join(', '));
    });

    it('renders transcript parts', () => {
        expect(renderTranscript([{ role: 'user', content: 'hi' }])).toBe(
            '[user] hi',
        );
        expect(
            renderTranscript([
                {
                    role: 'assistant',
                    content: [{ text: 'Hello ' }, { text: 'world' }],
                },
            ]),
        ).toBe('[assistant] Hello world');
    });

    it('renders transcript parts via the renamed flat export', () => {
        expect(renderTranscriptFlat([{ role: 'user', content: 'hi' }])).toBe(
            '[user] hi',
        );
    });
});

describe('renderedUserText', () => {
    it('matches rendered text for raw, JSON, object, array, and whitespace content', () => {
        expect(renderedUserText(' raw\ntext ')).toBe(' raw\ntext ');
        expect(
            renderedUserText(
                JSON.stringify([
                    { type: 'text', text: 'a\n' },
                    { type: 'text', text: ' b' },
                ]),
            ),
        ).toBe('a\n b');
        expect(renderedUserText({ type: 'text', text: 'object' })).toBe(
            'object',
        );
        expect(
            renderedUserText([
                { type: 'text', text: 'x' },
                { type: 'text', text: 'y' },
            ]),
        ).toBe('xy');
    });
});

describe('renderTranscriptStructured', () => {
    it('emits a user text segment from a string content', () => {
        const out = renderTranscriptStructured([
            { role: 'user', content: 'hi' },
        ]);
        expect(out).toEqual([
            { role: 'user', segments: [{ kind: 'text', text: 'hi' }] },
        ]);
    });

    it('separates text from toolCall in an assistant message', () => {
        const out = renderTranscriptStructured([
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me run a command' },
                    {
                        type: 'toolCall',
                        id: 'c1',
                        name: 'bash',
                        arguments: { command: 'ls' },
                    },
                ],
            },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].segments).toEqual([
            { kind: 'text', text: 'Let me run a command' },
            {
                kind: 'toolCall',
                id: 'c1',
                name: 'bash',
                args: { command: 'ls' },
            },
        ]);
    });

    it('parses tool_call arguments when they arrive as a JSON string', () => {
        const out = renderTranscriptStructured([
            {
                role: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'c1',
                        name: 'bash',
                        arguments: '{"command":"pwd"}',
                    },
                ],
            },
        ]);
        expect(out[0].segments[0]).toEqual({
            kind: 'toolCall',
            id: 'c1',
            name: 'bash',
            args: { command: 'pwd' },
        });
    });
});

describe('createStructuredTranscript (lazy source)', () => {
    function buildRawMessages(count) {
        const out = [];
        for (let i = 0; i < count; i++) {
            out.push({
                role: 'assistant',
                content: [{ type: 'text', text: `m-${i}` }],
            });
        }
        return out;
    }

    it('captures length at construction time and stays stable across growth', () => {
        const raw = buildRawMessages(5);
        const source = createStructuredTranscript(raw);
        expect(source.length).toBe(5);
        // Grow the upstream array; the captured length stays put.
        raw.push({ role: 'user', content: 'late' });
        expect(source.length).toBe(5);
        // A fresh source reads the new length.
        expect(createStructuredTranscript(raw).length).toBe(6);
    });

    it('only converts messages inside the requested slice', () => {
        const raw = buildRawMessages(1000);
        Object.defineProperty(raw[100], 'role', {
            get() {
                throw new Error('off-window message was converted');
            },
        });
        const source = createStructuredTranscript(raw);
        const slice = source.slice(0, 100);
        expect(slice).toHaveLength(100);
        expect(slice[0].segments[0].text).toBe('m-0');
        expect(slice[99].segments[0].text).toBe('m-99');
    });

    it('clamps slice arguments to the captured bounds', () => {
        const raw = buildRawMessages(10);
        const source = createStructuredTranscript(raw);
        // Negative start resolves from the end.
        expect(source.slice(-5)).toHaveLength(5);
        // Out-of-range start clamps to length.
        expect(source.slice(5000)).toHaveLength(0);
        // end clamps to length.
        expect(source.slice(2, 5000)).toHaveLength(8);
        // Negative end resolves from the end.
        expect(source.slice(2, -5)).toHaveLength(3);
        // start >= end clamps to empty.
        expect(source.slice(7, 3)).toHaveLength(0);
    });

    it('matches Array.prototype.slice integer normalization', () => {
        const source = createStructuredTranscript(buildRawMessages(10));
        const texts = (slice) =>
            slice.map((message) => message.segments[0].text);
        expect(texts(source.slice(1.9, 3.9))).toEqual(['m-1', 'm-2']);
        expect(texts(source.slice(-1.9))).toEqual(['m-9']);
        expect(source.slice(Number.NaN)).toHaveLength(10);
        expect(source.slice(0, Number.NaN)).toEqual([]);
        expect(source.slice(Number.POSITIVE_INFINITY)).toEqual([]);
        expect(source.slice(Number.NEGATIVE_INFINITY)).toHaveLength(10);
        expect(source.slice(0, Number.POSITIVE_INFINITY)).toHaveLength(10);
        expect(source.slice(0, Number.NEGATIVE_INFINITY)).toEqual([]);
    });

    it('returns an empty slice when length is 0', () => {
        const source = createStructuredTranscript([]);
        expect(source.length).toBe(0);
        expect(source.slice(0)).toEqual([]);
        expect(source.slice(-5)).toEqual([]);
    });

    it('convertMessage is a thin wrapper for segmentsFromContent', () => {
        const segs = convertMessage(
            'user',
            [{ type: 'text', text: 'hello' }],
            '',
        );
        expect(segs).toEqual([{ kind: 'text', text: 'hello' }]);
    });
});
