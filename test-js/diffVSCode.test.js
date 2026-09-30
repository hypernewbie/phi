// @vitest-environment jsdom
/**
 * DiffController — VS Code launch wiring tests (mock-only).
 *
 * We never actually open vscode: URIs in jsdom; we assert:
 *   - the action bar's project buttons get the right hrefs
 *   - per-file local + remote anchors slot into the rich-diff
 *     DOM after sanitization, using parsed file records (not
 *     decorative filename text)
 *   - deleted / renamed / binary entries get the right disabled
 *     states
 *   - stale-context guards prevent late fetches from installing
 *     links for an earlier project / server
 *   - the URL sanitizer still rejects live `vscode:` schemes in
 *     arbitrary rich-diff content
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, stubWebSocket, mockFetch } from './_dom.js';
import { DiffController } from '../web/diff.js';

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

function bootstrapDiffDom() {
    document.body.innerHTML = `
        <div id="diff-panel"></div>
        <button id="header-diff-toggle-btn"></button>
        <button id="close-diff-btn"></button>
        <button id="refresh-diff-btn"></button>
        <button id="copy-diff-btn"></button>
        <div id="diff-term-container"></div>
        <select id="diff-commit-select"></select>
        <div id="diff-action-bar">
            <a id="diff-vscode-local-btn" class="ft-vscode-btn ft-vscode-btn-compact hidden" href="#"></a>
            <a id="diff-vscode-remote-btn" class="ft-vscode-btn ft-vscode-btn-compact hidden" href="#"></a>
        </div>
        <button id="rich-diff-btn"></button>
        <div id="diff-modal" class="hidden">
            <button id="diff-layout-toggle-btn">Side-by-Side</button>
            <button id="diff-context-toggle-btn">More context</button>
            <button id="diff-syntax-toggle-btn">Syntax On</button>
            <button id="diff-modal-close"></button>
            <div id="diff-modal-body"></div>
        </div>
    `;
}

function buildAppStub({ cwd = '/home/user/project', hostname = 'jupiter' } = {}) {
    return {
        showToast: vi.fn(),
        tabManager: {
            getActiveTab: vi.fn(() => ({ cwd })),
            copyTextRobustly: vi.fn(),
        },
        sessionsManager: {
            activeCWD: cwd,
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
        hostname,
    };
}

/** Build a mock Diff2Html.html + parse implementation that hands
 *  back the supplied parsed file records as HTML. */
function installMockDiff2Html(parsedFiles) {
    const html = parsedFiles
        .map((f, i) => {
            const fileName = f.newName || f.oldName || `file${i}`;
            return `
                <div class="d2h-file-wrapper" data-lang="${fileName.split('.').pop()}">
                    <div class="d2h-file-header">
                        <span class="d2h-file-name">${fileName}${f.isDeleted ? ' (deleted)' : ''}${f.isBinary ? ' (binary)' : ''}</span>
                    </div>
                </div>
            `;
        })
        .join('');
    window.Diff2Html = {
        parse: vi.fn(() => parsedFiles),
        html: vi.fn(() => html),
        sanitize: vi.fn((s) => s),
    };
    window.DOMPurify = window.DOMPurify || {
        sanitize: vi.fn((s) => s),
    };
}

