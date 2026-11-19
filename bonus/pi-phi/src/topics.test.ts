import { describe, expect, it } from 'vitest';
import {
    SyncboardNotification,
    SyncboardTopicRetired,
} from './gen/bridge.js';
import {
    SYNCBOARD_TOPIC_CUSTOM_TYPE,
    activateSyncboardTopic,
    createSyncboardTopicHandler,
    freshSyncboardTopicState,
    retireSyncboardTopics,
} from './topics.js';

function note(
    seq: bigint,
    id: string,
    epoch: string,
    value: Buffer,
): SyncboardNotification {
    return SyncboardNotification.create({
        seq,
        messageId: id,
        topic: 'topic',
        coordinatorEpoch: epoch,
        value,
    });
}

describe('Syncboard topic binding', () => {
    it('activates only monotonic, non-retired bindings', () => {
        const state = freshSyncboardTopicState();
        expect(activateSyncboardTopic(state, 'e1', 1n)).toBe(true);
        expect(activateSyncboardTopic(state, 'e1', 1n)).toBe(true);
        expect(activateSyncboardTopic(state, 'e2', 1n)).toBe(false);
        expect(activateSyncboardTopic(state, 'e1', 0n)).toBe(false);
        retireSyncboardTopics(
            state,
            SyncboardTopicRetired.create({ throughBindingSeq: 2n }),
        );
        expect(activateSyncboardTopic(state, 'e1', 2n)).toBe(false);
        expect(activateSyncboardTopic(state, 'e3', 3n)).toBe(true);
    });

    it('injects the complete text, acks after admission, and does not inject a duplicate', () => {
        const state = freshSyncboardTopicState();
        activateSyncboardTopic(state, 'e1', 1n);
        const injected: Array<[string, string]> = [];
        const acks: Array<[bigint, string, string]> = [];
        const handler = createSyncboardTopicHandler({
            state,
            inject: (type, text) => injected.push([type, text]),
            ack: (seq, id, epoch) => acks.push([seq, id, epoch]),
        });
        const value = Buffer.from(
            `{"topic":"topic","posts":[{"value":"${'ü'.repeat(20_000)}"}]}`,
        );
        const first = note(1n, 'batch-1', 'e1', value);
        handler.accept(first);
        expect(injected).toHaveLength(1);
        expect(injected[0]?.[0]).toBe(SYNCBOARD_TOPIC_CUSTOM_TYPE);
        expect(injected[0]?.[1]).toBe(value.toString('utf8'));
        expect(injected[0]?.[1]?.length).toBeGreaterThan(8 * 1024);
        expect(acks).toEqual([[1n, 'batch-1', 'e1']]);

        handler.accept(first);
        expect(injected).toHaveLength(1);
        expect(acks).toHaveLength(2);
    });

    it('holds a delivery until the subscribe result activates the binding', () => {
        const state = freshSyncboardTopicState();
        const injected: string[] = [];
        const acks: Array<[bigint, string, string]> = [];
        const handler = createSyncboardTopicHandler({
            state,
            inject: (_type, text) => injected.push(text),
            ack: (seq, id, epoch) => acks.push([seq, id, epoch]),
        });
        const pending = note(
            1n,
            'batch-before-result',
            'e1',
            Buffer.from('complete value'),
        );
        handler.accept(pending);
        expect(injected).toEqual([]);
        expect(acks).toEqual([]);

        expect(activateSyncboardTopic(state, 'e1', 1n)).toBe(true);
        handler.accept(pending);
        expect(injected).toEqual(['complete value']);
        expect(acks).toEqual([[1n, 'batch-before-result', 'e1']]);
    });

    it('does not ack a refused host admission', () => {
        const state = freshSyncboardTopicState();
        activateSyncboardTopic(state, 'e1', 1n);
        const acks: Array<[bigint, string, string]> = [];
        const handler = createSyncboardTopicHandler({
            state,
            inject: () => {
                throw new Error('refused');
            },
            ack: (seq, id, epoch) => acks.push([seq, id, epoch]),
        });
        handler.accept(note(1n, 'batch-1', 'e1', Buffer.from('x')));
        expect(acks).toEqual([]);
    });

    it('drops a late batch after the cumulative retirement marker', () => {
        const state = freshSyncboardTopicState();
        activateSyncboardTopic(state, 'e1', 4n);
        retireSyncboardTopics(
            state,
            SyncboardTopicRetired.create({ throughBindingSeq: 4n }),
        );
        const injected: string[] = [];
        const handler = createSyncboardTopicHandler({
            state,
            inject: (_type, text) => injected.push(text),
            ack: () => {},
        });
        handler.accept(note(1n, 'late', 'e1', Buffer.from('late')));
        expect(injected).toEqual([]);
    });
});

describe('Syncboard topic epoch dedupe', () => {
    it('does not treat a reused batch id as a duplicate across an epoch change', () => {
        const state = freshSyncboardTopicState();
        activateSyncboardTopic(state, 'e1', 1n);
        const injected: string[] = [];
        const acks: Array<[bigint, string, string]> = [];
        const handler = createSyncboardTopicHandler({
            state,
            inject: (_type, content) => injected.push(content),
            ack: (seq, id, epoch) => acks.push([seq, id, epoch]),
        });
        handler.accept(
            note(1n, 'batch-1', 'e1', Buffer.from('old')),
        );
        activateSyncboardTopic(state, 'e2', 2n);
        handler.accept(
            note(1n, 'batch-1', 'e2', Buffer.from('new')),
        );
        expect(injected).toEqual(['old', 'new']);
        expect(acks).toHaveLength(2);
    });
});
