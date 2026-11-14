// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:17170/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

setupDomHarness();
let manager;
afterEach(() => {
    clearInterval(manager?.pollInterval);
    vi.useRealTimers();
});

function newManager() {
    document.body.innerHTML = '<div id="sync-panel"></div>';
    mockFetch(() => []);
    vi.spyOn(SyncManager.prototype, 'startPolling').mockImplementationOnce(
        () => {},
    );
    manager = new SyncManager({
        sessionsManager: { config: {} },
        showToast: vi.fn(),
    });
    return manager;
}

const push = (over = {}) => ({
    message_id: 'm-1',
    sender: 'laptop-a',
    recipient: 'pane-b',
    value: 'hello',
    updated_at_unix_ms: 1_700_000_000_000,
    ...over,
});

// The cache is painted before any request, so the rendered cards prove which
// payload the parser accepted.
function rendered(payload) {
    newManager();
    manager.restorePushes({
        responses: new Map([['/api/sync/pushes', JSON.stringify(payload)]]),
    });
    return [...manager.pushList.children].map((card) => card.dataset.messageId);
}

describe('addressed message payload', () => {
    it('renders a well-formed list', () => {
        expect(rendered([push(), push({ message_id: 'm-2' })])).toHaveLength(2);
    });

    it('rejects the whole list when one entry is unusable', () => {
        expect(rendered([push(), push({ message_id: '' })])).toEqual([]);
        expect(rendered([push(), { noise: true }])).toEqual([]);
    });

    it('rejects a payload that is not a list', () => {
        expect(rendered({ messages: [push()] })).toEqual([]);
        expect(rendered(null)).toEqual([]);
    });

    const rejected = {
        'an empty message_id': [push({ message_id: '' })],
        'a non-string message_id': [push({ message_id: 7 })],
        'a message_id over 128 characters': [
            push({ message_id: 'x'.repeat(129) }),
        ],
        'a sender over 128 characters': [push({ sender: 'x'.repeat(129) })],
        'a recipient over 128 characters': [
            push({ recipient: 'x'.repeat(129) }),
        ],
        'a value over 4096 characters': [push({ value: 'x'.repeat(4097) })],
        'a non-string value': [push({ value: 7 })],
        'a missing timestamp': [push({ updated_at_unix_ms: undefined })],
        'a string timestamp': [push({ updated_at_unix_ms: '5' })],
        'a null timestamp': [push({ updated_at_unix_ms: null })],
        'a non-boolean truncated': [push({ truncated: 'yes' })],
        'a null entry': [null],
        'an array entry': [[]],
    };
    for (const [name, payload] of Object.entries(rejected)) {
        it(`rejects ${name}`, () => {
            expect(rendered(payload)).toEqual([]);
        });
    }

    it('accepts the documented boundary lengths', () => {
        expect(
            rendered([
                push({
                    message_id: 'x'.repeat(128),
                    sender: 'x'.repeat(128),
                    recipient: 'x'.repeat(128),
                    value: 'x'.repeat(4096),
                    truncated: true,
                }),
            ]),
        ).toHaveLength(1);
    });

    it('accepts an explicit false or absent truncated flag', () => {
        expect(
            rendered([push({ truncated: false }), push({ message_id: 'm-3' })]),
        ).toHaveLength(2);
    });

    it('rejects more than 100 entries', () => {
        const many = Array.from({ length: 101 }, (_, index) =>
            push({ message_id: `m-${index}` }),
        );
        expect(rendered(many)).toEqual([]);
        const hundred = many.slice(0, 100);
        expect(rendered(hundred)).toHaveLength(100);
    });
});
