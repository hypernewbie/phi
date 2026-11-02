/**
 * Counter rows for the diagnostics panel.
 *
 * Split out of markdown.ts so the growth rule is testable without a DOM. The
 * rules that matter: a counter the server did not send shows "—" instead of a
 * false zero (older servers predate the memory fields), the first sample of a
 * counter sets its baseline, and later samples report the change since then.
 */
import { escapeHtml } from './util.js';

export type CounterUnit = 'MB' | 'bytes' | 'count';

export interface CounterSpec {
    label: string;
    key: string;
    unit: CounterUnit;
    /** Noun for the growth cell, e.g. "objects". Counts only. */
    noun?: string;
}

const MIB = 1024 * 1024;

const formatValue: Record<CounterUnit, (value: number) => string> = {
    MB: (value) => `${value.toFixed(1)} MB`,
    bytes: (value) =>
        value >= MIB
            ? `${(value / MIB).toFixed(1)} MB`
            : value >= 1024
              ? `${Math.round(value / 1024)} KB`
              : `${Math.round(value)} B`,
    count: (value) => String(Math.round(value)),
};

/** Below these, a change is display rounding, not growth. */
const thresholds: Record<CounterUnit, number> = {
    MB: 0.1,
    bytes: 1024,
    count: 1,
};

export const PROCESS_COUNTERS: CounterSpec[] = [
    { label: 'Go heap alloc', key: 'mem_alloc_mb', unit: 'MB' },
    { label: 'Heap in use', key: 'mem_heap_inuse_mb', unit: 'MB' },
    { label: 'Reserved (sys)', key: 'mem_sys_mb', unit: 'MB' },
    { label: 'Goroutine stacks', key: 'mem_stack_mb', unit: 'MB' },
    {
        label: 'Live heap objects',
        key: 'heap_objects',
        unit: 'count',
        noun: 'objects',
    },
    {
        label: 'Goroutines',
        key: 'goroutines',
        unit: 'count',
        noun: 'goroutines',
    },
    { label: 'GC cycles', key: 'num_gc', unit: 'count', noun: 'cycles' },
];

export const TERMINAL_COUNTERS: CounterSpec[] = [
    { label: 'PTYs', key: 'pty_count', unit: 'count', noun: 'PTYs' },
    { label: 'Scrollback used', key: 'ring_bytes_total', unit: 'bytes' },
    {
        label: 'Scrollback capacity',
        key: 'ring_capacity_total',
        unit: 'bytes',
    },
    {
        label: 'WS clients',
        key: 'ws_clients_total',
        unit: 'count',
        noun: 'clients',
    },
];

export const PAGE_COUNTERS: CounterSpec[] = [
    { label: 'JS heap', key: 'js_heap_mb', unit: 'MB' },
    { label: 'DOM nodes', key: 'dom_nodes', unit: 'count', noun: 'nodes' },
];

export interface DeltaTracker {
    /** The growth cell for one counter, or '' when it has not moved. */
    cell(spec: CounterSpec, value: number | undefined): string;
}

export function createDeltaTracker(): DeltaTracker {
    const baseline = new Map<string, number>();
    return {
        cell(spec, value) {
            if (value === undefined) return '';
            const base = baseline.get(spec.key);
            if (base === undefined) {
                baseline.set(spec.key, value);
                return '';
            }
            const diff = value - base;
            if (Math.abs(diff) < thresholds[spec.unit]) return '';
            const sign = diff > 0 ? '+' : '';
            const amount =
                spec.unit === 'count' && spec.noun
                    ? `${Math.round(diff)} ${spec.noun}`
                    : formatValue[spec.unit](diff);
            return `<span class="diag-delta">${sign}${escapeHtml(amount)}</span>`;
        },
    };
}

/**
 * One table body for a counter group. A value the server did not send renders
 * as a placeholder: /api/diag is additive, so an older server legitimately
 * lacks the memory fields, and "0.0 MB" would read as a real measurement.
 */
export function renderCounterRows(
    specs: CounterSpec[],
    values: Record<string, unknown>,
    tracker: DeltaTracker,
): string {
    return specs
        .map((spec) => {
            const raw = values[spec.key];
            const value =
                typeof raw === 'number' && Number.isFinite(raw)
                    ? raw
                    : undefined;
            const shown =
                value === undefined ? '—' : formatValue[spec.unit](value);
            return `<tr><td>${escapeHtml(spec.label)}</td><td>${escapeHtml(shown)}${tracker.cell(spec, value)}</td></tr>`;
        })
        .join('');
}
