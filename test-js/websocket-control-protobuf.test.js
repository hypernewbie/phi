// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControl } from '../web/chat-pi/client.js';
import {
    buildCall,
    ControlConversionError,
    decodeServerFrame,
    encodeCall,
    encodeHello,
    eventFromWire,
    externalFromJS,
    externalToJS,
    resultFromWire,
} from '../web/chat-pi/control-wire.js';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';

// M3 chat control codec over generated protobuf: every operation and
// no-op keeps its typed call/result variant, all 13 sequenced events keep
// their UI shape, external Pi data keeps reserved keys and bounds, and
// conversion failures reject or close instead of degrading silently.

const FULL_STATE = {
    sid: 'sid-1',
    title: 'demo',
    cwd: '/work/demo',
    model: 'm',
    thinking: 'high',
    inputTokens: 1n,
    outputTokens: 2n,
    contextUsedTokens: 3n,
    contextWindowTokens: 4n,
    cacheReadTokens: 5n,
    cacheWriteTokens: 6n,
    skills: ['a'],
    busy: true,
    status: 'live',
    queueDepth: 2,
    sessionPath: '/sessions/one.jsonl',
};

const LEGACY_STATE = {
    sid: 'sid-1',
    title: 'demo',
    cwd: '/work/demo',
    model: 'm',
    thinking: 'high',
    inputTokens: 1,
    outputTokens: 2,
    contextUsedTokens: 3,
    contextWindowTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
    skills: ['a'],
    busy: true,
    status: 'live',
    queueDepth: 2,
    sessionPath: '/sessions/one.jsonl',
};

const MESSAGES = [
    {
        role: 'user',
        content: { kind: { $case: 'stringValue', value: 'hi' } },
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        ts: 7n,
        stopReason: 'stop',
        errorMessage: 'boom',
    },
    {
        role: 'toolResult',
        content: { kind: { $case: 'listValue', value: { values: [] } } },
        details: { kind: { $case: 'objectValue', value: { entries: [] } } },
    },
];

const LEGACY_MESSAGES = [
    {
        role: 'user',
        content: 'hi',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        ts: 7,
        stopReason: 'stop',
        errorMessage: 'boom',
    },
    {
        role: 'toolResult',
        content: [],
        details: {},
    },
];

function callFrame(op, sid, args) {
    return encodeCall(buildCall('id-1', op, sid, args));
}

function decodedCall(op, sid, args) {
    const frame = ControlClientFrame.decode(callFrame(op, sid, args));
    return frame.payload.value;
}

function decodeResponse(frame) {
    const bytes = ControlServerFrame.encode(
        ControlServerFrame.fromPartial(frame),
    ).finish();
    return decodeServerFrame(bytes);
}

function response(id, result) {
    return decodeResponse({
        payload: { $case: 'response', value: { id, result } },
    }).payload.value;
}

function eventFrame(value) {
    return decodeResponse({
        payload: { $case: 'event', value },
    }).payload.value;
}

const operationCases = [
    ['spawn', undefined, { cwd: '/work/demo', sessionPath: '/p.jsonl' }],
    ['listSessions', undefined, {}],
    ['getState', 'sid-1', {}],
    ['hydrate', 'sid-1', {}],
    ['getMessages', 'sid-1', {}],
    ['prompt', 'sid-1', { message: 'hello', streamingBehavior: 'steer' }],
    ['getAvailableModels', 'sid-1', {}],
    ['setModel', 'sid-1', { provider: 'p', modelId: 'm' }],
    ['getAvailableThinkingLevels', 'sid-1', {}],
    ['setThinking', 'sid-1', { level: 'high' }],
    ['newSession', 'sid-1', {}],
    ['abort', 'sid-1', {}],
    ['compact', 'sid-1', {}],
    ['setSessionName', 'sid-1', { name: 'renamed' }],
    ['subagentTranscript', undefined, { runId: 'run-1' }],
];

const noOpCases = [
    'viewReady',
    'setCapabilities',
    'waitViewReady',
    'dlg',
    'dlgClosed',
    'activateTab',
];

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
});

