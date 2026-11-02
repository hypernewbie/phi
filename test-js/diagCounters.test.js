// @vitest-environment node
/**
 * The diagnostics panel's growth rule, tested without a DOM.
 *
 * The invariant that matters: a counter the server did not send reads as a
 * placeholder, never as a measurement, and the first sample of a counter sets
 * the baseline rather than reporting growth against zero. Both failures would
 * show a reader a number that means the opposite of what it says.
 */
import { describe, expect, it } from 'vitest';
import {
    createDeltaTracker,
    PAGE_COUNTERS,
    PROCESS_COUNTERS,
    renderCounterRows,
    TERMINAL_COUNTERS,
} from '../web/diag-counters.js';

const spec = (key, unit = 'count', noun) => ({ label: key, key, unit, noun });

describe('renderCounterRows', () => {
    it('renders a placeholder for a counter the server did not send', () => {
        // An older server has no mem_sys_mb: showing "0.0 MB" would claim a
        // measurement the server never made.
        const html = renderCounterRows(
            [spec('mem_sys_mb', 'MB')],
            {},
            createDeltaTracker(),
        );
        expect(html).toContain('>—<');
        expect(html).not.toContain('0.0 MB');
    });

    it('treats non-numeric payload values as absent', () => {
        const tracker = createDeltaTracker();
        for (const value of [null, '12', Number.NaN, {}]) {
            const html = renderCounterRows(
                [spec('mem_sys_mb', 'MB')],
                { mem_sys_mb: value },
                tracker,
            );
            expect(html).toContain('>—<');
        }
    });

    it('formats bytes by magnitude', () => {
        const tracker = createDeltaTracker();
        const render = (value) =>
            renderCounterRows(
                [spec('ring_bytes_total', 'bytes')],
                { ring_bytes_total: value },
                tracker,
            );
        expect(render(512)).toContain('512 B');
        expect(render(2048)).toContain('2 KB');
        expect(render(5 * 1024 * 1024)).toContain('5.0 MB');
    });

    it('escapes the label', () => {
        const html = renderCounterRows(
            [{ label: '<img src=x>', key: 'k', unit: 'count' }],
            { k: 1 },
            createDeltaTracker(),
        );
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
});

describe('createDeltaTracker', () => {
    it('sets the baseline on the first sample and reports the change after', () => {
        const tracker = createDeltaTracker();
        const heap = spec('heap_objects', 'count', 'objects');
        expect(tracker.cell(heap, 1000)).toBe('');
        expect(tracker.cell(heap, 1500)).toContain('+500 objects');
        expect(tracker.cell(heap, 400)).toContain('-600 objects');
    });

    it('reports against the opening baseline, not the previous sample', () => {
        const tracker = createDeltaTracker();
        const heap = spec('heap_objects', 'count', 'objects');
        tracker.cell(heap, 1000);
        tracker.cell(heap, 1100);
        // Third sample compares with 1000, so a steady climb accumulates.
        expect(tracker.cell(heap, 1200)).toContain('+200 objects');
    });

    it('ignores movement below the display threshold', () => {
        const tracker = createDeltaTracker();
        expect(tracker.cell(spec('mem_alloc_mb', 'MB'), 10)).toBe('');
        // Under 0.1 MB is rounding noise, not growth.
        expect(tracker.cell(spec('mem_alloc_mb', 'MB'), 10.04)).toBe('');
        expect(tracker.cell(spec('mem_alloc_mb', 'MB'), 10.5)).toContain(
            '+0.5 MB',
        );
    });

    it('keeps counters independent', () => {
        const tracker = createDeltaTracker();
        const a = spec('a');
        const b = spec('b');
        tracker.cell(a, 10);
        tracker.cell(b, 10);
        expect(tracker.cell(a, 20)).toContain('+10');
        expect(tracker.cell(b, 10)).toBe('');
    });

    it('keeps the opening baseline across a missing sample', () => {
        const tracker = createDeltaTracker();
        const heap = spec('heap_objects', 'count', 'objects');
        tracker.cell(heap, 1000);
        // A missing counter renders no cell and does not reset the baseline:
        // the panel's contract is change since it opened.
        expect(tracker.cell(heap, undefined)).toBe('');
        expect(tracker.cell(heap, 1500)).toContain('+500 objects');
    });
});

describe('counter groups', () => {
    it('cover every field the panel reports exactly once', () => {
        const keys = [
            ...PROCESS_COUNTERS,
            ...TERMINAL_COUNTERS,
            ...PAGE_COUNTERS,
        ].map((counter) => counter.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual(
            expect.arrayContaining([
                'mem_alloc_mb',
                'heap_objects',
                'pty_count',
                'ring_bytes_total',
                'ws_clients_total',
                'js_heap_mb',
                'dom_nodes',
            ]),
        );
    });
});
