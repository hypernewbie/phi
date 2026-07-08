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

// priorityMeta maps a Vikunja priority to its badge {label, className}. Pure.
// Priorities 1..5 -> Low/Medium/High/Urgent/DOOM; anything else falls back to
// the 'P0' label. className always uses the raw priority value (e.g.
// 'priority-6' for 6), matching the original renderCard behavior.
export function priorityMeta(priority) {
    const className = `priority-${priority}`;
    let label = 'P0';
    if (priority === 1) label = 'Low';
    else if (priority === 2) label = 'Medium';
    else if (priority === 3) label = 'High';
    else if (priority === 4) label = 'Urgent';
    else if (priority === 5) label = 'DOOM';
    return { label, className };
}

// isDoneBucket reports whether a Vikunja bucket represents "done". Pure and
// null-safe: returns false for a nullish bucket WITHOUT touching .title (the
// `bucket &&` short-circuit is load-bearing). Uses strict is_done === true.
export function isDoneBucket(bucket) {
    return !!(bucket && (bucket.is_done === true || bucket.title.toLowerCase() === 'done'));
}

// getLastFolderName returns the final path segment (splitting on / and \).
// Pure. QUIRK preserved: a trailing separator yields an empty last segment,
// so it falls back to returning the FULL original path.
export function getLastFolderName(path) {
    if (!path) return '';
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
}

// formatWorkspaceLabel renders a workspace's display label: normally the last
// folder name, but disambiguated as "folder (parent)" when another workspace
// in allWorkspaces shares the same last-folder name. Pure.
export function formatWorkspaceLabel(ws, allWorkspaces) {
    if (!ws) return '';
    const folderName = getLastFolderName(ws);
    if (!allWorkspaces || !Array.isArray(allWorkspaces)) return folderName;
    const duplicates = allWorkspaces.filter(w => getLastFolderName(w) === folderName);
    if (duplicates.length > 1) {
        const parts = ws.split(/[/\\]/);
        if (parts.length >= 2) {
            const parent = parts[parts.length - 2];
            return `${folderName} (${parent})`;
        }
    }
    return folderName;
}

// cpuLevel maps a CPU utilization percentage to a brand-logo indicator class.
// Pure. Thresholds: >90 critical, >70 high, >30 moderate, else idle.
export function cpuLevel(cpuPercent) {
    if (cpuPercent > 90) return 'cpu-critical';
    if (cpuPercent > 70) return 'cpu-high';
    if (cpuPercent > 30) return 'cpu-moderate';
    return 'cpu-idle';
}
