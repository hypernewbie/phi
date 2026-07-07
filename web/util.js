/* Φ phi — pure, framework-free helpers (unit-tested in test-js/) */

// projectWorktreeLabel renders a short "project/worktree" label from a cwd.
// Pure: no DOM, no `this`. Handles mixed \\ and / separators, drops empty
// segments, and falls back to the em-dash sentinel for empty input.
export function projectWorktreeLabel(cwd) {
    if (!cwd) return '—';
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return '—';
    if (parts.length >= 2) {
        return parts[parts.length - 2] + '/' + parts[parts.length - 1];
    }
    return parts[parts.length - 1] || '—';
}
