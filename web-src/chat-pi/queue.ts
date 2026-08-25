export type QueueDelivery = 'prompt' | 'steer' | 'followUp';

export type QueueItemState =
    | 'local'
    | 'sending'
    | 'accepted'
    | 'uncertain'
    | 'consumed'
    | 'cancelled'
    | 'promoted';

export interface QueueAttachment {
    ref: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
}

/** Browser-visible projection of one Phi-owned queue ledger item. */
export interface QueueItem {
    id: string;
    message: string;
    delivery: QueueDelivery;
    state: QueueItemState;
    error?: string;
    createdAt?: number;
    sid?: string;
    sessionEpoch?: string;
    attachments?: QueueAttachment[];
}

export interface QueueAuthoritative {
    steering: readonly string[];
    followUp: readonly string[];
}

export interface QueueActions {
    copy?: (item: QueueItem) => void;
    discard?: (item: QueueItem) => void;
    restore?: (item: QueueItem) => void;
}

export function renderQueuePanel(
    panel: HTMLElement,
    items: readonly QueueItem[],
    authoritative: QueueAuthoritative = { steering: [], followUp: [] },
    actions: QueueActions = {},
): void {
    panel.replaceChildren();
    const visible = items.filter(
        (item) => item.state !== 'cancelled' && item.state !== 'consumed',
    );
    if (
        visible.length === 0 &&
        authoritative.steering.length === 0 &&
        authoritative.followUp.length === 0
    ) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');

    for (const item of visible) {
        const row = document.createElement('div');
        row.className = 'pi-queue-item';
        row.dataset.queueId = item.id;
        row.dataset.queueState = item.state;
        row.dataset.queueDelivery = item.delivery;
        const text = document.createElement('span');
        text.className = 'pi-queue-text';
        text.textContent = item.message;
        row.appendChild(text);
        if (item.error) {
            const error = document.createElement('span');
            error.className = 'pi-queue-error';
            error.textContent = item.error;
            row.appendChild(error);
        }
        if (item.state === 'local' && actions.restore) {
            const restore = document.createElement('button');
            restore.className = 'pi-queue-restore';
            restore.type = 'button';
            restore.setAttribute(
                'aria-label',
                'Restore queued message to composer',
            );
            restore.textContent = 'Restore';
            restore.addEventListener('click', () => actions.restore?.(item));
            row.appendChild(restore);
        }
        if (
            (item.state === 'local' || item.state === 'uncertain') &&
            actions.discard
        ) {
            const discard = document.createElement('button');
            discard.className = 'pi-queue-discard';
            discard.type = 'button';
            discard.setAttribute('aria-label', 'Discard queued message');
            discard.textContent = 'Discard';
            discard.addEventListener('click', () => actions.discard?.(item));
            row.appendChild(discard);
        }
        if (item.state === 'uncertain' && actions.copy) {
            const copy = document.createElement('button');
            copy.className = 'pi-queue-copy';
            copy.type = 'button';
            copy.setAttribute(
                'aria-label',
                'Copy uncertain message to composer',
            );
            copy.textContent = 'Copy to composer';
            copy.addEventListener('click', () => actions.copy?.(item));
            row.appendChild(copy);
        }
        panel.appendChild(row);
    }

    for (const [delivery, messages] of [
        ['steer', authoritative.steering],
        ['followUp', authoritative.followUp],
    ] as const) {
        for (const message of messages) {
            const row = document.createElement('div');
            row.className = 'pi-queue-authoritative';
            row.dataset.queueDelivery = delivery;
            row.textContent = `${
                delivery === 'followUp' ? 'Follow-up' : 'Steer'
            }: ${message}`;
            panel.appendChild(row);
        }
    }
}
