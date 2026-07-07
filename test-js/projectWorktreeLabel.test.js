import { describe, it, expect } from 'vitest';
import { projectWorktreeLabel } from '../web/util.js';

// projectWorktreeLabel builds a short "parent/leaf" label from a cwd for tab
// display. Case-preserving; returns the em-dash sentinel for empty input.

describe('projectWorktreeLabel', () => {
    it('returns the em-dash sentinel for falsy input', () => {
        expect(projectWorktreeLabel('')).toBe('—');
        expect(projectWorktreeLabel(null)).toBe('—');
        expect(projectWorktreeLabel(undefined)).toBe('—');
    });

    it('returns the last two segments joined by /', () => {
        expect(projectWorktreeLabel('/home/user/project/worktree')).toBe('project/worktree');
        expect(projectWorktreeLabel('C:\\code\\github\\phi')).toBe('github/phi');
    });

    it('handles mixed separators', () => {
        expect(projectWorktreeLabel('C:\\code/github\\phi')).toBe('github/phi');
    });

    it('collapses trailing separators via empty-segment filtering', () => {
        expect(projectWorktreeLabel('/home/user/project/')).toBe('user/project');
    });

    it('returns the single segment when only one is present', () => {
        expect(projectWorktreeLabel('/only')).toBe('only');
        expect(projectWorktreeLabel('solo')).toBe('solo');
    });

    it('returns the em-dash sentinel when the path is all separators', () => {
        expect(projectWorktreeLabel('///')).toBe('—');
    });

    it('preserves case', () => {
        expect(projectWorktreeLabel('/Home/User/PROJECT')).toBe('User/PROJECT');
    });
});
