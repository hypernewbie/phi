import { describe, it, expect } from 'vitest';
import { priorityMeta, isDoneBucket } from '../web/util.js';

describe('priorityMeta', () => {
    it('maps priorities 1..5 to labels', () => {
        expect(priorityMeta(1)).toEqual({
            label: 'Low',
            className: 'priority-1',
        });
        expect(priorityMeta(2)).toEqual({
            label: 'Medium',
            className: 'priority-2',
        });
        expect(priorityMeta(3)).toEqual({
            label: 'High',
            className: 'priority-3',
        });
        expect(priorityMeta(4)).toEqual({
            label: 'Urgent',
            className: 'priority-4',
        });
        expect(priorityMeta(5)).toEqual({
            label: 'DOOM',
            className: 'priority-5',
        });
    });

    it('falls back to P0 label for out-of-range priorities, keeping raw className', () => {
        expect(priorityMeta(6)).toEqual({
            label: 'P0',
            className: 'priority-6',
        });
        expect(priorityMeta(0)).toEqual({
            label: 'P0',
            className: 'priority-0',
        });
    });
});

describe('isDoneBucket', () => {
    it('is null-safe and returns false for nullish bucket', () => {
        expect(isDoneBucket(null)).toBe(false);
        expect(isDoneBucket(undefined)).toBe(false);
    });

    it('returns true when is_done is strictly true', () => {
        expect(isDoneBucket({ is_done: true, title: 'Whatever' })).toBe(true);
    });

    it('does not treat truthy-but-not-true is_done as done', () => {
        expect(isDoneBucket({ is_done: 1, title: 'Backlog' })).toBe(false);
        expect(isDoneBucket({ is_done: 'yes', title: 'Backlog' })).toBe(false);
    });

    it('matches a title of "done" case-insensitively', () => {
        expect(isDoneBucket({ title: 'Done' })).toBe(true);
        expect(isDoneBucket({ title: 'DONE' })).toBe(true);
        expect(isDoneBucket({ is_done: false, title: 'done' })).toBe(true);
    });

    it('returns false for non-done buckets', () => {
        expect(isDoneBucket({ is_done: false, title: 'In Progress' })).toBe(
            false,
        );
    });
});
