/* Φ phi — chat control wire codec (phi.websocket.control.v1).

   One WebSocket binary message carries one generated frame. This module
   builds typed calls and converts typed results/events back to the plain
   shapes the chat UI already consumes, so the UI keeps its existing
   message, state, and event contracts. */

import type {
    AbortResult,
    AutoRetryEndEvent,
    AutoRetryStartEvent,
    CompactionEndEvent,
    ControlCall,
    ControlEvent,
    ControlResponse,
    ControlServerFrame,
    ControlState,
    ExternalValue,
    Message as ControlMessage,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ModelsResult,
    NewSessionResult,
    SubagentTranscriptResult,
    TranscriptSnapshot,
} from '../proto/control.js';
import {
    ControlClientFrame,
    ControlServerFrame as ServerFrameCodec,
} from '../proto/control.js';

// Whole-message inbound bound, matching the server's control read limit.
export const MaxControlMessageBytes = 16 * 1024 * 1024;
// External-value tree bounds, matching the Go conversion limits.
const MaxExternalDepth = 24;
const MaxExternalNodes = 100_000;

/** Raised for every conversion failure; the transport turns it into a close. */
export class ControlConversionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ControlConversionError';
    }
}

function conversionError(message: string): ControlConversionError {
    return new ControlConversionError(message);
}

/** Legacy JS state shape the chat UI merges (same keys as the old JSON). */
export interface WireState {
    sid: string;
    title: string;
    cwd: string;
    model?: string;
    thinking?: string;
    inputTokens: number | null;
    outputTokens: number | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    skills: string[];
    busy: boolean;
    status: string;
    queueDepth: number;
    sessionPath?: string;
}

/** Legacy sequenced-event envelope delivered to `onMessage` listeners. */
export interface WireEvent {
    t: 'evt';
    sid: string;
    seq: number;
    evt: string;
    data: unknown;
}

type WireArgs = Record<string, unknown>;

function argsOf(args: unknown): WireArgs {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args))
        throw conversionError('call arguments must be an object');
    return args as WireArgs;
}

function stringArg(args: WireArgs, key: string): string {
    const value = args[key];
    if (value === undefined) return '';
    if (typeof value !== 'string')
        throw conversionError(`${key} must be a string`);
    return value;
}

function optionalStringArg(args: WireArgs, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string')
        throw conversionError(`${key} must be a string`);
    return value;
}

/** Encodes the hello frame that opens a control connection. */
export function encodeHello(version: number): Uint8Array<ArrayBuffer> {
    return ControlClientFrame.encode(
        ControlClientFrame.fromPartial({
            payload: { $case: 'hello', value: { version } },
        }),
    ).finish();
}

/** Builds the typed call for one operation. Throws on unknown ops/bad args. */
export function buildCall(
    id: string,
    op: string,
    sid: string | undefined,
    rawArgs: unknown,
): ControlCall {
    const args = argsOf(rawArgs);
    const scope = sid ?? '';
    const call = (payload: ControlCall['call']): ControlCall => ({
        id,
        call: payload,
    });
    switch (op) {
        case 'spawn':
            return call({
                $case: 'spawn',
                value: {
                    cwd: optionalStringArg(args, 'cwd'),
                    sessionPath: optionalStringArg(args, 'sessionPath'),
                },
            });
        case 'listSessions':
            return call({ $case: 'listSessions', value: {} });
        case 'getState':
            return call({ $case: 'getState', value: { sid: scope } });
        case 'hydrate':
            return call({ $case: 'hydrate', value: { sid: scope } });
        case 'getMessages':
            return call({ $case: 'getMessages', value: { sid: scope } });
        case 'prompt':
            return call({
                $case: 'prompt',
                value: {
                    sid: scope,
                    message: stringArg(args, 'message'),
                    streamingBehavior: optionalStringArg(
                        args,
                        'streamingBehavior',
                    ),
                },
            });
        case 'getAvailableModels':
            return call({
                $case: 'getAvailableModels',
                value: { sid: scope },
            });
        case 'setModel':
            return call({
                $case: 'setModel',
                value: {
                    sid: scope,
                    provider: stringArg(args, 'provider'),
                    modelId: stringArg(args, 'modelId'),
                },
            });
        case 'getAvailableThinkingLevels':
            return call({
                $case: 'getAvailableThinkingLevels',
                value: { sid: scope },
            });
        case 'setThinking':
            return call({
                $case: 'setThinking',
                value: { sid: scope, level: stringArg(args, 'level') },
            });
        case 'newSession':
            return call({ $case: 'newSession', value: { sid: scope } });
        case 'abort':
            return call({ $case: 'abort', value: { sid: scope } });
        case 'compact':
            return call({ $case: 'compact', value: { sid: scope } });
        case 'setSessionName':
            return call({
                $case: 'setSessionName',
                value: { sid: scope, name: stringArg(args, 'name') },
            });
        case 'subagentTranscript':
            return call({
                $case: 'subagentTranscript',
                value: { runId: stringArg(args, 'runId') },
            });
        case 'viewReady':
            return call({
                $case: 'viewReady',
                value: { sid: scope === '' ? undefined : scope },
            });
        case 'setCapabilities':
            return call({
                $case: 'setCapabilities',
                value: { sid: scope === '' ? undefined : scope },
            });
        case 'waitViewReady':
            return call({
                $case: 'waitViewReady',
                value: { sid: scope === '' ? undefined : scope },
            });
        case 'dlg':
            return call({
                $case: 'dlg',
                value: { sid: scope === '' ? undefined : scope },
            });
        case 'dlgClosed':
            return call({
                $case: 'dlgClosed',
                value: { sid: scope === '' ? undefined : scope },
            });
        case 'activateTab':
            return call({
                $case: 'activateTab',
                value: { sid: scope === '' ? undefined : scope },
            });
    }
    throw conversionError(`unknown control operation: ${op}`);
}

