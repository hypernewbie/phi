import { describe, it, expect } from 'vitest';
import { isUsableShell, findReusableShellTab } from '../web/diff.js';

const bash = (over = {}) => ({
    coder: 'bash',
    isDead: false,
    title: 'bash',
    paneId: 'p1',
    cwd: '/proj',
    ...over,
});

describe('isUsableShell', () => {
    it('accepts alive bash/pwsh tabs', () => {
        expect(isUsableShell(bash())).toBeTruthy();
        expect(isUsableShell(bash({ coder: 'pwsh' }))).toBeTruthy();
    });

    it('rejects nullish, dead, non-shell, and btop tabs', () => {
        expect(isUsableShell(null)).toBeFalsy();
        expect(isUsableShell(undefined)).toBeFalsy();
        expect(isUsableShell(bash({ isDead: true }))).toBeFalsy();
        expect(isUsableShell(bash({ coder: 'pi' }))).toBeFalsy();
        expect(isUsableShell(bash({ title: 'btop' }))).toBeFalsy();
        expect(isUsableShell(bash({ isBtop: true }))).toBeFalsy();
    });
});

describe('findReusableShellTab', () => {
    const opts = (over = {}) => ({
        useExistingTerminalTab: true,
        activeCWD: '/proj',
        ...over,
    });

    it('returns the active tab when it is itself a usable shell (highest precedence)', () => {
        const active = bash({ paneId: 'active' });
        const other = bash({ paneId: 'other', cwd: '/proj' });
        // even though `other` also matches, the active shell wins
        expect(findReusableShellTab([active, other], active, opts())).toBe(
            active,
        );
    });

    it('finds an alive shell matching activeCWD when active tab is not a shell', () => {
        const active = bash({ coder: 'pi' }); // not a shell
        const match = bash({ paneId: 'm', cwd: '/proj' });
        expect(findReusableShellTab([active, match], active, opts())).toBe(
            match,
        );
    });

    it('matches CWD via normalizeCwd (backslashes + trailing slash)', () => {
        const match = bash({ paneId: 'm', cwd: 'C:\\proj' });
        const found = findReusableShellTab(
            [match],
            null,
            opts({ activeCWD: 'C:/proj/' }),
        );
        expect(found).toBe(match);
    });

    it('does not reuse a shell from a different worktree/cwd', () => {
        const other = bash({ paneId: 'o', cwd: '/other' });
        expect(findReusableShellTab([other], null, opts())).toBeNull();
    });

    it('returns null when useExistingTerminalTab is off', () => {
        const match = bash({ cwd: '/proj' });
        expect(
            findReusableShellTab(
                [match],
                null,
                opts({ useExistingTerminalTab: false }),
            ),
        ).toBeNull();
    });

    it('returns null when activeCWD is empty', () => {
        const match = bash({ cwd: '/proj' });
        expect(
            findReusableShellTab([match], null, opts({ activeCWD: '' })),
        ).toBeNull();
    });

    it('ignores dead/btop tabs when matching', () => {
        const dead = bash({ isDead: true, cwd: '/proj' });
        const btop = bash({ title: 'btop', cwd: '/proj' });
        expect(findReusableShellTab([dead, btop], null, opts())).toBeNull();
    });

    it('accepts an iterable (Map.values) of tabs', () => {
        const match = bash({ paneId: 'm', cwd: '/proj' });
        const map = new Map([['m', match]]);
        expect(findReusableShellTab(map.values(), null, opts())).toBe(match);
    });
});
