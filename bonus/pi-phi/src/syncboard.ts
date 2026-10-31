import { Type } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
    SyncboardOperation,
    SyncboardOutcome,
    type SyncboardResponse,
} from './gen/bridge.js';
import { SyncboardCallError } from './runtime.js';
import { MAX_SYNCBOARD_VALUE_BYTES } from './protocol.js';

const toolParameters = Type.Object(
    {
        operation: Type.Union([
            Type.Literal('list'),
            Type.Literal('get'),
            Type.Literal('upsert'),
            Type.Literal('delete'),
        ]),
        key: Type.Optional(Type.String()),
        value: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
);

export interface SyncboardRuntime {
    requestSyncboard(
        operation: SyncboardOperation,
        key: string,
        valueJson?: Uint8Array,
        signal?: AbortSignal,
    ): Promise<SyncboardResponse>;
}

export interface SyncboardToolOptions {
    readonly currentRuntime: () => SyncboardRuntime | null;
    readonly disabled: () => boolean;
    readonly isOwned: () => boolean;
    readonly setOwned: (owned: boolean) => void;
}

export interface SyncboardToolManager {
    /** Registers a hidden tool only when this extension owns the name. */
    prepare(): boolean;
    /** Exposes or withdraws the owned tool after bridge negotiation. */
    setAvailable(available: boolean): void;
}

/**
 * Register one model-callable tool on the bound host. A pre-existing tool
 * with the same name belongs to its current owner and is never replaced.
 */
export function createSyncboardToolManager(
    pi: ExtensionAPI,
    options: SyncboardToolOptions,
): SyncboardToolManager {
    const register = (tool: ToolDefinition<typeof toolParameters>): void => {
        if (typeof pi.registerTool !== 'function')
            throw new Error('Tool registration unavailable');
        pi.registerTool(tool);
    };

    const makeTool = (
        exposure: 'direct' | 'hidden',
    ): ToolDefinition<typeof toolParameters> => ({
        name: 'syncboard',
        label: 'Syncboard',
        description:
            'Read and update messages on the shared Syncboard configured by this Phi process. Values can contain JSON card data. Supports list, get, upsert, and delete.',
        promptSnippet: 'Read or update messages on Phi Syncboard.',
        promptGuidelines: [
            'Use list before acting when the current board state is not known.',
            'Do not retry an upsert or delete when its outcome is unknown. Read the key after reconnection first.',
        ],
        parameters: toolParameters,
        exposure,
        execute: async (_toolCallId, params, signal) => {
            const parsed = validateSyncboardInput(params);
            if (options.disabled()) {
                manager.setAvailable(false);
                throw new Error(
                    'Syncboard is unavailable because the Phi bridge is disabled.',
                );
            }
            const runtime = options.currentRuntime();
            if (!runtime)
                throw new Error(
                    'Syncboard is unavailable because the Phi bridge is not connected.',
                );
            let response: SyncboardResponse;
            try {
                response = await runtime.requestSyncboard(
                    parsed.operation,
                    parsed.key,
                    parsed.valueJson,
                    signal,
                );
            } catch (error) {
                if (error instanceof SyncboardCallError) {
                    throw new Error(formatCallError(error));
                }
                throw new Error('Syncboard request failed.');
            }
            const result = parseSyncboardResponse(response, parsed);
            return {
                content: [
                    { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
                details: { operation: parsed.operation, result },
            };
        },
    });

    const manager: SyncboardToolManager = {
        prepare(): boolean {
            if (!pi.registerTool) return false;
            if (options.isOwned()) {
                try {
                    register(makeTool('hidden'));
                    return true;
                } catch {
                    return false;
                }
            }
            try {
                const tools = pi.getAllTools();
                if (
                    !Array.isArray(tools) ||
                    tools.some((tool) => tool.name === 'syncboard')
                )
                    return false;
                register(makeTool('hidden'));
                options.setOwned(true);
                return true;
            } catch {
                return false;
            }
        },
        setAvailable(available: boolean): void {
            if (!options.isOwned()) return;
            const exposure =
                available && !options.disabled() ? 'direct' : 'hidden';
            try {
                register(makeTool(exposure));
            } catch {
                // Tool registration failure only disables Syncboard.
            }
        },
    };
    return manager;
}

export interface ValidatedSyncboardInput {
    readonly operation: SyncboardOperation;
    readonly key: string;
    readonly valueJson?: Uint8Array;
}

export function validateSyncboardInput(
    value: unknown,
): ValidatedSyncboardInput {
    if (!isRecord(value)) throw new Error('Invalid Syncboard request.');
    const operation = value.operation;
    const hasKey = Object.hasOwn(value, 'key');
    const hasValue = Object.hasOwn(value, 'value');
    if (operation === 'list') {
        if (hasKey || hasValue)
            throw new Error('List accepts no key or value.');
        return {
            operation: SyncboardOperation.SYNCBOARD_OPERATION_LIST,
            key: '',
        };
    }
    if (operation !== 'get' && operation !== 'upsert' && operation !== 'delete')
        throw new Error('Invalid Syncboard operation.');
    if (!hasKey || typeof value.key !== 'string')
        throw new Error('Operation requires a key.');
    if (operation !== 'upsert' && hasValue)
        throw new Error('Get and delete accept no value.');
    if (operation === 'upsert' && !hasValue)
        throw new Error('Upsert requires a JSON value.');
    const key = trimGoSpace(value.key);
    if (!validKey(key)) throw new Error('Invalid Syncboard key.');
    if (operation === 'get')
        return { operation: SyncboardOperation.SYNCBOARD_OPERATION_GET, key };
    if (operation === 'delete')
        return {
            operation: SyncboardOperation.SYNCBOARD_OPERATION_DELETE,
            key,
        };
    if (!isJsonValue(value.value)) throw new Error('Value must be valid JSON.');
    let text: string;
    try {
        const encoded = JSON.stringify(value.value);
        if (encoded === undefined) throw new Error('not JSON');
        text = encoded;
    } catch {
        throw new Error('Value must be valid JSON.');
    }
    const valueJson = Buffer.from(text, 'utf8');
    if (
        valueJson.byteLength === 0 ||
        valueJson.byteLength > MAX_SYNCBOARD_VALUE_BYTES
    )
        throw new Error('Syncboard value exceeds the 64 KiB limit.');
    return {
        operation: SyncboardOperation.SYNCBOARD_OPERATION_UPSERT,
        key,
        valueJson,
    };
}

function trimGoSpace(value: string): string {
    return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function validKey(key: string): boolean {
    if (
        key === '' ||
        Buffer.byteLength(key, 'utf8') > 256 ||
        hasLoneSurrogate(key)
    )
        return false;
    return !key.split('/').some((segment) => /^\.+$/u.test(segment));
}

function isJsonValue(value: unknown, active = new Set<object>()): boolean {
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return !hasLoneSurrogate(value);
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (active.has(value)) return false;
    active.add(value);
    try {
        if (Array.isArray(value))
            return value.every((item) => isJsonValue(item, active));
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Object.entries(value).every(
            ([key, item]) =>
                !hasLoneSurrogate(key) && isJsonValue(item, active),
        );
    } catch {
        return false;
    } finally {
        active.delete(value);
    }
}

function hasLoneSurrogate(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function parseSyncboardResponse(
    response: SyncboardResponse,
    request: ValidatedSyncboardInput,
): unknown {
    if (response.outcome === SyncboardOutcome.SYNCBOARD_OUTCOME_NOT_SENT)
        throw new Error(
            `Syncboard request not sent (${safeReason(response.reason)}).`,
        );
    if (response.outcome === SyncboardOutcome.SYNCBOARD_OUTCOME_UNKNOWN) {
        throw new Error(
            `Syncboard result unavailable (${safeReason(response.reason)}). ${uncertaintyMessage}`,
        );
    }
    if (response.outcome !== SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE)
        throw new Error(`Syncboard result unavailable. ${uncertaintyMessage}`);
    if (
        response.httpStatus === 404 &&
        request.operation === SyncboardOperation.SYNCBOARD_OPERATION_GET
    )
        return { found: false, key: request.key };
    if (
        response.httpStatus === 404 &&
        request.operation === SyncboardOperation.SYNCBOARD_OPERATION_DELETE
    )
        return { deleted: true, key: request.key, already_absent: true };
    if (response.httpStatus !== 200) {
        const mutation =
            request.operation ===
                SyncboardOperation.SYNCBOARD_OPERATION_UPSERT ||
            request.operation === SyncboardOperation.SYNCBOARD_OPERATION_DELETE;
        throw new Error(
            `Syncboard returned HTTP ${response.httpStatus} (${safeReason(response.reason)}).${mutation ? ` ${uncertaintyMessage}` : ''}`,
        );
    }
    if (request.operation === SyncboardOperation.SYNCBOARD_OPERATION_DELETE) {
        if (response.bodyJson.length !== 0)
            throw new Error(
                `Syncboard response was invalid. ${uncertaintyMessage}`,
            );
        return { deleted: true, key: request.key, already_absent: false };
    }
    let body: unknown;
    try {
        body = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.bodyJson),
        );
    } catch {
        throw new Error(
            `Syncboard response was invalid. ${uncertaintyMessage}`,
        );
    }
    if (request.operation === SyncboardOperation.SYNCBOARD_OPERATION_LIST) {
        if (!Array.isArray(body) || !body.every(isSyncboardMessage))
            throw new Error(
                `Syncboard response was invalid. ${uncertaintyMessage}`,
            );
        return body;
    }
    if (!isSyncboardMessage(body) || body.key !== request.key)
        throw new Error(
            `Syncboard response was invalid. ${uncertaintyMessage}`,
        );
    return body;
}

function isSyncboardMessage(value: unknown): value is {
    key: string;
    value: string;
    created_at: string;
    updated_at: string;
} {
    if (!isRecord(value)) return false;
    return (
        typeof value.key === 'string' &&
        typeof value.value === 'string' &&
        isTimestamp(value.created_at) &&
        isTimestamp(value.updated_at)
    );
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const uncertaintyMessage =
    'Outcome unknown. Do not retry automatically. Read the key after reconnection before deciding what to do.';

function formatCallError(error: SyncboardCallError): string {
    if (error.outcome === 'unknown')
        return `Syncboard result unavailable (${safeReason(error.reason)}). ${uncertaintyMessage}`;
    return `Syncboard request not sent (${safeReason(error.reason)}).`;
}

function safeReason(reason: string): string {
    switch (reason) {
        case 'unavailable':
        case 'invalid-request':
        case 'invalid-config':
        case 'not-ready':
        case 'busy':
        case 'timeout':
        case 'cancelled':
        case 'too-large':
        case 'invalid-response':
        case 'http-error':
        case 'transport-error':
            return reason;
        default:
            return 'invalid-response';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