/** Result variant a call must receive back. */
export function expectedResultCase(op: string): string {
    if (op === 'spawn') return 'spawn';
    return op;
}

/** Encodes one call frame for the control socket. */
export function encodeCall(call: ControlCall): Uint8Array<ArrayBuffer> {
    return ControlClientFrame.encode(
        ControlClientFrame.fromPartial({
            payload: { $case: 'call', value: call },
        }),
    ).finish();
}

/** Decodes one inbound server frame. Throws on malformed bytes. */
export function decodeServerFrame(bytes: Uint8Array): ControlServerFrame {
    return ServerFrameCodec.decode(bytes);
}

function safeNumber(value: bigint, label: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number))
        throw conversionError(`${label} is out of safe integer range`);
    return number;
}

function optionalNumber(
    value: bigint | undefined,
    label: string,
): number | null {
    return value === undefined ? null : safeNumber(value, label);
}

/** Converts a protobuf enum-ish string, keeping absent values absent. */
function present<T>(value: T | undefined): value is T {
    return value !== undefined;
}

/** Converts an external-value tree, enforcing depth/node/duplicate bounds. */
export function externalToJS(value: ExternalValue | undefined): unknown {
    const nodes = { count: 0 };
    return externalValue(value, 1, nodes);
}

function externalValue(
    value: ExternalValue | undefined,
    depth: number,
    nodes: { count: number },
): unknown {
    if (value === undefined) return undefined;
    if (depth > MaxExternalDepth)
        throw conversionError('external value exceeds the depth bound');
    nodes.count += 1;
    if (nodes.count > MaxExternalNodes)
        throw conversionError('external value exceeds the node bound');
    const kind = value.kind;
    if (kind === undefined)
        throw conversionError('external value has no variant');
    switch (kind.$case) {
        case 'nullValue':
            return null;
        case 'boolValue':
            return kind.value;
        case 'stringValue':
            return kind.value;
        case 'intValue':
            return safeNumber(kind.value, 'external integer');
        case 'numberValue':
            if (!Number.isFinite(kind.value))
                throw conversionError('external value has a nonfinite number');
            return kind.value;
        case 'listValue': {
            const out: unknown[] = [];
            for (const item of kind.value.values) {
                if (item === undefined)
                    throw conversionError('external list has an empty element');
                out.push(externalValue(item, depth + 1, nodes));
            }
            return out;
        }
        case 'objectValue': {
            const pairs: Array<[string, unknown]> = [];
            const seen = new Set<string>();
            for (const entry of kind.value.entries) {
                if (entry === undefined)
                    throw conversionError('external object has an empty entry');
                if (seen.has(entry.key))
                    throw conversionError(
                        'external object has a duplicate key',
                    );
                seen.add(entry.key);
                if (entry.value === undefined)
                    throw conversionError('external object has an empty value');
                pairs.push([
                    entry.key,
                    externalValue(entry.value, depth + 1, nodes),
                ]);
            }
            return Object.fromEntries(pairs);
        }
    }
    throw conversionError('external value has an unsupported variant');
}

