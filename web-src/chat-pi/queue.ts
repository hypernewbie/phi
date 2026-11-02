import type { WireQueueDelivery, WireQueueItem } from './control-wire.js';

export type QueueDelivery = WireQueueDelivery;

/** Ledger states shared with pkg/rpc/queue.go. */
export type QueueItemState =
    | 'local'
    | 'sending'
    | 'accepted'
    | 'uncertain'
    | 'consumed'
    | 'cancelled'
    | 'promoted';

/** Browser view of one Phi-owned queue ledger item. */
export type QueueItem = WireQueueItem;

export interface QueueActions {
    copy?: (item: QueueItem) => void;
    discard?: (item: QueueItem) => void;
    restore?: (item: QueueItem) => void;
}

export function renderQueuePanel(
    panel: HTMLElement,
    items: readonly QueueItem[],
    actions: QueueActions = {},
): void {
    panel.replaceChildren();
    const visible = items.filter(
        (item) => item.state !== 'cancelled' && item.state !== 'consumed',
    );
    if (visible.length === 0) {
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
        // Pi labels queued text by delivery mode ("Steering:", "Follow-up:").
        // A plain prompt row has no label because it is the turn itself.
        if (item.delivery !== 'prompt') {
            const label = document.createElement('span');
            label.className = 'pi-queue-label';
            label.textContent =
                item.delivery === 'followUp' ? 'Follow-up:' : 'Steering:';
            row.appendChild(label);
        }
        row.appendChild(text);
        if (item.state === 'uncertain') {
            const state = document.createElement('span');
            state.className = 'pi-queue-state';
            state.textContent = 'unconfirmed';
            row.appendChild(state);
        }
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
            restore.textContent = 'Edit';
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
            copy.textContent = 'Copy';
            copy.addEventListener('click', () => actions.copy?.(item));
            row.appendChild(copy);
        }
        panel.appendChild(row);
    }
}