describe('control calls', () => {
    it.each(operationCases)(
        'encodes %s into its typed variant',
        (op, sid, args) => {
            const call = decodedCall(op, sid, args);
            expect(call.id).toBe('id-1');
            expect(call.call.$case).toBe(op);
        },
    );

    it('keeps every required argument inside its typed payload', () => {
        expect(
            decodedCall('spawn', undefined, operationCases[0][2]).call,
        ).toEqual({
            $case: 'spawn',
            value: { cwd: '/work/demo', sessionPath: '/p.jsonl' },
        });
        expect(
            decodedCall('prompt', 'sid-1', operationCases[5][2]).call.value,
        ).toEqual({
            sid: 'sid-1',
            message: 'hello',
            streamingBehavior: 'steer',
        });
        expect(
            decodedCall('setModel', 'sid-1', operationCases[7][2]).call.value,
        ).toEqual({ sid: 'sid-1', provider: 'p', modelId: 'm' });
        expect(
            decodedCall('subagentTranscript', undefined, { runId: 'run-1' })
                .call.value,
        ).toEqual({ runId: 'run-1' });
    });

    it.each(noOpCases)(
        'encodes the %s no-op without an untyped tunnel',
        (op) => {
            const call = decodedCall(op, 'sid-1', {});
            expect(call.call.$case).toBe(op);
            expect(call.call.value).toEqual({ sid: 'sid-1' });
            expect(decodedCall(op, undefined, {}).call.value).toEqual({
                sid: undefined,
            });
        },
    );

    it('keeps absent optional arguments absent', () => {
        const spawn = decodedCall('spawn', undefined, { cwd: '/w' });
        expect(spawn.call.value).toEqual({ cwd: '/w', sessionPath: undefined });
        const prompt = decodedCall('prompt', 'sid-1', { message: 'x' });
        expect(prompt.call.value).toEqual({
            sid: 'sid-1',
            message: 'x',
            streamingBehavior: undefined,
        });
    });

    it('encodes hello and rejects unknown operations and wrong argument types', () => {
        const hello = ControlClientFrame.decode(encodeHello(1));
        expect(hello.payload).toEqual({
            $case: 'hello',
            value: { version: 1 },
        });
        expect(() => buildCall('id', 'nope', 'sid', {})).toThrow(
            ControlConversionError,
        );
        expect(() => buildCall('id', 'prompt', 'sid', { message: 1 })).toThrow(
            /must be a string/,
        );
        expect(() => buildCall('id', 'spawn', undefined, 'args')).toThrow(
            /must be an object/,
        );
    });
});