describe('DiffController — diff action bar VS Code project buttons', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('local button targets the active CWD with a vscode://file URI', () => {
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/code/phi', hostname: 'jupiter' }),
        );
        diffCtrl._refreshDiffProjectActions();
        const local = document.getElementById('diff-vscode-local-btn');
        const remote = document.getElementById('diff-vscode-remote-btn');
        expect(local.getAttribute('href')).toBe(
            'vscode://file/home/alex/code/phi',
        );
        expect(remote.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/code/phi',
        );
    });

    it('disables only the remote button when hostname is invalid', () => {
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex', hostname: 'bad host' }),
        );
        diffCtrl._refreshDiffProjectActions();
        const local = document.getElementById('diff-vscode-local-btn');
        const remote = document.getElementById('diff-vscode-remote-btn');
        expect(local.getAttribute('href')).toBe('vscode://file/home/alex');
        expect(remote.getAttribute('aria-disabled')).toBe('true');
    });

    it('disables both buttons when no active CWD', () => {
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '', hostname: 'jupiter' }),
        );
        diffCtrl._refreshDiffProjectActions();
        const local = document.getElementById('diff-vscode-local-btn');
        const remote = document.getElementById('diff-vscode-remote-btn');
        expect(local.getAttribute('aria-disabled')).toBe('true');
        expect(remote.getAttribute('aria-disabled')).toBe('true');
    });

    it('normalizes hostname (JUPITER -> jupiter) for the SSH target', () => {
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/proj', hostname: 'JUPITER.local' }),
        );
        diffCtrl._refreshDiffProjectActions();
        const remote = document.getElementById('diff-vscode-remote-btn');
        expect(remote.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter.local/proj',
        );
    });
});

describe('DiffController — per-file rich-diff VS Code actions', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('attaches local + remote anchors to every file header', () => {
        installMockDiff2Html([
            { newName: 'src/main.go', oldName: 'src/main.go' },
            { newName: 'README.md', oldName: 'README.md' },
        ]);
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        diffCtrl.activeDiffRoot = '/home/alex/phi';
        diffCtrl.activeDiffHostname = 'jupiter';
        diffCtrl.renderRichDiff(
            'diff --git a/src/main.go b/src/main.go\n+++ b/src/main.go\n@@ -1 +1 @@\n-old\n+new',
        );

        const headers = diffCtrl.diffModalBody.querySelectorAll(
            '.d2h-file-header',
        );
        expect(headers.length).toBe(2);
        for (const header of headers) {
            const local = header.querySelector('.ft-vscode-row-local-btn');
            const remote = header.querySelector('.ft-vscode-row-remote-btn');
            expect(local).not.toBeNull();
            expect(remote).not.toBeNull();
        }
        const local1 = headers[0].querySelector('.ft-vscode-row-local-btn');
        expect(local1.getAttribute('href')).toBe(
            'vscode://file/home/alex/phi/src/main.go',
        );
        const remote2 = headers[1].querySelector('.ft-vscode-row-remote-btn');
        expect(remote2.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/phi/README.md:1:1',
        );
    });

    it('disables deleted files but still resolves the destination for renames', () => {
        installMockDiff2Html([
            { newName: 'old.go', oldName: 'old.go', isDeleted: true },
            { newName: 'renamed.go', oldName: 'previous.go', isRename: true },
        ]);
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        diffCtrl.activeDiffRoot = '/home/alex/phi';
        diffCtrl.activeDiffHostname = 'jupiter';
        // Non-empty diff text so renderRichDiff doesn't early-return
        // on the "No changes detected" branch.
        diffCtrl.renderRichDiff('some diff text');

        const headers = diffCtrl.diffModalBody.querySelectorAll(
            '.d2h-file-header',
        );
        const localDeleted = headers[0].querySelector(
            '.ft-vscode-row-local-btn',
        );
        expect(localDeleted.getAttribute('aria-disabled')).toBe('true');
        // Renamed entry opens the destination.
        const remoteRenamed = headers[1].querySelector(
            '.ft-vscode-row-remote-btn',
        );
        expect(remoteRenamed.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/phi/renamed.go:1:1',
        );
    });

    it('binary files keep their actions (VS Code can open binaries as images)', () => {
        installMockDiff2Html([
            { newName: 'logo.png', oldName: 'logo.png', isBinary: true },
        ]);
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        diffCtrl.activeDiffRoot = '/home/alex/phi';
        diffCtrl.activeDiffHostname = 'jupiter';
        diffCtrl.renderRichDiff('some diff text');

        const local = diffCtrl.diffModalBody.querySelector(
            '.ft-vscode-row-local-btn',
        );
        const remote = diffCtrl.diffModalBody.querySelector(
            '.ft-vscode-row-remote-btn',
        );
        expect(local.getAttribute('href')).toBe(
            'vscode://file/home/alex/phi/logo.png',
        );
        expect(remote.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/phi/logo.png:1:1',
        );
    });

    it('does not attach actions when there is no accepted root snapshot', () => {
        installMockDiff2Html([{ newName: 'a.go', oldName: 'a.go' }]);
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        // activeDiffRoot left null — no accepted render yet.
        diffCtrl.renderRichDiff('some diff text');
        expect(
            diffCtrl.diffModalBody.querySelector('.ft-vscode-row-local-btn'),
        ).toBeNull();
    });

    it('rebuilds links on each render so layout toggles do not duplicate them', () => {
        installMockDiff2Html([{ newName: 'a.go', oldName: 'a.go' }]);
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        diffCtrl.activeDiffRoot = '/home/alex/phi';
        diffCtrl.activeDiffHostname = 'jupiter';

        diffCtrl.renderRichDiff('diff text 1');
        diffCtrl.renderRichDiff('diff text 2');
        diffCtrl.renderRichDiff('diff text 3');

        const localCount =
            diffCtrl.diffModalBody.querySelectorAll(
                '.ft-vscode-row-local-btn',
            ).length;
        const remoteCount =
            diffCtrl.diffModalBody.querySelectorAll(
                '.ft-vscode-row-remote-btn',
            ).length;
        expect(localCount).toBe(1);
        expect(remoteCount).toBe(1);
    });
});

