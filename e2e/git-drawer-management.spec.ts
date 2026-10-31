import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { configToToml, startPhi, type PhiServer } from './_server.js';

let phi: PhiServer | null = null;
let ownership: {
    pid: number;
    startTime: string;
    binary: string;
    binaryHash: string;
    revision: string;
    address: string;
} | null = null;
let project = '';
let peer = '';
let remote = '';
let baseHead = '';
let fixtureDir = '';

type FailedRequest = { method: string; url: string; error: string };

// Context changes can abort obsolete Git metadata and worktree-dirty reads.
// Each flow waits for a successful metadata read for its current workspace.
function unexpectedFailedRequests(requests: FailedRequest[]): FailedRequest[] {
    return requests.filter((request) => {
        const url = new URL(request.url);
        return !(
            request.method === 'GET' &&
            ['/api/git/info', '/api/git/worktree-dirty'].includes(
                url.pathname,
            ) &&
            request.error === 'net::ERR_ABORTED'
        );
    });
}

function command(cmd: string, args: string[], cwd = process.cwd()): string {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

function gitEnv(): NodeJS.ProcessEnv {
    const home = join(fixtureDir, 'home');
    return {
        PATH: process.env.PATH || '',
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LANG: 'C',
    };
}

function gitBytes(cwd: string, ...args: string[]): Buffer {
    return execFileSync('git', args, { cwd, env: gitEnv() });
}

function git(cwd: string, ...args: string[]): string {
    return gitBytes(cwd, ...args)
        .toString('utf8')
        .trim();
}

function ownedServerIdentity(server: PhiServer) {
    server.verify();
    const identity = server.identity;
    const revision = command('git', ['rev-parse', 'HEAD']);
    expect(identity.buildRevision).toBe(revision);
    expect(identity.goVersion).toContain(`vcs.revision=${revision}`);
    return {
        pid: identity.pid,
        startTime: identity.startTime,
        binary: identity.binaryPath,
        binaryHash: identity.binaryHash,
        revision: identity.buildRevision,
        address: server.url,
    };
}

function expectSameOwnership(server: PhiServer): void {
    const current = ownedServerIdentity(server);
    expect(current).toEqual(ownership);
}

function configureRepo(path: string): void {
    git(path, 'config', 'user.name', 'Phi Git drawer fixture');
    git(path, 'config', 'user.email', 'phi-git-drawer@example.invalid');
    git(path, 'config', 'commit.gpgsign', 'false');
}

async function waitForGitTargetHead(page: Page, head: string): Promise<void> {
    await page.waitForFunction((expectedHead) => {
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key?.endsWith(':info')) continue;
            try {
                const info = JSON.parse(localStorage.getItem(key) || 'null');
                if (info?.target?.head === expectedHead) return true;
            } catch {
                // Ignore unrelated or corrupt local entries.
            }
        }
        return false;
    }, head);
}

async function navigateToProject(page: Page): Promise<void> {
    if (!phi) throw new Error('Phi fixture is not running');
    await page.addInitScript(() => {
        const windowWithCapture = window as Window & {
            __phiTestTerminal?: any;
            __phiTerminalCaptureInstalled?: boolean;
        };
        if (windowWithCapture.__phiTerminalCaptureInstalled) return;
        windowWithCapture.__phiTerminalCaptureInstalled = true;
        let terminalConstructor: any;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => terminalConstructor,
            set: (TerminalClass) => {
                terminalConstructor = new Proxy(TerminalClass, {
                    construct(target, args) {
                        const terminal = Reflect.construct(target, args);
                        windowWithCapture.__phiTestTerminal = terminal;
                        return terminal as object;
                    },
                });
            },
        });
    });
    await page.goto(phi.url);
    await page.locator('#diff-term-container .xterm').first().waitFor({
        state: 'attached',
    });
    await page.waitForFunction((cwd) => {
        const select =
            document.querySelector<HTMLSelectElement>('#workspace-select');
        return Array.from(select?.options || []).some(
            (option) => option.value === cwd,
        );
    }, project);
    await page.locator('#workspace-select').selectOption(project);
    const panel = page.locator('#diff-panel');
    if (
        await panel.evaluate((element) => element.classList.contains('hidden'))
    ) {
        await page.locator('#header-diff-toggle-btn').click();
    }
    await page.locator('.diff-tab-btn[data-tab="diff"]').click();
    await expect(page.locator('#git-target-label')).toContainText(project);
    await expect(page.locator('#git-target-label')).toContainText(
        'Branch main',
    );
}

