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

// relativeToCwd converts a file path to one relative to cwd (both with \
// normalized to /). Pure. NOTE: two long-standing quirks are preserved by
// design — do NOT "fix" them here without a dedicated test + commit:
//   1. Case-sensitive prefix match (unlike normalizePath, which lowercases).
//   2. Naive startsWith: cwd '/foo' also matches path '/foobar' -> 'bar'.
// Also mirrors the original: a nullish `path` throws (no defensive guard).
export function relativeToCwd(path, cwd) {
    const cleanPath = path.replace(/\\/g, '/');
    const cleanCwd = (cwd || '').replace(/\\/g, '/');
    let relPath = cleanPath;
    if (cleanCwd && cleanPath.startsWith(cleanCwd)) {
        relPath = cleanPath.slice(cleanCwd.length);
        if (relPath.startsWith('/')) {
            relPath = relPath.slice(1);
        }
    }
    return relPath;
}

// escapeHtml escapes the five HTML-sensitive characters (attribute-safe) and
// returns '' for falsy input. Shared by kanban + sync, whose impls were
// byte-identical. NOTE: markdown.js `_escape` is intentionally NOT this
// function — it escapes only & < > (3 chars) for a <pre> text fallback.
export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
