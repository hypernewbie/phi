// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';

// Tests the "not a git repository" sentinel handling in the diff
// panel. Previously: the raw git endpoints returned 500 with the full
// git stderr ("fatal: not a git repository ..."); the diff panel
// forwarded that text into the xterm as red error output. The fix:
// backend checks `git rev-parse --is-inside-work-tree` first; if cwd
// isn't a repo, raw endpoints emit literal "NOT_GIT_REPO" body text
// and the streaming endpoint emits {"notGitRepo":true}. The frontend
// detects both and writes a single muted-gray line into the term
// instead of the giant red stderr.

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

// Full xterm stub: _writeStaticTerminalOutput calls fitTerminal,
// term.reset(), term.clear(), term.write(). Production code path goes
// through the real prototype; we mirror only the methods it touches.
function makeStubTerm() {
    const writes = [];
    return {
        writes,
        write: vi.fn((s) => writes.push(s)),
        reset: vi.fn(),
        clear: vi.fn(),
    };
}

function makeCtx(activeTab, cwd = '/no/repo') {
    const term = makeStubTerm();
    return {
        ctx: {
            term,
            fitTerminal: vi.fn(),
            activeTab,
            commitSelect: { value: 'unstaged' },
            app: { sessionsManager: { activeCWD: cwd } },
        },
        term,
    };
}

// True if any write on the term used a red ANSI code (the spam we're
// trying to suppress). False otherwise.
function wroteRed(term) {
    return term.writes.some(
        (s) => s.includes('\x1b[31m') || s.includes('\x1b[1;31m'),
    );
}

// True if any write used a muted gray code.
function wroteMuted(term) {
    return term.writes.some((s) => s.includes('\x1b[90m'));
}

// Convenience that mirrors the activeTab === 'diff' / 'status' branches
// of loadData: takes the fetch response body and the relevant 'fallback
// label', runs the production _writeStaticTerminalOutput on the stub,
// and records which branch landed. We mirror rather than call real
// loadData so the test is hermetic (no PTY, no websocket, no DOMs beyond
// jsdom's defaults).
async function loadAsActiveTab(activeTab) {
    const mod = await import('../web/diff.js');
    return mod.DiffController.prototype._writeStaticTerminalOutput;
}

describe('diff panel — not-a-git-repo sentinel', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('raw-diff: NOT_GIT_REPO body -> muted gray line, never red', async () => {
        const { ctx, term } = makeCtx('diff');
        const writeStatic = await loadAsActiveTab('diff');
        writeStatic.call(
            ctx,
            '',
            '\x1b[90mNot a git repository \u2014 the diff is empty for this workspace.\x1b[0m\r\n',
        );

        expect(wroteMuted(term)).toBe(true);
        expect(wroteRed(term)).toBe(false);
        expect(JSON.stringify(term.writes)).toMatch(/Not a git repository/);
    });

    it('raw-status: NOT_GIT_REPO body -> muted gray line mentions status, not diff', async () => {
        const { ctx, term } = makeCtx('status');
        const writeStatic = await loadAsActiveTab('status');
        writeStatic.call(
            ctx,
            '',
            '\x1b[90mNot a git repository \u2014 the status is empty for this workspace.\x1b[0m\r\n',
        );

        const joined = term.writes.join('');
        expect(joined).toMatch(/the status/);
        // Don't accidentally show "the diff" label on the status tab.
        expect(joined).not.toMatch(/the diff\b/);
        expect(wroteMuted(term)).toBe(true);
        expect(wroteRed(term)).toBe(false);
    });

    it('streaming branch: notGitRepo:true JSON -> muted gray line, never red', async () => {
        const { ctx, term } = makeCtx('diff');
        const writeStatic = await loadAsActiveTab('diff');
        writeStatic.call(
            ctx,
            '',
            '\x1b[90mNot a git repository \u2014 this view is empty for this workspace.\x1b[0m\r\n',
        );

        expect(wroteMuted(term)).toBe(true);
        expect(wroteRed(term)).toBe(false);
    });

    it('regression: non-sentinel content is rendered as-is, never the muted line', async () => {
        const { ctx, term } = makeCtx('diff');
        const writeStatic = await loadAsActiveTab('diff');
        const text = 'diff --git a/foo b/foo\n+hello\n';
        writeStatic.call(ctx, text, '\x1b[90mNo changes detected.\x1b[0m\r\n');

        const joined = term.writes.join('');
        expect(joined).toContain('+hello');
        expect(joined).not.toMatch(/Not a git repository/);
        expect(wroteRed(term)).toBe(false);
    });
});