async function openProject(page: Page): Promise<void> {
    await navigateToProject(page);
    await expect(page.locator('#git-pull-btn')).toBeEnabled();
    await expect(page.locator('#git-push-btn')).toBeEnabled();
}

async function readGitTerminal(page: Page): Promise<string> {
    return page.evaluate(() => {
        const terminal = (window as Window & { __phiTestTerminal?: any })
            .__phiTestTerminal;
        const buffer = terminal?.buffer?.active;
        if (!buffer) return '';
        const lines: string[] = [];
        for (let index = 0; index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) || '');
        }
        return lines.join('\n');
    });
}

async function pendingGitActions(page: Page): Promise<unknown[]> {
    return page.evaluate(() => {
        const pending: unknown[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (
                !key?.startsWith('phi_git_manage_v1:') ||
                !key.includes(':action:')
            )
                continue;
            try {
                const record = JSON.parse(localStorage.getItem(key) || 'null');
                const actionMarker = ':action:';
                const markerIndex = key.indexOf(actionMarker);
                const contextKey =
                    markerIndex >= 0 ? key.slice(0, markerIndex) : '';
                const dismissed =
                    contextKey &&
                    localStorage.getItem(
                        `${contextKey}:dismissed:${encodeURIComponent(record?.id || '')}`,
                    ) === '1';
                if (
                    !dismissed &&
                    ['queued', 'sent', 'paused', 'unconfirmed'].includes(
                        record?.phase,
                    )
                ) {
                    pending.push({
                        action: record.action,
                        id: record.id,
                        phase: record.phase,
                        status: record.status,
                    });
                }
            } catch {
                pending.push({ key, invalid: true });
            }
        }
        return pending;
    });
}

function preparePullState() {
    writeFileSync(join(project, 'staged.txt'), 'staged bytes\n');
    git(project, 'add', 'staged.txt');
    writeFileSync(join(project, 'seed.txt'), 'unstaged bytes\n');
    writeFileSync(join(project, 'untracked.txt'), 'untracked bytes\n');
    const indexBefore = gitBytes(
        project,
        'ls-files',
        '--stage',
        '-z',
        '--',
        'staged.txt',
    );
    const stagedDeltaBefore = gitBytes(
        project,
        'diff',
        '--cached',
        '--binary',
        '--',
    );

    writeFileSync(join(peer, 'peer.txt'), 'peer commit\n');
    git(peer, 'add', 'peer.txt');
    git(peer, 'commit', '-m', 'peer fixture change');
    const peerHead = git(peer, 'rev-parse', 'HEAD');
    git(peer, 'push');
    return { indexBefore, stagedDeltaBefore, peerHead };
}

async function activate(
    page: Page,
    selector: string,
    mode: 'keyboard' | 'touch',
): Promise<void> {
    const button = page.locator(selector);
    if (mode === 'touch') {
        await button.tap();
        return;
    }
    await button.focus();
    await page.keyboard.press('Enter');
}