/** Converts a JS value to an external value. Rejects cycles/unsupported data. */
export function externalFromJS(value: unknown): ExternalValue {
    const nodes = { count: 0 };
    return externalFromValue(value, 1, nodes, new Set());
}

function externalFromValue(
    value: unknown,
    depth: number,
    nodes: { count: number },
    ancestors: Set<object>,
): ExternalValue {
    if (depth > MaxExternalDepth)
        throw conversionError('external value exceeds the depth bound');
    nodes.count += 1;
    if (nodes.count > MaxExternalNodes)
        throw conversionError('external value exceeds the node bound');
    if (value === null) return { kind: { $case: 'nullValue', value: {} } };
    switch (typeof value) {
        case 'boolean':
            return { kind: { $case: 'boolValue', value } };
        case 'string':
            return { kind: { $case: 'stringValue', value } };
        case 'number':
            if (!Number.isFinite(value))
                throw conversionError('external value has a nonfinite number');
            if (Number.isSafeInteger(value))
                return { kind: { $case: 'intValue', value: BigInt(value) } };
            return { kind: { $case: 'numberValue', value } };
        case 'object': {
            if (ancestors.has(value))
                throw conversionError('external value has a cycle');
            ancestors.add(value);
            try {
                if (Array.isArray(value)) {
                    const values = value.map((item) =>
                        externalFromValue(item, depth + 1, nodes, ancestors),
                    );
                    return { kind: { $case: 'listValue', value: { values } } };
                }
                const prototype = Object.getPrototypeOf(value);
                if (prototype !== Object.prototype && prototype !== null)
                    throw conversionError('external value is not plain data');
                const entries = Object.keys(value).map((key) => ({
                    key,
                    value: externalFromValue(
                        (value as Record<string, unknown>)[key],
                        depth + 1,
                        nodes,
                        ancestors,
                    ),
                }));
                return { kind: { $case: 'objectValue', value: { entries } } };
            } finally {
                ancestors.delete(value);
            }
        }
    }
    throw conversionError('external value is not supported');
}

/** Converts one Phi-owned state message to the legacy UI shape. */
export function stateFromWire(
    state: ControlState | undefined,
): WireState | undefined {
    if (state === undefined) return undefined;
    const out: WireState = {
        sid: state.sid,
        title: state.title,
        cwd: state.cwd,
        inputTokens: optionalNumber(state.inputTokens, 'inputTokens'),
        outputTokens: optionalNumber(state.outputTokens, 'outputTokens'),
        contextUsedTokens: optionalNumber(
            state.contextUsedTokens,
            'contextUsedTokens',
        ),
        contextWindowTokens: optionalNumber(
            state.contextWindowTokens,
            'contextWindowTokens',
        ),
        cacheReadTokens: optionalNumber(
            state.cacheReadTokens,
            'cacheReadTokens',
        ),
        cacheWriteTokens: optionalNumber(
            state.cacheWriteTokens,
            'cacheWriteTokens',
        ),
        skills: [...state.skills],
        busy: state.busy,
        status: state.status,
        queueDepth: state.queueDepth,
    };
    // The old JSON omitted empty strings, so an absence must stay absent.
    if (present(state.model) && state.model !== '') out.model = state.model;
    if (present(state.thinking) && state.thinking !== '')
        out.thinking = state.thinking;
    if (present(state.sessionPath) && state.sessionPath !== '')
        out.sessionPath = state.sessionPath;
    return out;
}

function messageFromWire(message: ControlMessage | undefined): unknown {
    if (message === undefined) return undefined;
    const out: Record<string, unknown> = {
        role: message.role,
        content: externalToJS(message.content) ?? null,
    };
    if (message.details !== undefined)
        out.details = externalToJS(message.details) ?? null;
    if (present(message.toolCallId) && message.toolCallId !== '')
        out.toolCallId = message.toolCallId;
    if (present(message.toolName) && message.toolName !== '')
        out.toolName = message.toolName;
    if (present(message.isError)) out.isError = message.isError;
    if (present(message.ts) && message.ts !== 0n)
        out.ts = safeNumber(message.ts, 'message timestamp');
    if (present(message.stopReason) && message.stopReason !== '')
        out.stopReason = message.stopReason;
    if (present(message.errorMessage) && message.errorMessage !== '')
        out.errorMessage = message.errorMessage;
    return out;
}

function messagesFromWire(messages: ControlMessage[]): unknown[] {
    return messages.map((message) => messageFromWire(message));
}

