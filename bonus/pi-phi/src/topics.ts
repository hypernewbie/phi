import type {
    SyncboardNotification,
    SyncboardTopicRetired,
} from './gen/bridge.js';

/** Custom entry type for one topic batch. The host renders and models this. */
export const SYNCBOARD_TOPIC_CUSTOM_TYPE = 'phi-syncboard-topic';

/** Bound on remembered batch ids for duplicate replay suppression. */
export const MAX_REMEMBERED_TOPIC_IDS = 1024;

export interface SyncboardTopicState {
    activeEpoch: string;
    highestBinding: bigint;
    retiredThrough: bigint;
    lastSeq: bigint;
    readonly seen: Set<string>;
}

export function freshSyncboardTopicState(): SyncboardTopicState {
    return {
        activeEpoch: '',
        highestBinding: 0n,
        retiredThrough: 0n,
        lastSeq: 0n,
        seen: new Set(),
    };
}

export function activateSyncboardTopic(
    state: SyncboardTopicState,
    epoch: string,
    binding: bigint,
): boolean {
    if (!epoch || binding <= 0n || binding <= state.retiredThrough)
        return false;
    if (binding < state.highestBinding) return false;
    if (binding === state.highestBinding && epoch !== state.activeEpoch)
        return false;
    if (epoch !== state.activeEpoch) {
        state.lastSeq = 0n;
        state.seen.clear();
    }
    state.activeEpoch = epoch;
    state.highestBinding = binding;
    return true;
}

export function retireSyncboardTopics(
    state: SyncboardTopicState,
    marker: SyncboardTopicRetired,
): void {
    const through = marker.throughBindingSeq ?? 0n;
    if (through > state.retiredThrough) state.retiredThrough = through;
    if (state.highestBinding <= state.retiredThrough) {
        state.activeEpoch = '';
    }
}

export interface SyncboardTopicHandlerOptions {
    readonly state: SyncboardTopicState;
    readonly inject:
        | ((customType: string, content: string) => void)
        | undefined;
    readonly ack: (seq: bigint, messageId: string, epoch: string) => void;
}

export interface SyncboardTopicHandler {
    accept(notification: SyncboardNotification): void;
}

/**
 * Inject one complete batch. The exact stored text is the model-visible
 * content: no header, truncation, or reformatting. A duplicate is acked
 * without a second injection; a host refusal is not acked.
 */
export function createSyncboardTopicHandler(
    options: SyncboardTopicHandlerOptions,
): SyncboardTopicHandler {
    const { state } = options;
    const remember = (id: string): void => {
        state.seen.add(id);
        if (state.seen.size > MAX_REMEMBERED_TOPIC_IDS) {
            const oldest = state.seen.values().next().value;
            if (oldest !== undefined) state.seen.delete(oldest);
        }
    };
    return {
        accept(notification: SyncboardNotification): void {
            const id = notification.messageId;
            const epoch = notification.coordinatorEpoch;
            const seq = notification.seq ?? 0n;
            if (!id || !notification.topic || !epoch) return;
            if (state.seen.has(id)) {
                options.ack(seq, id, epoch);
                return;
            }
            if (!state.activeEpoch || epoch !== state.activeEpoch) return;
            if (state.highestBinding <= state.retiredThrough) return;
            if (seq <= state.lastSeq) {
                remember(id);
                options.ack(seq, id, epoch);
                return;
            }
            const inject = options.inject;
            if (inject === undefined) return;
            let content: string;
            try {
                content = new TextDecoder('utf-8', { fatal: true }).decode(
                    notification.value ?? new Uint8Array(),
                );
            } catch {
                return;
            }
            try {
                inject(SYNCBOARD_TOPIC_CUSTOM_TYPE, content);
            } catch {
                return;
            }
            state.lastSeq = seq;
            remember(id);
            options.ack(seq, id, epoch);
        },
    };
}
