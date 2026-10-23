// Bounded outbound queue: at most 16 messages and 256 KiB per peer.
// The bound covers queued plus in-flight bytes, mirroring the Go peer.

import { MAX_QUEUED_BYTES, MAX_QUEUED_MESSAGES } from './protocol.js';

export interface SizedMessage {
    /** Encoded byte size used for the byte bound. */
    readonly byteSize: number;
}

/** Overflow-safe FIFO with count and byte accounting. */
export class BoundedQueue<T extends SizedMessage> {
    private items: T[] = [];
    private bytes = 0;
    private inFlight = 0;
    private inFlightBytes = 0;

    get length(): number {
        return this.items.length;
    }

    get queuedBytes(): number {
        return this.bytes;
    }

    get outstanding(): number {
        return this.items.length + this.inFlight;
    }

    get outstandingBytes(): number {
        return this.bytes + this.inFlightBytes;
    }

    /** Try to enqueue. Returns false on overflow without mutating. */
    tryEnqueue(msg: T): boolean {
        return this.tryEnqueueWithByteCap(msg, MAX_QUEUED_BYTES);
    }

    /**
     * Try to enqueue under a tighter byte cap. History responses use
     * this so an admitted frame always leaves lifecycle headroom.
     * Returns false on overflow without mutating.
     */
    tryEnqueueWithByteCap(
        msg: T,
        capBytes: number,
        capMessages = MAX_QUEUED_MESSAGES,
    ): boolean {
        if (this.outstanding >= capMessages) return false;
        if (this.outstandingBytes + msg.byteSize > capBytes) return false;
        this.items.push(msg);
        this.bytes += msg.byteSize;
        return true;
    }

    /** Mark the head as in-flight and return it, or undefined when empty. */
    beginSend(): T | undefined {
        const msg = this.items.shift();
        if (msg === undefined) return undefined;
        this.bytes -= msg.byteSize;
        this.inFlight += 1;
        this.inFlightBytes += msg.byteSize;
        return msg;
    }

    /** Release one in-flight message after its send settles. */
    endSend(msg: T): void {
        this.inFlight -= 1;
        this.inFlightBytes -= msg.byteSize;
        if (this.inFlight < 0) this.inFlight = 0;
        if (this.inFlightBytes < 0) this.inFlightBytes = 0;
    }

    clear(): void {
        this.items = [];
        this.bytes = 0;
        this.inFlight = 0;
        this.inFlightBytes = 0;
    }
}
