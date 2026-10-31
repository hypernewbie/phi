import { describe, expect, it, vi } from 'vitest';
import type {
    ExtensionAPI,
    ExtensionToolContext,
    ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { SyncboardOperation, SyncboardOutcome } from './gen/bridge.js';
import {
    createSyncboardToolManager,
    validateSyncboardInput,
    type SyncboardRuntime,
} from './syncboard.js';
import { SyncboardCallError } from './runtime.js';

const uncertaintyMessage =
    'Outcome unknown. Do not retry automatically. Read the key after reconnection before deciding what to do.';

function fakeApi(
    registered: ToolDefinition[],
    names: string[] = [],
): ExtensionAPI {
    return {
        registerTool: (tool: ToolDefinition) => registered.push(tool),
        getAllTools: () =>
            [...names, ...registered.map((tool) => tool.name)].map((name) => ({
                name,
            })),
    } as unknown as ExtensionAPI;
}

describe('Syncboard tool validation', () => {
    it('preserves JSON values and trims keys like Go', () => {
        expect(validateSyncboardInput({ operation: 'list' })).toEqual({
            operation: SyncboardOperation.SYNCBOARD_OPERATION_LIST,
            key: '',
        });
        expect(
            validateSyncboardInput({ operation: 'get', key: ' card-a ' }),
        ).toEqual({
            operation: SyncboardOperation.SYNCBOARD_OPERATION_GET,
            key: 'card-a',
        });
        expect(
            validateSyncboardInput({ operation: 'delete', key: 'card-a' }),
        ).toEqual({
            operation: SyncboardOperation.SYNCBOARD_OPERATION_DELETE,
            key: 'card-a',
        });
        for (const value of [null, false, 0, '']) {
            const upsert = validateSyncboardInput({
                operation: 'upsert',
                key: '\u0085card/a\u0085',
                value,
            });
            expect(upsert.operation).toBe(
                SyncboardOperation.SYNCBOARD_OPERATION_UPSERT,
            );
            expect(upsert.key).toBe('card/a');
            expect(Buffer.from(upsert.valueJson!).toString('utf8')).toBe(
                JSON.stringify(value),
            );
        }
    });

    it('keeps Go whitespace and exact UTF-8 byte limits', () => {
        expect(
            validateSyncboardInput({
                operation: 'get',
                key: '\ufeffcard\ufeff',
            }).key,
        ).toBe('\ufeffcard\ufeff');
        expect(
            validateSyncboardInput({ operation: 'get', key: 'é'.repeat(128) })
                .key,
        ).toBe('é'.repeat(128));
        expect(() =>
            validateSyncboardInput({ operation: 'get', key: 'é'.repeat(129) }),
        ).toThrow();
        const value = 'é'.repeat(32767);
        expect(
            validateSyncboardInput({
                operation: 'upsert',
                key: 'card-a',
                value,
            }).valueJson?.byteLength,
        ).toBe(64 * 1024);
        expect(() =>
            validateSyncboardInput({
                operation: 'upsert',
                key: 'card-a',
                value: `${value}x`,
            }),
        ).toThrow();
    });

    it('rejects missing values, invalid keys, lone surrogates, and oversized JSON', () => {
        for (const input of [
            { operation: 'list', key: 'unexpected' },
            { operation: 'upsert', key: 'card-a' },
            { operation: 'get' },
            { operation: 'get', key: 'card-a', value: null },
            { operation: 'delete', key: 'card-a', value: null },
            { operation: '...' },
            { operation: 'upsert', key: '...', value: null },
            { operation: 'upsert', key: '\ud800', value: null },
            { operation: 'upsert', key: 'card-a', value: '\ud800' },
            { operation: 'upsert', key: 'x'.repeat(257), value: null },
            {
                operation: 'upsert',
                key: 'card-a',
                value: 'x'.repeat(64 * 1024),
            },
        ]) {
            expect(() => validateSyncboardInput(input)).toThrow();
        }
    });
});

describe('Syncboard operation results', () => {
    it('maps get/delete responses and not-found statuses to stable results', async () => {
        const registered: ToolDefinition[] = [];
        const responses = [
            {
                requestId: '1',
                outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
                httpStatus: 200,
                bodyJson: Buffer.from(
                    '{"key":"card-a","value":"{\\"state\\":true}","created_at":"2025-01-02T03:04:05Z","updated_at":"2025-01-02T03:04:05Z"}',
                ),
                reason: '',
            },
            {
                requestId: '2',
                outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
                httpStatus: 404,
                bodyJson: Buffer.alloc(0),
                reason: '',
            },
            {
                requestId: '3',
                outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
                httpStatus: 200,
                bodyJson: Buffer.alloc(0),
                reason: '',
            },
            {
                requestId: '4',
                outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
                httpStatus: 404,
                bodyJson: Buffer.alloc(0),
                reason: '',
            },
        ];
        const request = vi.fn(async () => responses.shift()!);
        const manager = createSyncboardToolManager(fakeApi(registered), {
            currentRuntime: () => ({ requestSyncboard: request }),
            disabled: () => false,
            isOwned: () => true,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(true);
        manager.setAvailable(true);
        const tool = registered.at(-1)!;
        const cases = [
            {
                params: { operation: 'get', key: 'card-a' },
                expected: {
                    key: 'card-a',
                    value: '{"state":true}',
                    created_at: '2025-01-02T03:04:05Z',
                    updated_at: '2025-01-02T03:04:05Z',
                },
            },
            {
                params: { operation: 'get', key: 'absent' },
                expected: { found: false, key: 'absent' },
            },
            {
                params: { operation: 'delete', key: 'card-a' },
                expected: {
                    deleted: true,
                    key: 'card-a',
                    already_absent: false,
                },
            },
            {
                params: { operation: 'delete', key: 'absent' },
                expected: {
                    deleted: true,
                    key: 'absent',
                    already_absent: true,
                },
            },
        ];
        for (const item of cases) {
            const result = await tool.execute(
                'call',
                item.params,
                undefined,
                undefined,
                {} as ExtensionToolContext,
            );
            const content = result.content[0];
            if (!content || content.type !== 'text')
                throw new Error('missing tool text result');
            expect(JSON.parse(content.text)).toEqual(item.expected);
        }
        expect(request).toHaveBeenCalledTimes(4);
    });
});

describe('Syncboard mutation errors', () => {
    it.each([401, 403, 429, 500])(
        'warns against retrying mutations after HTTP %i',
        async (httpStatus) => {
            const registered: ToolDefinition[] = [];
            const request = vi.fn(async () => ({
                requestId: '1',
                outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
                httpStatus,
                bodyJson: Buffer.alloc(0),
                reason: 'http-error',
            }));
            const manager = createSyncboardToolManager(fakeApi(registered), {
                currentRuntime: () => ({ requestSyncboard: request }),
                disabled: () => false,
                isOwned: () => true,
                setOwned: () => {},
            });
            manager.prepare();
            manager.setAvailable(true);
            const tool = registered.at(-1)!;
            for (const params of [
                { operation: 'upsert', key: 'card-a', value: null },
                { operation: 'delete', key: 'card-a' },
            ]) {
                await expect(
                    tool.execute(
                        'mutation',
                        params,
                        undefined,
                        undefined,
                        {} as ExtensionToolContext,
                    ),
                ).rejects.toThrow(
                    `Syncboard returned HTTP ${httpStatus} (http-error). ${uncertaintyMessage}`,
                );
            }
            await expect(
                tool.execute(
                    'read',
                    { operation: 'get', key: 'card-a' },
                    undefined,
                    undefined,
                    {} as ExtensionToolContext,
                ),
            ).rejects.toThrow(
                `Syncboard returned HTTP ${httpStatus} (http-error).`,
            );
            expect(request).toHaveBeenCalledTimes(3);
        },
    );
});

describe('Syncboard tool registration', () => {
    it('keeps the tool hidden until negotiation and sends only fixed operations', async () => {
        const registered: ToolDefinition[] = [];
        const api = fakeApi(registered);
        const call = vi.fn(async () => ({
            requestId: '1',
            outcome: SyncboardOutcome.SYNCBOARD_OUTCOME_HTTP_RESPONSE,
            httpStatus: 200,
            bodyJson: Buffer.from('[]'),
            reason: '',
        }));
        let disabled = false;
        const runtime: SyncboardRuntime = {
            requestSyncboard: call,
        };
        let owned = false;
        const manager = createSyncboardToolManager(api, {
            currentRuntime: () => runtime,
            disabled: () => disabled,
            isOwned: () => owned,
            setOwned: (value) => {
                owned = value;
            },
        });

        expect(manager.prepare()).toBe(true);
        expect(owned).toBe(true);
        expect(registered.at(-1)?.exposure).toBe('hidden');
        manager.setAvailable(true);
        expect(registered.at(-1)?.exposure).toBe('direct');
        const tool = registered.at(-1)!;
        const result = await tool.execute(
            'call-1',
            { operation: 'list' },
            undefined,
            undefined,
            {} as ExtensionToolContext,
        );
        expect(call).toHaveBeenCalledWith(
            SyncboardOperation.SYNCBOARD_OPERATION_LIST,
            '',
            undefined,
            undefined,
        );
        expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
        manager.setAvailable(false);
        expect(registered.at(-1)?.exposure).toBe('hidden');
    });

    it('contains registration failures to Syncboard', () => {
        const registerTool = vi.fn(() => {
            throw new Error('host registration failed');
        });
        const api = {
            registerTool,
            getAllTools: () => [],
        } as unknown as ExtensionAPI;
        const manager = createSyncboardToolManager(api, {
            currentRuntime: () => null,
            disabled: () => false,
            isOwned: () => false,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(false);
        expect(() => manager.setAvailable(true)).not.toThrow();
        expect(registerTool).toHaveBeenCalledTimes(1);
    });

    it('rejects omitted and oversized values before bridge dispatch', async () => {
        const registered: ToolDefinition[] = [];
        const request = vi.fn();
        const manager = createSyncboardToolManager(fakeApi(registered), {
            currentRuntime: () =>
                ({ requestSyncboard: request }) as unknown as SyncboardRuntime,
            disabled: () => false,
            isOwned: () => true,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(true);
        manager.setAvailable(true);
        const tool = registered.at(-1)!;
        for (const params of [
            { operation: 'upsert', key: 'card-a' },
            {
                operation: 'upsert',
                key: 'card-a',
                value: 'x'.repeat(64 * 1024),
            },
        ]) {
            await expect(
                tool.execute(
                    'invalid',
                    params,
                    undefined,
                    undefined,
                    {} as ExtensionToolContext,
                ),
            ).rejects.toThrow();
        }
        expect(request).not.toHaveBeenCalled();
    });

    it('does not replace another extension tool with the same name', () => {
        const registered: ToolDefinition[] = [];
        const api = fakeApi(registered, ['syncboard']);
        const manager = createSyncboardToolManager(api, {
            currentRuntime: () => null,
            disabled: () => false,
            isOwned: () => false,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(false);
        expect(registered).toEqual([]);
    });

    it('surfaces uncertainty without retrying an admitted mutation', async () => {
        const registered: ToolDefinition[] = [];
        const api = fakeApi(registered);
        const request = vi.fn(async () => {
            throw new SyncboardCallError('unknown', 'timeout');
        });
        const manager = createSyncboardToolManager(api, {
            currentRuntime: () => ({ requestSyncboard: request }),
            disabled: () => false,
            isOwned: () => true,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(true);
        manager.setAvailable(true);
        const tool = registered.at(-1)!;
        await expect(
            tool.execute(
                'call-2',
                {
                    operation: 'upsert',
                    key: 'card-a',
                    value: { state: 'ready' },
                },
                undefined,
                undefined,
                {} as ExtensionToolContext,
            ),
        ).rejects.toThrow(uncertaintyMessage);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('checks bridge disablement again at tool execution', async () => {
        const registered: ToolDefinition[] = [];
        const api = fakeApi(registered);
        const request = vi.fn();
        let disabled = false;
        const manager = createSyncboardToolManager(api, {
            currentRuntime: () =>
                ({ requestSyncboard: request }) as unknown as SyncboardRuntime,
            disabled: () => disabled,
            isOwned: () => true,
            setOwned: () => {},
        });
        expect(manager.prepare()).toBe(true);
        manager.setAvailable(true);
        const tool = registered.at(-1)!;
        disabled = true;
        await expect(
            tool.execute(
                'call-3',
                { operation: 'list' },
                undefined,
                undefined,
                {} as ExtensionToolContext,
            ),
        ).rejects.toThrow('bridge is disabled');
        expect(request).not.toHaveBeenCalled();
        expect(registered.at(-1)?.exposure).toBe('hidden');
    });
});