describe('control results', () => {
    it('converts every operation result to the legacy UI shape', () => {
        expect(
            resultFromWire(
                'spawn',
                response('id-1', {
                    $case: 'spawn',
                    value: {
                        sid: 'sid-1',
                        title: 'demo',
                        cwd: '/work/demo',
                        session: { messages: MESSAGES, lastSeq: 9n },
                        state: FULL_STATE,
                    },
                }),
            ),
        ).toEqual({
            sid: 'sid-1',
            title: 'demo',
            cwd: '/work/demo',
            snapshot: { messages: LEGACY_MESSAGES, lastSeq: 9 },
            state: LEGACY_STATE,
        });

        const sessions = {
            $case: 'listSessions',
            value: {
                sessions: [
                    { sid: 's1', title: 'a', cwd: '/a', status: 'live' },
                    { sid: 's2', title: 'b', cwd: '/b', status: 'exited' },
                ],
            },
        };
        expect(
            resultFromWire('listSessions', response('id-1', sessions)),
        ).toEqual([
            { sid: 's1', title: 'a', cwd: '/a', status: 'live' },
            { sid: 's2', title: 'b', cwd: '/b', status: 'exited' },
        ]);

        expect(
            resultFromWire(
                'getState',
                response('id-1', {
                    $case: 'getState',
                    value: { state: FULL_STATE },
                }),
            ),
        ).toEqual(LEGACY_STATE);

        for (const op of ['hydrate', 'getMessages']) {
            expect(
                resultFromWire(
                    op,
                    response('id-1', {
                        $case: op,
                        value: {
                            session: {
                                messages: MESSAGES,
                                lastSeq: 2n,
                                state: FULL_STATE,
                            },
                        },
                    }),
                ),
            ).toEqual({
                messages: LEGACY_MESSAGES,
                lastSeq: 2,
                state: LEGACY_STATE,
            });
        }

        expect(
            resultFromWire(
                'prompt',
                response('id-1', {
                    $case: 'prompt',
                    value: { accepted: true },
                }),
            ),
        ).toEqual({ accepted: true });

        expect(
            resultFromWire(
                'getAvailableModels',
                response('id-1', {
                    $case: 'getAvailableModels',
                    value: {
                        models: [
                            { provider: 'p', id: 'm', name: 'Model' },
                            { provider: 'p', id: 'm2', name: '' },
                        ],
                    },
                }),
            ),
        ).toEqual({
            models: [
                { provider: 'p', id: 'm', name: 'Model' },
                { provider: 'p', id: 'm2' },
            ],
        });

        for (const op of ['setModel', 'setThinking', 'setSessionName']) {
            expect(
                resultFromWire(
                    op,
                    response('id-1', {
                        $case: op,
                        value: { state: FULL_STATE },
                    }),
                ),
            ).toEqual({ state: LEGACY_STATE });
        }

        expect(
            resultFromWire(
                'getAvailableThinkingLevels',
                response('id-1', {
                    $case: 'getAvailableThinkingLevels',
                    value: { levels: ['low', 'high'] },
                }),
            ),
        ).toEqual({ levels: ['low', 'high'] });

        expect(
            resultFromWire(
                'abort',
                response('id-1', {
                    $case: 'abort',
                    value: { aborted: true },
                }),
            ),
        ).toEqual({ aborted: true });

        expect(
            resultFromWire(
                'subagentTranscript',
                response('id-1', {
                    $case: 'subagentTranscript',
                    value: {
                        runId: 'run-1',
                        steps: [
                            {
                                label: 'step',
                                sessionFile: '/s.jsonl',
                                messages: MESSAGES,
                            },
                        ],
                    },
                }),
            ),
        ).toEqual({
            runId: 'run-1',
            steps: [
                {
                    label: 'step',
                    sessionFile: '/s.jsonl',
                    messages: LEGACY_MESSAGES,
                },
            ],
        });

        for (const op of noOpCases) {
            expect(
                resultFromWire(
                    op,
                    response('id-1', {
                        $case: op,
                        value: { stubbed: true },
                    }),
                ),
            ).toEqual({ stubbed: true });
        }
    });

    it('keeps cancelled, reset, warning, and optional state variants distinct', () => {
        expect(
            resultFromWire(
                'newSession',
                response('id-1', {
                    $case: 'newSession',
                    value: { cancelled: true, state: FULL_STATE },
                }),
            ),
        ).toEqual({ cancelled: true, state: LEGACY_STATE });

        expect(
            resultFromWire(
                'newSession',
                response('id-1', {
                    $case: 'newSession',
                    value: { cancelled: false, reset: true },
                }),
            ),
        ).toEqual({ cancelled: false, reset: true });

        expect(
            resultFromWire(
                'newSession',
                response('id-1', {
                    $case: 'newSession',
                    value: {
                        cancelled: false,
                        reset: true,
                        stateWarning: 'refresh failed',
                    },
                }),
            ),
        ).toEqual({
            cancelled: false,
            reset: true,
            stateWarning: 'refresh failed',
        });

        expect(
            resultFromWire(
                'compact',
                response('id-1', {
                    $case: 'compact',
                    value: { state: FULL_STATE },
                }),
            ),
        ).toEqual({ state: LEGACY_STATE });

        expect(
            resultFromWire(
                'compact',
                response('id-1', {
                    $case: 'compact',
                    value: { state: FULL_STATE, stateWarning: 'stale' },
                }),
            ),
        ).toEqual({ state: LEGACY_STATE, stateWarning: 'stale' });
    });

    it('keeps absent counters null and omits absent strings', () => {
        const state = resultFromWire(
            'getState',
            response('id-1', {
                $case: 'getState',
                value: { state: { sid: 's', title: 't', cwd: '/c' } },
            }),
        );
        expect(state).toEqual({
            sid: 's',
            title: 't',
            cwd: '/c',
            inputTokens: null,
            outputTokens: null,
            contextUsedTokens: null,
            contextWindowTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            skills: [],
            busy: false,
            status: '',
            queueDepth: 0,
        });
        expect(Object.hasOwn(state, 'model')).toBe(false);
        expect(Object.hasOwn(state, 'sessionPath')).toBe(false);
    });

    it('rejects server errors and mismatched or missing result variants', () => {
        const failing = response('id-1', {
            $case: 'error',
            value: { reason: 'pi rejected' },
        });
        expect(() => resultFromWire('prompt', failing)).toThrow('pi rejected');

        const wrong = response('id-1', {
            $case: 'getState',
            value: { state: FULL_STATE },
        });
        expect(() => resultFromWire('prompt', wrong)).toThrow(
            ControlConversionError,
        );

        const empty = decodeResponse({
            payload: { $case: 'response', value: { id: 'id-1' } },
        }).payload.value;
        expect(() => resultFromWire('prompt', empty)).toThrow(/has no result/);
    });

    it('rejects unsafe 64-bit values instead of narrowing them', () => {
        const huge = response('id-1', {
            $case: 'hydrate',
            value: { session: { messages: [], lastSeq: 2n ** 60n } },
        });
        expect(() => resultFromWire('hydrate', huge)).toThrow(
            /safe integer range/,
        );
        const bigCounter = response('id-1', {
            $case: 'getState',
            value: {
                state: {
                    sid: 's',
                    title: 't',
                    cwd: '/c',
                    inputTokens: 2n ** 60n,
                },
            },
        });
        expect(() => resultFromWire('getState', bigCounter)).toThrow(
            /safe integer range/,
        );
        const bigMessageTs = response('id-1', {
            $case: 'hydrate',
            value: {
                session: {
                    messages: [{ role: 'user', ts: 2n ** 60n }],
                    lastSeq: 1n,
                },
            },
        });
        expect(() => resultFromWire('hydrate', bigMessageTs)).toThrow(
            /safe integer range/,
        );
    });
});