async function exercisePullPush(
    page: Page,
    options: { pull: 'keyboard' | 'touch'; push: 'keyboard' | 'touch' },
): Promise<void> {
    const failedRequests: FailedRequest[] = [];
    const httpErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('requestfailed', (request) => {
        failedRequests.push({
            method: request.method(),
            url: request.url(),
            error: request.failure()?.errorText || '',
        });
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.url()}`);
        }
    });
    page.on('console', (message) => {
        if (message.type() === 'error') {
            consoleErrors.push(`${message.text()} (${message.location().url})`);
        }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await openProject(page);
    const pullState = preparePullState();
    await activate(page, '#git-pull-btn', options.pull);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Pull completed.',
    );
    await waitForGitTargetHead(page, pullState.peerHead);

    const localHeadAfterPull = git(project, 'rev-parse', 'HEAD');
    const bareHeadAfterPull = git(remote, 'rev-parse', 'refs/heads/main');
    expect(localHeadAfterPull).toBe(pullState.peerHead);
    expect(bareHeadAfterPull).toBe(pullState.peerHead);
    expect(
        git(project, 'merge-base', '--is-ancestor', pullState.peerHead, 'HEAD'),
    ).toBe('');
    expect(
        gitBytes(
            project,
            'ls-files',
            '--stage',
            '-z',
            '--',
            'staged.txt',
        ).equals(pullState.indexBefore),
    ).toBe(true);
    expect(git(project, 'ls-files', '--error-unmatch', 'peer.txt')).toBe(
        'peer.txt',
    );
    expect(
        gitBytes(project, 'diff', '--cached', '--binary', '--').equals(
            pullState.stagedDeltaBefore,
        ),
    ).toBe(true);
    expect(gitBytes(project, 'show', 'HEAD:peer.txt').toString()).toBe(
        'peer commit\n',
    );
    expect(git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(
        'staged.txt',
    );
    expect(gitBytes(project, 'show', 'HEAD:seed.txt').toString()).toBe(
        'seed\n',
    );
    const status = gitBytes(project, 'status', '--short').toString('utf8');
    expect(status).toContain('A  staged.txt');
    expect(status).toContain(' M seed.txt');
    expect(status).toContain('?? untracked.txt');
    expect(readFileSync(join(project, 'staged.txt'), 'utf8')).toBe(
        'staged bytes\n',
    );
    expect(readFileSync(join(project, 'seed.txt'), 'utf8')).toBe(
        'unstaged bytes\n',
    );
    expect(readFileSync(join(project, 'untracked.txt'), 'utf8')).toBe(
        'untracked bytes\n',
    );

    git(project, 'reset', '--hard', 'HEAD');
    git(project, 'clean', '-fd');
    writeFileSync(join(project, 'push.txt'), 'local push commit\n');
    git(project, 'add', 'push.txt');
    git(project, 'commit', '-m', 'local fixture push');
    const localHeadBeforePush = git(project, 'rev-parse', 'HEAD');
    await page.locator('#refresh-diff-btn').click();
    await waitForGitTargetHead(page, localHeadBeforePush);
    await activate(page, '#git-push-btn', options.push);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Push completed.',
    );

    const localHeadAfterPush = git(project, 'rev-parse', 'HEAD');
    const bareHeadAfterPush = git(remote, 'rev-parse', 'refs/heads/main');
    expect(localHeadBeforePush).toBe(localHeadAfterPush);
    expect(bareHeadAfterPush).toBe(localHeadBeforePush);
    await expect.poll(() => pendingGitActions(page)).toEqual([]);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe(
        'refs/heads/main',
    );
    const expectedDevUpdateError = `${phi?.url}/api/update/status`;
    const unexpectedConsoleErrors = consoleErrors.filter(
        (error) => !error.includes(expectedDevUpdateError),
    );
    expect(unexpectedConsoleErrors, unexpectedConsoleErrors.join('\n')).toEqual(
        [],
    );
    const unexpectedFailures = unexpectedFailedRequests(failedRequests);
    expect(unexpectedFailures, JSON.stringify(unexpectedFailures)).toEqual([]);
    expect(httpErrors).toEqual([`503 ${expectedDevUpdateError}`]);

    const overflow = await page
        .locator('#git-management')
        .evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

async function enterAndSubmitCommit(
    page: Page,
    mode: 'keyboard' | 'touch',
    title: string,
): Promise<void> {
    const message = page.locator('#git-commit-message');
    await message.fill(title);
    await message.press('End');
    await message.press('Enter');
    await message.type('body text');
    await expect(message).toHaveValue(`${title}\nbody text`);
    await expect(page.locator('#git-commit-btn')).toBeEnabled();
    if (mode === 'keyboard') {
        await page.keyboard.press('Tab');
        await expect(page.locator('#git-pull-btn')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#git-push-btn')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#git-commit-btn')).toBeFocused();
        await page.keyboard.press('Enter');
    } else {
        await page.locator('#git-commit-btn').tap();
    }
}

async function exerciseCommitStaged(
    page: Page,
    mode: 'keyboard' | 'touch',
): Promise<void> {
    if (!phi) throw new Error('Phi fixture is not running');
    let actionPosts = 0;
    const consoleErrors: string[] = [];
    const failedRequests: FailedRequest[] = [];
    const httpErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
        failedRequests.push({
            method: request.method(),
            url: request.url(),
            error: request.failure()?.errorText || '',
        });
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.url()}`);
        }
    });
    page.on('request', (request) => {
        if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/git/action'
        ) {
            actionPosts++;
        }
    });
    const stagedFile = join(project, 'commit-version.txt');
    const untrackedFile = join(project, 'commit-untracked.txt');
    writeFileSync(stagedFile, 'version A\n');
    git(project, 'add', 'commit-version.txt');
    writeFileSync(stagedFile, 'version B\n');
    writeFileSync(untrackedFile, 'untracked bytes\n');

    await openProject(page);
    await page.locator('.diff-tab-btn[data-tab="log"]').click();
    await expect(page.locator('#git-commit-btn')).toBeDisabled();
    await enterAndSubmitCommit(page, mode, 'Commit staged version A');
    await expect(page.locator('#git-action-status')).toHaveText(
        'Commit completed.',
    );
    await expect(page.locator('#git-commit-message')).toHaveValue('');
    await expect
        .poll(() => readGitTerminal(page))
        .toContain('Commit staged version A');

    const localHead = git(project, 'rev-parse', 'HEAD');
    expect(localHead).not.toBe(baseHead);
    await waitForGitTargetHead(page, localHead);
    expect(
        gitBytes(project, 'show', 'HEAD:commit-version.txt').toString(),
    ).toBe('version A\n');
    expect(readFileSync(stagedFile, 'utf8')).toBe('version B\n');
    expect(readFileSync(untrackedFile, 'utf8')).toBe('untracked bytes\n');
    expect(gitBytes(project, 'diff', '--cached', '--binary').length).toBe(0);
    const status = gitBytes(project, 'status', '--short').toString('utf8');
    expect(status).toContain(' M commit-version.txt');
    expect(status).toContain('?? commit-untracked.txt');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(baseHead);

    await activate(page, '#git-push-btn', mode);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Push completed.',
    );
    expect(git(project, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(localHead);
    expect(actionPosts).toBe(2);
    await expect.poll(() => pendingGitActions(page)).toEqual([]);
    const overflow = await page
        .locator('#git-management')
        .evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    const expectedDevUpdateError = `${phi.url}/api/update/status`;
    const unexpectedConsoleErrors = consoleErrors.filter(
        (error) =>
            !error.includes(expectedDevUpdateError) &&
            !error.includes(
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ),
    );
    expect(unexpectedConsoleErrors, unexpectedConsoleErrors.join('\n')).toEqual(
        [],
    );
    const unexpectedFailures = unexpectedFailedRequests(failedRequests);
    expect(unexpectedFailures, JSON.stringify(unexpectedFailures)).toEqual([]);
    expect(httpErrors).toEqual([`503 ${expectedDevUpdateError}`]);
}

async function exerciseLostCommitResponse(
    page: Page,
    mode: 'keyboard' | 'touch',
): Promise<void> {
    if (!phi) throw new Error('Phi fixture is not running');
    let actionPosts = 0;
    const failedRequests: FailedRequest[] = [];
    const consoleErrors: string[] = [];
    const httpErrors: string[] = [];
    page.on('requestfailed', (request) => {
        failedRequests.push({
            method: request.method(),
            url: request.url(),
            error: request.failure()?.errorText || '',
        });
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.url()}`);
        }
    });
    const stagedFile = join(project, 'uncertain-commit.txt');
    writeFileSync(stagedFile, 'staged version A\n');
    git(project, 'add', 'uncertain-commit.txt');
    writeFileSync(stagedFile, 'working version B\n');

    await openProject(page);
    await page.route('**/api/git/action', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        actionPosts++;
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        expect(response.status()).toBe(200);
        await response.dispose();
        await route.abort('connectionreset');
    });
    await enterAndSubmitCommit(page, mode, 'uncertain staged commit');
    await expect(page.locator('#git-action-status')).toHaveText(
        'Result unconfirmed. Inspect Git state before running again.',
    );
    expect(actionPosts).toBe(1);
    const committedHead = git(project, 'rev-parse', 'HEAD');
    expect(committedHead).not.toBe(baseHead);
    expect(
        gitBytes(project, 'show', 'HEAD:uncertain-commit.txt').toString(),
    ).toBe('staged version A\n');
    expect(readFileSync(stagedFile, 'utf8')).toBe('working version B\n');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(baseHead);

    await navigateToProject(page);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Result unconfirmed. Inspect Git state before running again.',
    );
    await expect(page.locator('#git-commit-message')).toHaveValue(
        'uncertain staged commit\nbody text',
    );
    await expect(page.locator('#git-commit-btn')).toBeDisabled();
    await expect(page.locator('#git-action-dismiss-btn')).toBeVisible();
    const infoRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/git/info' && response.status() === 200;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#refresh-diff-btn').click();
    await infoRefresh;
    expect(actionPosts).toBe(1);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(committedHead);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(baseHead);
    const failedPaths = unexpectedFailedRequests(failedRequests).map(
        ({ url }) => new URL(url).pathname,
    );
    expect(
        failedPaths,
        JSON.stringify(unexpectedFailedRequests(failedRequests)),
    ).toEqual(['/api/git/action']);
    const expectedDevUpdateError = `${phi.url}/api/update/status`;
    const unexpectedConsoleErrors = consoleErrors.filter(
        (error) =>
            !error.includes(expectedDevUpdateError) &&
            !error.includes('net::ERR_CONNECTION_RESET') &&
            !error.includes(
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ),
    );
    expect(unexpectedConsoleErrors, unexpectedConsoleErrors.join('\n')).toEqual(
        [],
    );
    expect(httpErrors).toEqual([
        `503 ${expectedDevUpdateError}`,
        `503 ${expectedDevUpdateError}`,
    ]);
    await page.unroute('**/api/git/action');
    const overflow = await page
        .locator('#git-management')
        .evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

async function exerciseNetworkSafety(
    page: Page,
    options: { mode: 'keyboard' | 'touch'; cancel: boolean },
): Promise<void> {
    if (!phi) throw new Error('Phi fixture is not running');
    const consoleErrors: string[] = [];
    const failedRequests: FailedRequest[] = [];
    let actionPosts = 0;
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
        failedRequests.push({
            method: request.method(),
            url: request.url(),
            error: request.failure()?.errorText || '',
        });
    });
    page.on('request', (request) => {
        if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/git/action'
        ) {
            actionPosts++;
        }
    });

    writeFileSync(join(project, 'seed.txt'), 'cache-view-marker\n');
    let expectedHead = baseHead;
    if (!options.cancel) {
        writeFileSync(join(peer, 'offline-peer.txt'), 'offline recovery\n');
        git(peer, 'add', 'offline-peer.txt');
        git(peer, 'commit', '-m', 'offline recovery fixture');
        git(peer, 'push');
        expectedHead = git(peer, 'rev-parse', 'HEAD');
    }

    await openProject(page);
    await expect
        .poll(() => readGitTerminal(page))
        .toContain('cache-view-marker');
    await page.route('**/api/git/raw-diff**', (route) =>
        route.abort('internetdisconnected'),
    );
    await page.locator('#refresh-diff-btn').click();
    await expect.poll(() => readGitTerminal(page)).toContain('Failed to load:');
    await expect
        .poll(() => readGitTerminal(page))
        .toContain('cache-view-marker');
    await page.unroute('**/api/git/raw-diff**');

    let online = false;
    let signalInfoFailure: () => void = () => {};
    const infoFailure = new Promise<void>((resolve) => {
        signalInfoFailure = resolve;
    });
    await page.route('**/api/git/info**', async (route) => {
        if (!online) {
            await route.abort('internetdisconnected');
            signalInfoFailure();
            return;
        }
        await route.continue();
    });
    await activate(page, '#git-pull-btn', options.mode);
    await infoFailure;
    await expect(page.locator('#git-management')).toHaveAttribute(
        'aria-busy',
        'false',
    );
    await expect(page.locator('#git-action-cancel-btn')).toBeVisible();
    expect(actionPosts).toBe(0);

    if (options.cancel) {
        await activate(page, '#git-action-cancel-btn', options.mode);
        await expect(page.locator('#git-action-status')).toHaveText(
            'Unsent Git action cancelled.',
        );
        online = true;
        await page.unroute('**/api/git/info**');
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect(actionPosts).toBe(0);
        await expect.poll(() => pendingGitActions(page)).toEqual([]);
        expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
        expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(baseHead);
    } else {
        online = true;
        await page.unroute('**/api/git/info**');
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(page.locator('#git-action-status')).toHaveText(
            'Pull completed.',
        );
        expect(actionPosts).toBe(1);
        expect(git(project, 'rev-parse', 'HEAD')).toBe(expectedHead);
        expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
        expect(readFileSync(join(project, 'seed.txt'), 'utf8')).toBe(
            'cache-view-marker\n',
        );
    }

    const failedPaths = failedRequests.map(({ url }) => new URL(url).pathname);
    expect(failedPaths).toContain('/api/git/raw-diff');
    expect(failedPaths).toContain('/api/git/info');
    const unexpectedFailures = failedRequests.filter((request) => {
        const url = new URL(request.url);
        if (request.method !== 'GET') return true;
        if (url.pathname === '/api/git/raw-diff')
            return request.error !== 'net::ERR_INTERNET_DISCONNECTED';
        if (url.pathname === '/api/git/info')
            return ![
                'net::ERR_INTERNET_DISCONNECTED',
                'net::ERR_ABORTED',
            ].includes(request.error);
        if (url.pathname === '/api/git/worktree-dirty')
            return ![
                'net::ERR_INTERNET_DISCONNECTED',
                'net::ERR_ABORTED',
            ].includes(request.error);
        return true;
    });
    expect(unexpectedFailures, JSON.stringify(unexpectedFailures)).toEqual([]);
    const unexpectedConsoleErrors = consoleErrors.filter(
        (error) =>
            !error.includes(
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ) && !error.includes('net::ERR_INTERNET_DISCONNECTED'),
    );
    expect(unexpectedConsoleErrors).toEqual([]);
    const overflow = await page
        .locator('#git-management')
        .evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

async function exerciseLostResponse(
    page: Page,
    mode: 'keyboard' | 'touch',
): Promise<void> {
    if (!phi) throw new Error('Phi fixture is not running');
    let expectedHead = '';
    let actionPosts = 0;
    const failedRequests: string[] = [];
    page.on('requestfailed', (request) => failedRequests.push(request.url()));
    writeFileSync(join(peer, 'lost-response.txt'), 'one actual pull\n');
    git(peer, 'add', 'lost-response.txt');
    git(peer, 'commit', '-m', 'lost response fixture');
    git(peer, 'push');
    expectedHead = git(peer, 'rev-parse', 'HEAD');

    await openProject(page);
    await page.route('**/api/git/action', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        actionPosts++;
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        expect(response.status()).toBe(200);
        await response.dispose();
        await route.abort('connectionreset');
    });
    await activate(page, '#git-pull-btn', mode);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Result unconfirmed. Inspect Git state before running again.',
    );
    expect(actionPosts).toBe(1);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);

    await navigateToProject(page);
    await expect(page.locator('#git-action-status')).toHaveText(
        'Result unconfirmed. Inspect Git state before running again.',
    );
    await expect(page.locator('#git-pull-btn')).toBeDisabled();
    await expect(page.locator('#git-action-dismiss-btn')).toBeVisible();
    const infoRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/git/info' && response.status() === 200;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#refresh-diff-btn').click();
    await infoRefresh;
    await expect(page.locator('#git-action-status')).toHaveText(
        'Result unconfirmed. Inspect Git state before running again.',
    );
    expect(actionPosts).toBe(1);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
    expect(
        failedRequests.filter(
            (url) => new URL(url).pathname === '/api/git/action',
        ),
    ).toHaveLength(1);
    const overflow = await page
        .locator('#git-management')
        .evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    await page.unroute('**/api/git/action');
}

function resetFixture(): void {
    git(remote, 'update-ref', 'refs/heads/main', baseHead);
    git(project, 'reset', '--hard', baseHead);
    git(project, 'update-ref', 'refs/remotes/origin/main', baseHead);
    git(project, 'clean', '-fd');
    git(peer, 'reset', '--hard', baseHead);
    git(peer, 'update-ref', 'refs/remotes/origin/main', baseHead);
    git(peer, 'clean', '-fd');
}

test.beforeAll(async () => {
    test.setTimeout(180_000);
    const setup = (dir: string) => {
        fixtureDir = dir;
        const home = join(dir, 'home');
        project = join(dir, 'project');
        peer = join(dir, 'peer');
        remote = join(dir, 'remote.git');
        mkdirSync(join(home, '.phi'), { recursive: true });
        mkdirSync(project);
        mkdirSync(peer);
        mkdirSync(remote);
        writeFileSync(join(home, '.gitconfig'), '');
        mkdirSync(join(home, '.phi', 'backends'), { recursive: true });
        writeFileSync(
            join(home, '.phi', 'backends', 'opencode.json'),
            JSON.stringify({ id: 'opencode', session_source: 'none' }),
        );
        writeFileSync(
            join(home, '.phi', 'config.toml'),
            configToToml({
                workspaces: [project],
                auto_reconnect: 'off',
                pi_bridge_no_inject: true,
            }),
        );
        git(project, 'init', '--initial-branch=main');
        configureRepo(project);
        writeFileSync(join(project, 'seed.txt'), 'seed\n');
        git(project, 'add', 'seed.txt');
        git(project, 'commit', '-m', 'seed fixture');
        baseHead = git(project, 'rev-parse', 'HEAD');
        git(remote, 'init', '--bare', '--initial-branch=main');
        git(project, 'remote', 'add', 'origin', remote);
        git(project, 'push', '--set-upstream', 'origin', 'main');
        git(fixtureDir, 'clone', remote, peer);
        configureRepo(peer);
    };
    phi = await startPhi({
        setup,
        env: (dir) => ({
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: join(dir, 'home', '.gitconfig'),
        }),
    });
    ownership = ownedServerIdentity(phi);
    console.log('[git-drawer-e2e] owned server', {
        ...ownership,
        binary: ownership.binary,
        directory: phi.dir,
    });
    const versionResponse = await fetch(`${phi.url}/api/version`);
    expect(versionResponse.ok).toBe(true);
    expect(await versionResponse.json()).toMatchObject({ api: '1' });
});

test.afterAll(async () => {
    if (!phi) return;
    if (!ownership) {
        console.error(
            `[git-drawer-e2e] ownership unverified; retaining ${phi.dir}`,
        );
        return;
    }
    expectSameOwnership(phi);
    await phi.stop();
});

test('Git drawer actions stay safe in desktop and mobile contexts', async ({
    browser,
}) => {
    test.setTimeout(180_000);
    if (!phi) throw new Error('Phi fixture is not running');
    const desktop = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        const page = await desktop.newPage();
        await exercisePullPush(page, {
            pull: 'keyboard',
            push: 'keyboard',
        });
        resetFixture();
        await exerciseNetworkSafety(page, { mode: 'keyboard', cancel: true });
        resetFixture();
        await exerciseLostResponse(page, 'keyboard');
        await page.locator('#git-action-dismiss-btn').click();
        await expect(page.locator('#git-pull-btn')).toBeEnabled();
        resetFixture();
        await exerciseCommitStaged(page, 'keyboard');
        resetFixture();
        await exerciseLostCommitResponse(page, 'keyboard');
    } finally {
        await desktop.close();
    }

    resetFixture();
    const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
    });
    try {
        const page = await mobile.newPage();
        await exercisePullPush(page, {
            pull: 'touch',
            push: 'keyboard',
        });
        resetFixture();
        await exerciseNetworkSafety(page, { mode: 'touch', cancel: false });
        resetFixture();
        await exerciseCommitStaged(page, 'touch');
    } finally {
        await mobile.close();
    }
});
