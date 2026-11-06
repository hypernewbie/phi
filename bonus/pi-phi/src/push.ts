import type { SyncboardNotification } from './gen/bridge.js';

/**
 * Custom entry type for a pushed Syncboard message. The host renders it, so the
 * human sees the same text the model receives.
 */
export const SYNCBOARD_PUSH_CUSTOM_TYPE = 'phi-syncboard';

/** Value bytes kept in the injected text; the rest is summarized, not dropped. */
export const MAX_SYNCBOARD_PUSH_INJECT_BYTES = 8 * 1024;

/**
 * How many message ids this runtime remembers for deduplication. Phi resends an
 * unacknowledged notification after a reconnect, so a repeat is normal and must
 * not inject twice.
 */
export const MAX_REMEMBERED_PUSH_IDS = 256;

export interface SyncboardPushState {
    readonly seen: Set<string>;
}

export function freshSyncboardPushState(): SyncboardPushState {
    return { seen: new Set() };
}

export interface SyncboardPushOptions {
    /** Process-owned so a reload cannot repeat an injected, unacknowledged turn. */
    readonly state?: SyncboardPushState;
    /**
     * Injects text into the host session. Throws when the host refuses, which
     * suppresses the acknowledgement so Phi resends rather than losing the
     * message.
     */
    readonly inject:
        | ((customType: string, content: string) => void)
        | undefined;
    /** Confirms one notification to Phi. */
    readonly ack: (seq: bigint, messageId: string) => void;
}

export interface SyncboardPushHandler {
    /** Handles one notification. Never throws. */
    accept(notification: SyncboardNotification): void;
    /** Number of remembered message ids, for tests. */
    remembered(): number;
}

/**
 * Rebuild the one-line header and bounded body for injection. Truncation is
 * stated in the text so the model never treats a partial message as complete.
 */
export function formatPushContent(notification: SyncboardNotification): string {
    const value = notification.value ?? new Uint8Array();
    const total = value.byteLength;
    const kept =
        total > MAX_SYNCBOARD_PUSH_INJECT_BYTES
            ? value.subarray(0, MAX_SYNCBOARD_PUSH_INJECT_BYTES)
            : value;
    const text = new TextDecoder('utf-8').decode(kept, {
        stream: total > MAX_SYNCBOARD_PUSH_INJECT_BYTES,
    });
    const sender = notification.sender || 'unknown';
    const header = `[phi-syncboard from=${sender} to=${notification.recipient} message_id=${notification.messageId}]`;
    if (total <= MAX_SYNCBOARD_PUSH_INJECT_BYTES) {
        return `${header}\n${text}`;
    }
    return `${header}\n${text}\n[truncated: first ${MAX_SYNCBOARD_PUSH_INJECT_BYTES} of ${total} bytes]`;
}

/**
 * Turn one addressed message into a host message. A repeated message_id is
 * acknowledged but not injected again; a host failure is not acknowledged, so
 * the sender keeps it pending and retries.
 */
export function createSyncboardPushHandler(
    options: SyncboardPushOptions,
): SyncboardPushHandler {
    const { seen } = options.state ?? freshSyncboardPushState();
    const remember = (messageId: string): void => {
        seen.add(messageId);
        if (seen.size > MAX_REMEMBERED_PUSH_IDS) {
            const oldest = seen.values().next().value;
            if (oldest !== undefined) seen.delete(oldest);
        }
    };

    return {
        accept(notification: SyncboardNotification): void {
            const messageId = notification.messageId;
            const seq = notification.seq ?? 0n;
            // Without an id there is no way to dedupe a resend, so a message
            // that carries none is refused rather than risking a double turn.
            if (!messageId) return;
            if (seen.has(messageId)) {
                options.ack(seq, messageId);
                return;
            }
            const inject = options.inject;
            if (inject === undefined) return;
            try {
                inject(
                    SYNCBOARD_PUSH_CUSTOM_TYPE,
                    formatPushContent(notification),
                );
            } catch {
                // Not acknowledged: the message stays pending on the Phi side.
                return;
            }
            remember(messageId);
            options.ack(seq, messageId);
        },
        remembered(): number {
            return seen.size;
        },
    };
}