describe('DiffController — stale-context guards on loadRichDiff', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('discards late fetch responses that no longer match the active context', async () => {
        // Project A's response body. Distinct from B so we can tell
        // which one survived the guard.
        const diffA = 'DIFF_FROM_PROJECT_A';
        const diffB = 'DIFF_FROM_PROJECT_B';
        mockFetch((url) => {
            if (url.includes('cwd=%2Fproj-a')) return diffA;
            if (url.includes('cwd=%2Fproj-b')) return diffB;
            throw new Error(`unexpected url: ${url}`);
        });

        const appA = buildAppStub({ cwd: '/proj-a', hostname: 'jupiter' });
        const diffCtrl = new DiffController(appA);
        diffCtrl.diffModalBody.innerHTML = '';

        // Spy on renderRichDiff: every late render would call it.
        // The token guard should reject A and accept B; the spy must
        // be called at most once and with the B body.
        const renderSpy = vi.fn();
        diffCtrl.renderRichDiff = renderSpy;

        // First request: project A.
        const pA = diffCtrl.loadRichDiff();
        // Mid-flight server switch: bump the token manually and
        // change the active cwd before starting the next request.
        diffCtrl._richDiffRequestToken++;
        appA.sessionsManager.activeCWD = '/proj-b';
        const pB = diffCtrl.loadRichDiff();

        await Promise.all([pA, pB]);

        // Exactly one render: the late A response was discarded.
        expect(renderSpy).toHaveBeenCalledTimes(1);
        // The accepted body is B, not A.
        expect(renderSpy.mock.calls[0][0]).toBe(diffB);
    });
});

describe('DiffController — desktop surfaces hide VS Code actions', () => {
    beforeEach(() => {
        bootstrapDiffDom();
        document.documentElement.setAttribute('data-phi-desktop-root', '');
    });

    afterEach(() => {
        document.documentElement.removeAttribute('data-phi-desktop-root');
    });

    it('removes the action bar VS Code buttons on desktop-root', () => {
        const diffCtrl = new DiffController(
            buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
        );
        expect(document.getElementById('diff-vscode-local-btn')).toBeNull();
        expect(document.getElementById('diff-vscode-remote-btn')).toBeNull();
        expect(diffCtrl.vscodeLocalBtn).toBeNull();
        expect(diffCtrl.vscodeRemoteBtn).toBeNull();
    });
});

// pull in afterEach from setupDomHarness via re-import
import { afterEach } from 'vitest';
