import { describe, expect, it } from 'vitest';
import { MAX_QUEUED_BYTES, MAX_QUEUED_MESSAGES } from './protocol.js';
import { BoundedQueue } from './queue.js';

const msg = (byteSize: number) => ({ byteSize });

describe('BoundedQueue', () => {
    it('holds 16 messages then overflows', () => {
        const q = new BoundedQueue();
        for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
            expect(q.tryEnqueue(msg(4))).toBe(true);
        }
        expect(q.tryEnqueue(msg(4))).toBe(false);
        expect(q.outstanding).toBe(MAX_QUEUED_MESSAGES);
    });
    it('counts in-flight bytes toward the byte bound', () => {
        const q = new BoundedQueue();
        expect(q.tryEnqueue(msg(4))).toBe(true);
        const head = q.beginSend();
        expect(head?.byteSize).toBe(4);
        expect(q.tryEnqueue(msg(MAX_QUEUED_BYTES))).toBe(false);
        q.endSend(head!);
        expect(q.tryEnqueue(msg(4))).toBe(true);
    });
    it('rejects one message larger than the whole queue', () => {
        const q = new BoundedQueue();
        expect(q.tryEnqueue(msg(MAX_QUEUED_BYTES + 1))).toBe(false);
        expect(q.outstanding).toBe(0);
    });
    it('releases capacity after send settles', () => {
        const q = new BoundedQueue();
        for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) q.tryEnqueue(msg(4));
        const head = q.beginSend();
        q.endSend(head!);
        expect(q.tryEnqueue(msg(4))).toBe(true);
    });
});