function snapshotFromWire(snapshot: TranscriptSnapshot | undefined): {
    messages: unknown[];
    lastSeq: number;
} {
    if (snapshot === undefined)
        throw conversionError('transcript snapshot is missing');
    return {
        messages: messagesFromWire(snapshot.messages),
        lastSeq: safeNumber(snapshot.lastSeq, 'lastSeq'),
    };
}

function modelsFromWire(result: ModelsResult): unknown {
    return {
        models: result.models.map((model) => {
            const item: Record<string, unknown> = {
                provider: model.provider,
                id: model.id,
            };
            if (present(model.name) && model.name !== '')
                item.name = model.name;
            return item;
        }),
    };
}

function newSessionFromWire(result: NewSessionResult): unknown {
    const out: Record<string, unknown> = { cancelled: result.cancelled };
    if (present(result.reset)) out.reset = result.reset;
    const state = stateFromWire(result.state);
    if (state !== undefined) out.state = state;
    if (present(result.stateWarning) && result.stateWarning !== '')
        out.stateWarning = result.stateWarning;
    return out;
}

function subagentTranscriptFromWire(result: SubagentTranscriptResult): unknown {
    return {
        runId: result.runId,
        steps: result.steps.map((step) => ({
            label: step.label,
            sessionFile: step.sessionFile,
            messages: messagesFromWire(step.messages),
        })),
    };
}

/**
 * Converts one response to the legacy JS result for the pending operation.
 * A wrong variant is a conversion failure, not a generic success.
 */
export function resultFromWire(op: string, response: ControlResponse): unknown {
    const result = response.result;
    if (result === undefined)
        throw conversionError('control response has no result');
    if (result.$case === 'error') throw new Error(result.value.reason);
    const expected = expectedResultCase(op);
    if (result.$case !== expected)
        throw conversionError(
            `control response variant ${result.$case} does not match ${expected}`,
        );
    switch (result.$case) {
        case 'spawn':
            return {
                sid: result.value.sid,
                title: result.value.title,
                cwd: result.value.cwd,
                snapshot: snapshotFromWire(result.value.session),
                state: stateFromWire(result.value.state),
            };
        case 'listSessions':
            return result.value.sessions.map((session) => ({
                sid: session.sid,
                title: session.title,
                cwd: session.cwd,
                status: session.status,
            }));
        case 'getState':
            return stateFromWire(result.value.state);
        case 'hydrate':
        case 'getMessages': {
            const snapshot = snapshotFromWire(result.value.session);
            return {
                messages: snapshot.messages,
                lastSeq: snapshot.lastSeq,
                state: stateFromWire(result.value.session?.state),
            };
        }
        case 'prompt':
            return { accepted: result.value.accepted };
        case 'getAvailableModels':
            return modelsFromWire(result.value);
        case 'setModel':
        case 'setThinking':
        case 'setSessionName':
            return { state: stateFromWire(result.value.state) };
        case 'getAvailableThinkingLevels':
            return { levels: [...result.value.levels] };
        case 'newSession':
            return newSessionFromWire(result.value);
        case 'abort':
            return { aborted: (result.value as AbortResult).aborted };
        case 'compact': {
            const out: Record<string, unknown> = {
                state: stateFromWire(result.value.state),
            };
            if (
                present(result.value.stateWarning) &&
                result.value.stateWarning !== ''
            )
                out.stateWarning = result.value.stateWarning;
            return out;
        }
        case 'subagentTranscript':
            return subagentTranscriptFromWire(result.value);
        case 'viewReady':
        case 'setCapabilities':
        case 'waitViewReady':
        case 'dlg':
        case 'dlgClosed':
        case 'activateTab':
            return { stubbed: true };
    }
    throw conversionError('control response has an unsupported variant');
}

function messageStartFromWire(event: MessageStartEvent): unknown {
    const message = externalToJS(event.message);
    if (message === undefined) return {};
    if (present(event.role) && event.role !== '') {
        const record = message as Record<string, unknown>;
        if (record !== null && typeof record === 'object') {
            if (typeof record.role !== 'string') record.role = event.role;
        }
    }
    return { message };
}

function messageUpdateFromWire(event: MessageUpdateEvent): unknown {
    const assistantMessageEvent: Record<string, unknown> = {};
    if (present(event.type) && event.type !== '')
        assistantMessageEvent.type = event.type;
    if (present(event.contentIndex))
        assistantMessageEvent.contentIndex = safeNumber(
            event.contentIndex,
            'contentIndex',
        );
    if (present(event.delta) && event.delta !== '')
        assistantMessageEvent.delta = event.delta;
    return { assistantMessageEvent };
}

