// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderQueuePanel } from '../web/chat-pi/queue.js';

describe('Pi RPC queue panel', () => {
    it('renders ledger IDs, delivery/state data, and only valid actions', () => {
        const panel = document.createElement('div');
        const actions = {
            copy: vi.fn(),
            discard: vi.fn(),
            restore: vi.fn(),
        };
        renderQueuePanel(
            panel,
            [
                {
                    id: 'local-1',
                    message: 'local text',
                    delivery: 'prompt',
                    state: 'local',
                    attachments: [
                        {
                            ref: 'a'.repeat(64),
                            name: 'capture.png',
                            mimeType: 'image/png',
                            sizeBytes: 12,
                        },
                    ],
                },
                {
                    id: 'uncertain-1',
                    message: 'uncertain text',
                    delivery: 'steer',
                    state: 'uncertain',
                    error: 'acceptance uncertain',
                },
                {
                    id: 'accepted-1',
                    message: 'accepted text',
                    delivery: 'followUp',
                    state: 'accepted',
                },
            ],
            { steering: ['duplicate'], followUp: ['follow-up'] },
            actions,
        );

        const local = panel.querySelector('[data-queue-id="local-1"]');
        const uncertain = panel.querySelector('[data-queue-id="uncertain-1"]');
        const accepted = panel.querySelector('[data-queue-id="accepted-1"]');
        expect(local?.dataset.queueState).toBe('local');
        expect(local?.dataset.queueDelivery).toBe('prompt');
        expect(uncertain?.querySelector('.pi-queue-copy')).not.toBeNull();
        expect(uncertain?.querySelector('.pi-queue-discard')).not.toBeNull();
        expect(accepted?.querySelector('button')).toBeNull();
        expect(panel.querySelectorAll('.pi-queue-authoritative')).toHaveLength(
            2,
        );

        uncertain.querySelector('.pi-queue-copy').click();
        local.querySelector('.pi-queue-restore').click();
        local.querySelector('.pi-queue-discard').click();
        expect(actions.copy).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'uncertain-1' }),
        );
        expect(actions.restore).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'local-1',
                attachments: [expect.objectContaining({ name: 'capture.png' })],
            }),
        );
        expect(actions.discard).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'local-1' }),
        );
    });

    it('hides terminal consumed items when no authoritative rows remain', () => {
        const panel = document.createElement('div');
        renderQueuePanel(panel, [
            {
                id: 'consumed-1',
                message: 'already settled',
                delivery: 'prompt',
                state: 'consumed',
            },
        ]);
        expect(panel.querySelector('.pi-queue-item')).toBeNull();
        expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('keeps duplicate authoritative text as separate Pi-owned rows', () => {
        const panel = document.createElement('div');
        renderQueuePanel(panel, [], {
            steering: ['same', 'same'],
            followUp: ['same'],
        });
        expect(panel.querySelectorAll('.pi-queue-authoritative')).toHaveLength(
            3,
        );
        expect(
            [...panel.querySelectorAll('.pi-queue-authoritative')].map(
                (row) => row.textContent,
            ),
        ).toEqual(['Steer: same', 'Steer: same', 'Follow-up: same']);
    });
});
