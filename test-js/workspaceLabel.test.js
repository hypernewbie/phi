import { describe, it, expect } from 'vitest';
import { getLastFolderName, formatWorkspaceLabel } from '../web/util.js';

describe('getLastFolderName', () => {
    it('returns empty string for falsy input', () => {
        expect(getLastFolderName('')).toBe('');
        expect(getLastFolderName(null)).toBe('');
    });

    it('returns the final segment for / and \\ separators', () => {
        expect(getLastFolderName('/home/user/project')).toBe('project');
        expect(getLastFolderName('C:\\code\\phi')).toBe('phi');
    });

    it('QUIRK: a trailing separator falls back to the full original path', () => {
        expect(getLastFolderName('/home/user/')).toBe('/home/user/');
    });

    it('returns the input when there is no separator', () => {
        expect(getLastFolderName('solo')).toBe('solo');
    });
});

describe('formatWorkspaceLabel', () => {
    it('returns empty string for falsy ws', () => {
        expect(formatWorkspaceLabel('', [])).toBe('');
    });

    it('returns the folder name when allWorkspaces is missing or not an array', () => {
        expect(formatWorkspaceLabel('/a/b/proj', null)).toBe('proj');
        expect(formatWorkspaceLabel('/a/b/proj', 'nope')).toBe('proj');
    });

    it('returns the plain folder name when it is unique', () => {
        expect(formatWorkspaceLabel('/a/b/proj', ['/a/b/proj', '/x/y/other'])).toBe('proj');
    });

    it('disambiguates duplicates with the parent folder', () => {
        const all = ['/work/alpha/proj', '/work/beta/proj'];
        expect(formatWorkspaceLabel('/work/alpha/proj', all)).toBe('proj (alpha)');
        expect(formatWorkspaceLabel('/work/beta/proj', all)).toBe('proj (beta)');
    });

    it('falls back to folder name if a duplicate has no parent segment', () => {
        // 'proj' appears twice, but ws itself has no parent (single segment)
        const all = ['proj', '/other/proj'];
        expect(formatWorkspaceLabel('proj', all)).toBe('proj');
    });

    it('handles Windows separators for duplicate disambiguation', () => {
        const all = ['C:\\work\\alpha\\proj', 'C:\\work\\beta\\proj'];
        expect(formatWorkspaceLabel('C:\\work\\alpha\\proj', all)).toBe('proj (alpha)');
    });
});