function messageEndFromWire(event: MessageEndEvent): unknown {
    const message = messageFromWire(event.message);
    return message === undefined ? {} : { message };
}

function retryStartFromWire(
    event: AutoRetryStartEvent,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (present(event.attempt))
        out.attempt = safeNumber(event.attempt, 'attempt');
    if (present(event.maxAttempts))
        out.maxAttempts = safeNumber(event.maxAttempts, 'maxAttempts');
    if (present(event.delayMs))
        out.delayMs = safeNumber(event.delayMs, 'delayMs');
    if (present(event.errorMessage) && event.errorMessage !== '')
        out.errorMessage = event.errorMessage;
    return out;
}

function retryEndFromWire(event: AutoRetryEndEvent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (present(event.success)) out.success = event.success;
    if (present(event.attempt))
        out.attempt = safeNumber(event.attempt, 'attempt');
    if (present(event.finalError) && event.finalError !== '')
        out.finalError = event.finalError;
    return out;
}

function compactionEndFromWire(
    event: CompactionEndEvent,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (present(event.aborted)) out.aborted = event.aborted;
    if (present(event.reason) && event.reason !== '') out.reason = event.reason;
    if (present(event.errorMessage) && event.errorMessage !== '')
        out.errorMessage = event.errorMessage;
    const result = externalToJS(event.result);
    if (result !== undefined) out.result = result;
    return out;
}

/** Converts one sequenced event to the legacy envelope the UI consumes. */
export function eventFromWire(event: ControlEvent): WireEvent {
    const envelope = {
        t: 'evt' as const,
        sid: event.sid,
        seq: safeNumber(event.seq, 'event seq'),
    };
    const payload = event.event;
    if (payload === undefined)
        throw conversionError('control event has no variant');
    switch (payload.$case) {
        case 'stateChanged': {
            const change = payload.value.change;
            if (change === undefined)
                return { ...envelope, evt: 'stateChanged', data: undefined };
            if (change.$case === 'state')
                return {
                    ...envelope,
                    evt: 'stateChanged',
                    data: stateFromWire(change.value),
                };
            if (change.$case === 'error')
                return {
                    ...envelope,
                    evt: 'stateChanged',
                    data: { error: change.value.reason },
                };
            throw conversionError('stateChanged has an unsupported variant');
        }
        case 'messageStart':
            return {
                ...envelope,
                evt: 'messageStart',
                data: messageStartFromWire(payload.value),
            };
        case 'messageUpdate':
            return {
                ...envelope,
                evt: 'messageUpdate',
                data: messageUpdateFromWire(payload.value),
            };
        case 'messageEnd':
            return {
                ...envelope,
                evt: 'messageEnd',
                data: messageEndFromWire(payload.value),
            };
        case 'transcriptReset':
            return { ...envelope, evt: 'transcriptReset', data: {} };
        case 'rpcExited': {
            const data: Record<string, unknown> = {};
            if (present(payload.value.reason) && payload.value.reason !== '')
                data.reason = payload.value.reason;
            return { ...envelope, evt: 'rpcExited', data };
        }
        case 'subagentFleet':
            return {
                ...envelope,
                evt: 'subagentFleet',
                data: externalToJS(payload.value.fleet),
            };
        case 'autoRetryStart':
            return {
                ...envelope,
                evt: 'autoRetryStart',
                data: retryStartFromWire(payload.value),
            };
        case 'autoRetryEnd':
            return {
                ...envelope,
                evt: 'autoRetryEnd',
                data: retryEndFromWire(payload.value),
            };
        case 'summarizationRetryScheduled':
            return {
                ...envelope,
                evt: 'summarizationRetryScheduled',
                data: retryStartFromWire(payload.value),
            };
        case 'summarizationRetryFinished':
            return {
                ...envelope,
                evt: 'summarizationRetryFinished',
                data: retryEndFromWire(payload.value),
            };
        case 'compactionEnd':
            return {
                ...envelope,
                evt: 'compactionEnd',
                data: compactionEndFromWire(payload.value),
            };
        case 'extensionError': {
            const data: Record<string, unknown> = {};
            if (present(payload.value.error) && payload.value.error !== '')
                data.error = payload.value.error;
            return { ...envelope, evt: 'extensionError', data };
        }
    }
    throw conversionError('control event has an unsupported variant');
}