describe('control events', () => {
    const cases = [
        [
            'stateChanged',
            {
                $case: 'stateChanged',
                value: { change: { $case: 'state', value: FULL_STATE } },
            },
            LEGACY_STATE,
        ],
        [
            'stateChanged',
            {
                $case: 'stateChanged',
                value: {
                    change: { $case: 'error', value: { reason: 'stale' } },
                },
            },
            { error: 'stale' },
        ],
        [
            'messageStart',
            {
                $case: 'messageStart',
                value: {
                    role: 'assistant',
                    message: {
                        kind: {
                            $case: 'objectValue',
                            value: {
                                entries: [
                                    {
                                        key: 'role',
                                        value: {
                                            kind: {
                                                $case: 'stringValue',
                                                value: 'assistant',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            { message: { role: 'assistant' } },
        ],
        [
            'messageUpdate',
            {
                $case: 'messageUpdate',
                value: { type: 'text_delta', contentIndex: 0n, delta: 'hi' },
            },
            {
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'hi',
                },
            },
        ],
        [
            'messageEnd',
            {
                $case: 'messageEnd',
                value: { message: MESSAGES[0] },
            },
            { message: LEGACY_MESSAGES[0] },
        ],
        ['transcriptReset', { $case: 'transcriptReset', value: {} }, {}],
        [
            'rpcExited',
            { $case: 'rpcExited', value: { reason: 'exited' } },
            { reason: 'exited' },
        ],
        [
            'subagentFleet',
            {
                $case: 'subagentFleet',
                value: {
                    fleet: {
                        kind: { $case: 'objectValue', value: { entries: [] } },
                    },
                },
            },
            {},
        ],
        [
            'autoRetryStart',
            {
                $case: 'autoRetryStart',
                value: {
                    attempt: 1n,
                    maxAttempts: 3n,
                    delayMs: 500n,
                    errorMessage: 'rate limited',
                },
            },
            {
                attempt: 1,
                maxAttempts: 3,
                delayMs: 500,
                errorMessage: 'rate limited',
            },
        ],
        [
            'autoRetryEnd',
            {
                $case: 'autoRetryEnd',
                value: { success: false, attempt: 2n, finalError: 'nope' },
            },
            { success: false, attempt: 2, finalError: 'nope' },
        ],
        [
            'summarizationRetryScheduled',
            {
                $case: 'summarizationRetryScheduled',
                value: {
                    attempt: 1n,
                    maxAttempts: 2n,
                    delayMs: 1000n,
                    errorMessage: 'busy',
                },
            },
            {
                attempt: 1,
                maxAttempts: 2,
                delayMs: 1000,
                errorMessage: 'busy',
            },
        ],
        [
            'summarizationRetryFinished',
            {
                $case: 'summarizationRetryFinished',
                value: { success: true, attempt: 1n },
            },
            { success: true, attempt: 1 },
        ],
        [
            'compactionEnd',
            {
                $case: 'compactionEnd',
                value: {
                    aborted: false,
                    reason: 'manual',
                    errorMessage: 'partial',
                    result: {
                        kind: {
                            $case: 'objectValue',
                            value: {
                                entries: [
                                    {
                                        key: 'summary',
                                        value: {
                                            kind: {
                                                $case: 'stringValue',
                                                value: 's',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            {
                aborted: false,
                reason: 'manual',
                errorMessage: 'partial',
                result: { summary: 's' },
            },
        ],
        [
            'extensionError',
            { $case: 'extensionError', value: { error: 'kaput' } },
            { error: 'kaput' },
        ],
    ];

    it.each(cases)('converts the %s event', (evt, value, data) => {
        const envelope = eventFromWire(
            eventFrame({ sid: 'sid-1', seq: 4n, event: value }),
        );
        expect(envelope).toEqual({ t: 'evt', sid: 'sid-1', seq: 4, evt, data });
    });

    it('covers all 13 sequenced event variants exactly once', () => {
        const names = new Set(
            cases.filter(([evt]) => evt !== 'stateChanged').map(([evt]) => evt),
        );
        expect([...names].sort()).toEqual([
            'autoRetryEnd',
            'autoRetryStart',
            'compactionEnd',
            'extensionError',
            'messageEnd',
            'messageStart',
            'messageUpdate',
            'rpcExited',
            'subagentFleet',
            'summarizationRetryFinished',
            'summarizationRetryScheduled',
            'transcriptReset',
        ]);
    });

    it('keeps absent event fields absent and false/zero visible', () => {
        expect(
            eventFromWire(
                eventFrame({
                    sid: 's',
                    seq: 1n,
                    event: { $case: 'rpcExited', value: {} },
                }),
            ).data,
        ).toEqual({});
        expect(
            eventFromWire(
                eventFrame({
                    sid: 's',
                    seq: 1n,
                    event: {
                        $case: 'autoRetryEnd',
                        value: { success: false, attempt: 0n },
                    },
                }),
            ).data,
        ).toEqual({ success: false, attempt: 0 });
        expect(
            eventFromWire(
                eventFrame({
                    sid: 's',
                    seq: 1n,
                    event: { $case: 'stateChanged', value: {} },
                }),
            ).data,
        ).toBeUndefined();
    });

    it('rejects an event without a variant or with an unsafe seq', () => {
        expect(() => eventFromWire(eventFrame({ sid: 's', seq: 1n }))).toThrow(
            /no variant/,
        );
        expect(() =>
            eventFromWire({
                sid: 's',
                seq: 2n ** 60n,
                event: { $case: 'transcriptReset', value: {} },
            }),
        ).toThrow(/safe integer range/);
    });
});

describe('external values', () => {
    function objectValue(pairs) {
        return {
            kind: {
                $case: 'objectValue',
                value: {
                    entries: Object.entries(pairs).map(([key, value]) => ({
                        key,
                        value,
                    })),
                },
            },
        };
    }

    it('keeps reserved keys and object prototypes intact', () => {
        const reserved = {
            kind: {
                $case: 'objectValue',
                value: {
                    entries: [
                        {
                            key: '__proto__',
                            value: {
                                kind: { $case: 'stringValue', value: 'x' },
                            },
                        },
                        {
                            key: 'constructor',
                            value: {
                                kind: { $case: 'boolValue', value: false },
                            },
                        },
                    ],
                },
            },
        };
        const decoded = externalToJS(reserved);
        expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
        expect(decoded.__proto__).toBe('x');
        expect(decoded.constructor).toBe(false);
        expect(externalFromJS(decoded)).toEqual(reserved);
    });

    it('keeps null, false, zero, and empty containers distinct from absence', () => {
        const value = externalToJS(
            objectValue({
                nul: { kind: { $case: 'nullValue', value: {} } },
                no: { kind: { $case: 'boolValue', value: false } },
                zero: { kind: { $case: 'intValue', value: 0n } },
                empty: { kind: { $case: 'listValue', value: { values: [] } } },
            }),
        );
        expect(value).toEqual({ nul: null, no: false, zero: 0, empty: [] });
        expect(externalToJS(undefined)).toBeUndefined();
        expect(
            externalToJS({ kind: { $case: 'nullValue', value: {} } }),
        ).toBeNull();
    });

    it('rejects duplicate keys, missing variants, and nonfinite numbers', () => {
        expect(() =>
            externalToJS({
                kind: {
                    $case: 'objectValue',
                    value: {
                        entries: [
                            {
                                key: 'a',
                                value: {
                                    kind: { $case: 'boolValue', value: true },
                                },
                            },
                            {
                                key: 'a',
                                value: {
                                    kind: { $case: 'boolValue', value: false },
                                },
                            },
                        ],
                    },
                },
            }),
        ).toThrow(/duplicate key/);
        expect(() => externalToJS({ kind: undefined })).toThrow(/no variant/);
        expect(() =>
            externalToJS({ kind: { $case: 'numberValue', value: Number.NaN } }),
        ).toThrow(/nonfinite/);
        expect(() =>
            externalToJS({ kind: { $case: 'numberValue', value: Infinity } }),
        ).toThrow(/nonfinite/);
        // Pi data may hold integers a JS number cannot represent exactly. The
        // server sends those as doubles, so the browser reads an ordinary
        // number; a wide int_value is still a protocol bound violation.
        expect(
            externalToJS({
                kind: { $case: 'numberValue', value: 9007199254740992 },
            }),
        ).toBe(9007199254740992);
        expect(() =>
            externalToJS({
                kind: { $case: 'intValue', value: 9007199254740992n },
            }),
        ).toThrow(/safe integer range/);
        expect(() =>
            externalToJS({
                kind: { $case: 'listValue', value: { values: [undefined] } },
            }),
        ).toThrow(/empty element/);
        expect(() =>
            externalToJS({
                kind: {
                    $case: 'objectValue',
                    value: { entries: [{ key: 'a', value: undefined }] },
                },
            }),
        ).toThrow(/empty value/);
    });

    it('accepts depth 24 and rejects depth 25 in both directions', () => {
        const nested = (depth) => {
            let value = { kind: { $case: 'boolValue', value: true } };
            for (let level = 1; level < depth; level++)
                value = {
                    kind: { $case: 'listValue', value: { values: [value] } },
                };
            return value;
        };
        expect(externalToJS(nested(24))).toBeDefined();
        expect(() => externalToJS(nested(25))).toThrow(/depth bound/);

        const jsNested = (depth) => {
            let value = true;
            for (let level = 1; level < depth; level++) value = [value];
            return value;
        };
        expect(externalFromJS(jsNested(24))).toBeDefined();
        expect(() => externalFromJS(jsNested(25))).toThrow(/depth bound/);
    });

    it('accepts 100000 nodes and rejects 100001', () => {
        const list = (count) => ({
            kind: {
                $case: 'listValue',
                value: {
                    values: Array.from({ length: count }, () => ({
                        kind: { $case: 'boolValue', value: true },
                    })),
                },
            },
        });
        expect(externalToJS(list(99_999))).toHaveLength(99_999);
        expect(() => externalToJS(list(100_000))).toThrow(/node bound/);
        expect(
            externalFromJS(Array.from({ length: 99_999 }, () => true)),
        ).toBeDefined();
        expect(() =>
            externalFromJS(Array.from({ length: 100_000 }, () => true)),
        ).toThrow(/node bound/);
    });

    it('rejects cycles and unsupported JavaScript values before encoding', () => {
        const cyclic = [];
        cyclic.push(cyclic);
        expect(() => externalFromJS(cyclic)).toThrow(/cycle/);
        const cyclicObject = {};
        cyclicObject.self = cyclicObject;
        expect(() => externalFromJS(cyclicObject)).toThrow(/cycle/);
        expect(() => externalFromJS(undefined)).toThrow(/not supported/);
        expect(() => externalFromJS(Symbol('x'))).toThrow(/not supported/);
        expect(() => externalFromJS(() => true)).toThrow(/not supported/);
        expect(() => externalFromJS(new Date(0))).toThrow(/not plain data/);
        expect(() => externalFromJS(Number.NaN)).toThrow(/nonfinite/);
    });
});

class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        this.throwOnSend = false;
        FakeWebSocket.instances.push(this);
    }

    send(raw) {
        if (this.throwOnSend) throw new Error('send failed');
        this.sent.push(ControlClientFrame.decode(new Uint8Array(raw)));
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(frame) {
        const bytes = ControlServerFrame.encode(
            ControlServerFrame.fromPartial(frame),
        ).finish();
        this.onmessage?.({ data: new Uint8Array(bytes).buffer });
    }

    close() {
        this.readyState = 3;
        this.closed = true;
        this.onclose?.();
    }
}

describe('control transport failures', () => {
    it('cleans up pending calls and timers when a send throws', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        socket.throwOnSend = true;
        const pending = client.call('getState', 'sid-1', {});
        await expect(pending).rejects.toThrow('control socket error');
        expect(vi.getTimerCount()).toBe(0);
        expect(socket.closed).toBe(true);
    });

    it('cleans up queued frames when a flush send throws', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('getState', 'sid-1', {});
        socket.throwOnSend = true;
        socket.open();
        await expect(pending).rejects.toThrow('control socket error');
        expect(vi.getTimerCount()).toBe(0);
        expect(socket.closed).toBe(true);
    });

    it('closes the stream on a malformed live event and rejects pending calls', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('getState', 'sid-1', {});
        socket.open();
        socket.receive({
            payload: {
                $case: 'event',
                value: {
                    sid: 's',
                    seq: 1n,
                    event: {
                        $case: 'messageEnd',
                        value: {
                            message: {
                                role: 'user',
                                content: {
                                    kind: {
                                        $case: 'numberValue',
                                        value: Number.NaN,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        await expect(pending).rejects.toThrow(/malformed/);
        expect(socket.closed).toBe(true);
    });

    it('ignores late responses and rejects a mismatched live response variant', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        const events = [];
        client.onMessage((event) => events.push(event));
        socket.receive({
            payload: {
                $case: 'response',
                value: {
                    id: 'expired',
                    result: { $case: 'prompt', value: { accepted: true } },
                },
            },
        });
        expect(events).toEqual([]);
        expect(socket.closed).toBe(false);

        const pending = client.call('abort', 'sid-1', {});
        socket.receive({
            payload: {
                $case: 'response',
                value: {
                    id: 'c1',
                    result: { $case: 'getState', value: { state: FULL_STATE } },
                },
            },
        });
        await expect(pending).rejects.toThrow(/does not match abort/);
        expect(socket.closed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
