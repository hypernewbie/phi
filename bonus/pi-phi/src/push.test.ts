import { describe, expect, it } from 'vitest';
import { SyncboardNotification } from './gen/bridge.js';
import {
    MAX_REMEMBERED_PUSH_IDS,
    MAX_SYNCBOARD_PUSH_INJECT_BYTES,
    SYNCBOARD_PUSH_CUSTOM_TYPE,
    createSyncboardPushHandler,
    formatPushContent,
} from './push.js';

function notification(
    overrides: Partial<{
        seq: bigint;
        sender: string;
        recipient: string;
        value: Buffer;
        messageId: string;
    }> = {},
): SyncboardNotification {
    return SyncboardNotification.create({
        seq: 1n,
        sender: 'agent-a',
        recipient: 'agent-b',
        value: Buffer.from('hello'),
        messageId: 'm-1',
        ...overrides,
    });
}

function harness(inject?: (customType: string, content: string) => void) {
    const injected: { customType: string; content: string }[] = [];
    const acks: { seq: bigint; messageId: string }[] = [];
    const handler = createSyncboardPushHandler({
        inject:
            inject ??
            ((customType, content) => {
                injected.push({ customType, content });
            }),
        ack: (seq, messageId) => {
            acks.push({ seq, messageId });
        },
    });
    return { handler, injected, acks };
}

describe('formatPushContent', () => {
    it('names the sender and id, then the value', () => {
        const content = formatPushContent(notification());
        expect(content).toContain('from=agent-a');
        expect(content).toContain('message_id=m-1');
        expect(content.endsWith('hello')).toBe(true);
    });

    it('states truncation instead of silently dropping bytes', () => {
        const value = Buffer.alloc(MAX_SYNCBOARD_PUSH_INJECT_BYTES + 100, 'a');
        const content = formatPushContent(notification({ value }));
        expect(content).toContain(
            `[truncated: first ${MAX_SYNCBOARD_PUSH_INJECT_BYTES} of ${value.byteLength} bytes]`,
        );
    });
});

describe('createSyncboardPushHandler', () => {
    it('injects once with the phi-syncboard custom type and acknowledges', () => {
        const { handler, injected, acks } = harness();
        handler.accept(notification());

        expect(injected).toHaveLength(1);
        expect(injected[0]!.customType).toBe(SYNCBOARD_PUSH_CUSTOM_TYPE);
        expect(injected[0]!.content).toContain('hello');
        expect(acks).toEqual([{ seq: 1n, messageId: 'm-1' }]);
    });

    it('acknowledges a resent message without injecting twice', () => {
        const { handler, injected, acks } = harness();
        handler.accept(notification());
        handler.accept(notification());

        expect(injected).toHaveLength(1);
        expect(acks).toHaveLength(2);
    });

    it('does not acknowledge when the host refuses, so the sender retries', () => {
        const { handler, acks } = harness(() => {
            throw new Error('host busy');
        });
        handler.accept(notification());

        expect(acks).toEqual([]);
        expect(handler.remembered()).toBe(0);
    });

    it('re-injects the same id after a host failure, since it was never delivered', () => {
        let fail = true;
        const injected: string[] = [];
        const { handler } = harness((_type, content) => {
            if (fail) throw new Error('host busy');
            injected.push(content);
        });

        handler.accept(notification());
        fail = false;
        handler.accept(notification());

        expect(injected).toHaveLength(1);
    });

    it('refuses a message without an id rather than risking a double turn', () => {
        const { handler, injected, acks } = harness();
        handler.accept(notification({ messageId: '' }));

        expect(injected).toEqual([]);
        expect(acks).toEqual([]);
    });

    it('injects nothing when the host cannot render custom messages', () => {
        const acks: string[] = [];
        const handler = createSyncboardPushHandler({
            inject: undefined,
            ack: (_seq, messageId) => acks.push(messageId),
        });
        handler.accept(notification());

        expect(acks).toEqual([]);
    });

    it('bounds remembered ids so a long session cannot grow without limit', () => {
        const { handler } = harness();
        for (let i = 0; i < MAX_REMEMBERED_PUSH_IDS + 20; i += 1) {
            handler.accept(notification({ messageId: `m-${i}` }));
        }
        expect(handler.remembered()).toBe(MAX_REMEMBERED_PUSH_IDS);
    });
});
