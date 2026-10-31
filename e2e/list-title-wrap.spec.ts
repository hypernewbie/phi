import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
    type Request,
    type Response,
    type TestInfo,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from './_session-requests.js';

const SHORT_TITLE = 'Short';
const LONG_TITLE =
    'A long title with several words that should wrap onto multiple lines instead of disappearing';
type FixtureTab = { id: string; title: string };

const LONG_UNBROKEN_TITLE = 'https://'.padEnd(200, 'x');
const UNICODE_TITLE = '日本語の長いタイトル — résumé — مرحبا'.repeat(4);
const LONG_WORKTREE_NAME = 'longworktree'.repeat(8);
const LONG_BRANCH =
    'feature/this-is-an-extremely-long-branch-name-that-needs-to-wrap-on-a-mobile-screen';
const SHELL_TABS: FixtureTab[] = [
    { id: 'fixture-short', title: SHORT_TITLE },
    { id: 'fixture-long', title: LONG_TITLE },
];
const PI_SESSIONS: FixtureTab[] = [
    { id: 'fixture-session-short', title: SHORT_TITLE },
    { id: 'fixture-session-long', title: LONG_TITLE },
];
const EDGE_TABS: FixtureTab[] = [
    { id: 'fixture-short', title: SHORT_TITLE },
    { id: 'fixture-unbroken', title: LONG_UNBROKEN_TITLE },
    { id: 'fixture-unicode', title: UNICODE_TITLE },
];
const EDGE_SESSIONS: FixtureTab[] = [
    { id: 'fixture-session-short', title: SHORT_TITLE },
    { id: 'fixture-session-unbroken', title: LONG_UNBROKEN_TITLE },
    { id: 'fixture-session-unicode', title: UNICODE_TITLE },
];
const SCROLL_TABS: FixtureTab[] = [
    { id: 'fixture-scroll-empty', title: '' },
    ...Array.from({ length: 8 }, (_, index) => ({
        id: `fixture-scroll-${index + 1}`,
        title: `Scrollable tab ${index + 1}`,
    })),
    { id: 'fixture-scroll-long', title: LONG_TITLE },
];

type FixtureOptions = {
    shellTabs?: FixtureTab[];
    piSessions?: FixtureTab[];
    longWorktree?: boolean;
    noGit?: boolean;
    tabCwd?: 'workspace' | 'long-worktree';
};
const KNOWN_PIN_PHASES = new Set([
    'online',
    'injected-session-failure',
    'recovery',
]);
const KNOWN_WORKTREE_STATE_PHASES = new Set([
    'injected-session-failure',
    'recovery',
]);
const SESSION_REFRESH_FAILURE = 'fixture session refresh failed';
const OFFLINE_NETWORK_ERRORS = new Set([
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
]);
let nextRequestId = 0;

type Fixture = {
    phi: PhiServer;
    cwd: string;
    longWorktreePath: string | null;
    shellTabs: FixtureTab[];
    piSessions: FixtureTab[];
    sessionPaths: Map<string, string>;
};

type PinTerminal = {
    kind: 'finished' | 'failed';
    phase: string;
    online: boolean;
    errorText?: string;
};

type PinResponse = {
    status: number;
    contentLength: string | null;
};

type WorktreeStateSnapshot = {
    method: string;
    url: string;
    responseUrl: string;
    status: number;
    cwd: string;
    path: string | null;
    expanded: boolean | null;
    redirected: boolean;
};

type PinRequestRecord = {
    requestId: number;
    phase: string;
    onlineAtStart: boolean;
    terminalPhase?: string;
    onlineAtTerminal?: boolean;
    url: string;
    origin: string;
    method: string;
    body: string | null;
    redirected: boolean;
    response?: PinResponse;
    terminal?: PinTerminal;
    classification?: 'known-pin-completion';
    serverPinned?: boolean;
    serverLogCount?: number;
    serverLogWritesRequired?: number;
};

type BrowserRequestRecord = {
    requestId: number;
    phase: string;
    onlineAtStart: boolean;
    url: string;
    origin: string;
    method: string;
    body: string | null;
    redirected: boolean;
    response?: PinResponse;
    terminal?: PinTerminal;
    injectedResponse?: { status: number; body: string };
    worktreeStateSnapshot?: WorktreeStateSnapshot;
    classification?: 'known-worktree-state-completion';
};

type Diagnostic = {
    phase: string;
    kind: string;
    message: string;
    url?: string;
    requestId?: number | null;
    relatedRequestIds?: number[];
    classification?: string;
};

type PinClassifierEvidence = {
    requestId: number;
    url: string;
    origin: string;
    method: string;
    body: string | null;
    phase: string;
    terminalPhase: string;
    onlineAtStart: boolean;
    onlineAtTerminal: boolean;
    redirected: boolean;
    response: PinResponse | undefined;
    terminal: PinTerminal | undefined;
    seededPaneIds: string[];
    serverPinned: boolean;
    serverLogApplied: boolean;
};

type WorktreeStateClassifierEvidence = {
    requestId: number;
    url: string;
    origin: string;
    method: string;
    body: string | null;
    phase: string;
    terminalPhase: string;
    onlineAtStart: boolean;
    onlineAtTerminal: boolean;
    redirected: boolean;
    response: PinResponse | undefined;
    terminal: PinTerminal | undefined;
    fixtureCwd: string;
    expectedExpanded: boolean;
    stateSnapshot: WorktreeStateSnapshot | undefined;
};

type Diagnostics = {
    label: string;
    origin: string;
    entries: Diagnostic[];
    pinRequests: PinRequestRecord[];
    requestRecords: BrowserRequestRecord[];
    getRequestRecord: (request: Request) => BrowserRequestRecord | undefined;
    setPhase: (phase: string, online?: boolean) => void;
};

type GeometryArtifact = {
    label: string;
    viewport: { width: number; height: number };
    value: Record<string, unknown>;
};

function piProjectDirectory(home: string, cwd: string): string {
    const normalized = realpathSync(cwd).replaceAll('\\', '/');
    const encoded = normalized
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replaceAll('/', '-');
    return join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function writePiSession(
    home: string,
    cwd: string,
    id: string,
    title: string,
): string {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    const records = [
        JSON.stringify({ type: 'session', version: 3, id, cwd }),
        JSON.stringify({ type: 'session_info', name: title }),
    ];
    writeFileSync(path, `${records.join('\n')}\n`);
    return path;
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
    const shellTabs = options.shellTabs ?? SHELL_TABS;
    const piSessions = options.piSessions ?? PI_SESSIONS;
    const env: Record<string, string> = {
        PHI_SHUTDOWN_PTY_GRACE: '150ms',
        PHI_SHUTDOWN_GRACE: '1s',
    };
    let cwd = '';
    let longWorktreePath: string | null = null;
    const sessionPaths = new Map<string, string>();
    const phi = await startPhi({
        env,
        setup(dir) {
            const workspace = join(dir, 'workspace');
            mkdirSync(workspace, { recursive: true });
            cwd = realpathSync(workspace);
            const home = join(dir, 'home');
            const phiHome = join(home, '.phi');
            const backends = join(phiHome, 'backends');
            const fakeBin = join(dir, 'fake-bin');
            mkdirSync(backends, { recursive: true });
            mkdirSync(fakeBin, { recursive: true });

            const shell = join(dir, 'fixture-bash');
            writeFileSync(
                shell,
                '#!/bin/sh\nprintf "fixture bash ready\\r\\n"\nexec /bin/cat\n',
                {
                    mode: 0o755,
                },
            );
            writeFileSync(join(fakeBin, 'pi'), '#!/bin/sh\nexec /bin/cat\n', {
                mode: 0o755,
            });
            writeFileSync(
                join(fakeBin, 'opencode'),
                '#!/bin/sh\nprintf ":memory:\\n"\n',
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command: shell }),
            );
            writeFileSync(
                join(phiHome, 'config.json'),
                JSON.stringify({ workspaces: [cwd], active_cwd: cwd }),
            );

            const safePath = `${fakeBin}:/usr/bin:/bin`;
            env.GIT_CEILING_DIRECTORIES = realpathSync(dir);
            env.PATH = safePath;
            const gitEnv = {
                HOME: home,
                PATH: safePath,
                GIT_CEILING_DIRECTORIES: env.GIT_CEILING_DIRECTORIES,
            };
            if (!options.noGit) {
                execFileSync(
                    'git',
                    ['init', '--quiet', '--initial-branch=fixture'],
                    { cwd, env: gitEnv },
                );
                if (options.longWorktree) {
                    execFileSync(
                        'git',
                        ['config', 'user.name', 'Phi Fixture'],
                        {
                            cwd,
                            env: gitEnv,
                        },
                    );
                    execFileSync(
                        'git',
                        ['config', 'user.email', 'phi-fixture@example.invalid'],
                        { cwd, env: gitEnv },
                    );
                    writeFileSync(join(cwd, 'fixture.txt'), 'tracked\n');
                    execFileSync('git', ['add', 'fixture.txt'], {
                        cwd,
                        env: gitEnv,
                    });
                    execFileSync(
                        'git',
                        [
                            '-c',
                            'commit.gpgsign=false',
                            'commit',
                            '--quiet',
                            '-m',
                            'fixture',
                        ],
                        { cwd, env: gitEnv },
                    );
                    longWorktreePath = join(dir, LONG_WORKTREE_NAME);
                    execFileSync(
                        'git',
                        [
                            'worktree',
                            'add',
                            '--quiet',
                            '-b',
                            LONG_BRANCH,
                            longWorktreePath,
                            'HEAD',
                        ],
                        { cwd, env: gitEnv },
                    );
                    writeFileSync(
                        join(longWorktreePath, 'dirty-fixture.txt'),
                        'untracked\n',
                    );
                }
            }
            const tabCwd =
                options.tabCwd === 'long-worktree' ? longWorktreePath : cwd;
            if (!tabCwd) throw new Error('fixture tab worktree is unavailable');
            writeFileSync(
                join(phiHome, 'tabs.json'),
                JSON.stringify(
                    shellTabs.map(({ id, title }) => ({
                        id,
                        coder: 'bash',
                        session_id: '',
                        cwd: tabCwd,
                        workspace: cwd,
                        title,
                        pinned: true,
                    })),
                ),
            );
            for (const session of piSessions) {
                sessionPaths.set(
                    session.id,
                    writePiSession(home, cwd, session.id, session.title),
                );
                // Close/undo can leave either worktree selected. Both must
                // contain the session used to check desktop title styling.
                if (tabCwd !== cwd) {
                    writePiSession(home, tabCwd, session.id, session.title);
                }
            }
        },
    });
    return { phi, cwd, longWorktreePath, shellTabs, piSessions, sessionPaths };
}

function parsePinPath(url: string): string | null {
    try {
        const match = new URL(url).pathname.match(
            /^\/api\/terminals\/([^/]+)\/pin$/,
        );
        return match ? decodeURIComponent(match[1]) : null;
    } catch {
        return null;
    }
}

function hasExactPinnedBody(body: string | null): boolean {
    if (!body) return false;
    try {
        const parsed: unknown = JSON.parse(body);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
        )
            return false;
        const value = parsed as Record<string, unknown>;
        return Object.keys(value).length === 1 && value.pinned === true;
    } catch {
        return false;
    }
}

function isKnownPinCompletion(evidence: PinClassifierEvidence): boolean {
    let url: URL;
    try {
        url = new URL(evidence.url);
    } catch {
        return false;
    }
    const paneId = parsePinPath(evidence.url);
    return (
        evidence.requestId > 0 &&
        url.origin === evidence.origin &&
        evidence.method === 'POST' &&
        paneId !== null &&
        evidence.seededPaneIds.includes(paneId) &&
        hasExactPinnedBody(evidence.body) &&
        KNOWN_PIN_PHASES.has(evidence.phase) &&
        evidence.terminalPhase === evidence.phase &&
        evidence.onlineAtStart &&
        evidence.onlineAtTerminal &&
        !evidence.redirected &&
        evidence.response?.status === 200 &&
        evidence.response.contentLength === '0' &&
        evidence.terminal?.kind === 'failed' &&
        evidence.terminal.errorText === 'net::ERR_ABORTED' &&
        evidence.serverPinned &&
        evidence.serverLogApplied
    );
}

function assertPinClassifier(): void {
    const valid: PinClassifierEvidence = {
        requestId: 1,
        url: 'http://127.0.0.1:1234/api/terminals/fixture-long/pin',
        origin: 'http://127.0.0.1:1234',
        method: 'POST',
        body: '{"pinned":true}',
        phase: 'online',
        terminalPhase: 'online',
        onlineAtStart: true,
        onlineAtTerminal: true,
        redirected: false,
        response: { status: 200, contentLength: '0' },
        terminal: {
            kind: 'failed',
            phase: 'online',
            online: true,
            errorText: 'net::ERR_ABORTED',
        },
        seededPaneIds: ['fixture-long'],
        serverPinned: true,
        serverLogApplied: true,
    };
    const cases: Array<{
        name: string;
        evidence: PinClassifierEvidence;
        expected: boolean;
    }> = [
        { name: 'complete pin evidence', evidence: valid, expected: true },
        {
            name: 'missing 200 response',
            evidence: { ...valid, response: undefined },
            expected: false,
        },
        {
            name: 'false pin body',
            evidence: { ...valid, body: '{"pinned":false}' },
            expected: false,
        },
        {
            name: 'unseeded pane',
            evidence: {
                ...valid,
                url: 'http://127.0.0.1:1234/api/terminals/other/pin',
            },
            expected: false,
        },
        {
            name: 'different error',
            evidence: {
                ...valid,
                terminal: {
                    kind: 'failed',
                    phase: 'online',
                    online: true,
                    errorText: 'net::ERR_CONNECTION_RESET',
                },
            },
            expected: false,
        },
        {
            name: 'offline request',
            evidence: {
                ...valid,
                phase: 'offline',
                terminalPhase: 'offline',
                onlineAtStart: false,
                onlineAtTerminal: false,
            },
            expected: false,
        },
    ];
    for (const item of cases) {
        expect(isKnownPinCompletion(item.evidence), item.name).toBe(
            item.expected,
        );
    }
}

function hasExactWorktreeStateBody(
    body: string | null,
    cwd: string,
    expanded: boolean,
): boolean {
    if (!body) return false;
    try {
        const parsed: unknown = JSON.parse(body);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
        )
            return false;
        const value = parsed as Record<string, unknown>;
        const state = value.expanded;
        if (
            Object.keys(value).sort().join(',') !==
                ['active_worktree', 'expanded', 'workspace'].sort().join(',') ||
            value.workspace !== cwd ||
            value.active_worktree !== cwd ||
            typeof state !== 'object' ||
            state === null ||
            Array.isArray(state)
        )
            return false;
        const expansion = state as Record<string, unknown>;
        return (
            Object.keys(expansion).length === 1 && expansion[cwd] === expanded
        );
    } catch {
        return false;
    }
}

function isKnownWorktreeStateCompletion(
    evidence: WorktreeStateClassifierEvidence,
): boolean {
    let url: URL;
    let snapshotUrl: URL;
    let responseUrl: URL;
    try {
        url = new URL(evidence.url);
        if (!evidence.stateSnapshot) return false;
        snapshotUrl = new URL(evidence.stateSnapshot.url);
        responseUrl = new URL(evidence.stateSnapshot.responseUrl);
    } catch {
        return false;
    }
    const snapshot = evidence.stateSnapshot;
    return (
        evidence.requestId > 0 &&
        url.origin === evidence.origin &&
        url.pathname === '/api/config/worktree-state' &&
        url.search === '' &&
        url.hash === '' &&
        evidence.method === 'POST' &&
        hasExactWorktreeStateBody(
            evidence.body,
            evidence.fixtureCwd,
            evidence.expectedExpanded,
        ) &&
        KNOWN_WORKTREE_STATE_PHASES.has(evidence.phase) &&
        evidence.terminalPhase === evidence.phase &&
        evidence.onlineAtStart &&
        evidence.onlineAtTerminal &&
        !evidence.redirected &&
        evidence.response?.status === 200 &&
        evidence.response.contentLength === '0' &&
        evidence.terminal?.kind === 'failed' &&
        evidence.terminal.phase === evidence.phase &&
        evidence.terminal.online &&
        evidence.terminal.errorText === 'net::ERR_ABORTED' &&
        snapshot.method === 'GET' &&
        snapshot.status === 200 &&
        snapshot.cwd === evidence.fixtureCwd &&
        snapshot.path === evidence.fixtureCwd &&
        snapshot.expanded === evidence.expectedExpanded &&
        !snapshot.redirected &&
        snapshotUrl.origin === evidence.origin &&
        snapshotUrl.pathname === '/api/git/worktrees' &&
        snapshotUrl.hash === '' &&
        [...snapshotUrl.searchParams].length === 1 &&
        snapshotUrl.searchParams.get('cwd') === evidence.fixtureCwd &&
        responseUrl.href === snapshotUrl.href
    );
}

function assertWorktreeStateClassifier(): void {
    const cwd = '/fixture/workspace';
    const url = 'http://127.0.0.1:1234/api/config/worktree-state';
    const readbackUrl = `http://127.0.0.1:1234/api/git/worktrees?cwd=${encodeURIComponent(cwd)}`;
    const stateSnapshot: WorktreeStateSnapshot = {
        method: 'GET',
        url: readbackUrl,
        responseUrl: readbackUrl,
        status: 200,
        cwd,
        path: cwd,
        expanded: false,
        redirected: false,
    };
    const valid: WorktreeStateClassifierEvidence = {
        requestId: 2,
        url,
        origin: 'http://127.0.0.1:1234',
        method: 'POST',
        body: JSON.stringify({
            workspace: cwd,
            active_worktree: cwd,
            expanded: { [cwd]: false },
        }),
        phase: 'injected-session-failure',
        terminalPhase: 'injected-session-failure',
        onlineAtStart: true,
        onlineAtTerminal: true,
        redirected: false,
        response: { status: 200, contentLength: '0' },
        terminal: {
            kind: 'failed',
            phase: 'injected-session-failure',
            online: true,
            errorText: 'net::ERR_ABORTED',
        },
        fixtureCwd: cwd,
        expectedExpanded: false,
        stateSnapshot,
    };
    const cases: Array<{
        name: string;
        evidence: WorktreeStateClassifierEvidence;
        expected: boolean;
    }> = [
        {
            name: 'complete worktree state evidence',
            evidence: valid,
            expected: true,
        },
        {
            name: 'missing state readback',
            evidence: { ...valid, stateSnapshot: undefined },
            expected: false,
        },
        {
            name: 'wrong expansion state',
            evidence: {
                ...valid,
                stateSnapshot: { ...stateSnapshot, expanded: true },
            },
            expected: false,
        },
        {
            name: 'wrong worktree path',
            evidence: {
                ...valid,
                stateSnapshot: { ...stateSnapshot, path: '/other/worktree' },
            },
            expected: false,
        },
        {
            name: 'nonempty POST response',
            evidence: {
                ...valid,
                response: { status: 200, contentLength: '2' },
            },
            expected: false,
        },
        {
            name: 'different POST failure',
            evidence: {
                ...valid,
                terminal: {
                    kind: 'failed',
                    phase: 'injected-session-failure',
                    online: true,
                    errorText: 'net::ERR_CONNECTION_RESET',
                },
            },
            expected: false,
        },
        {
            name: 'unexpected phase',
            evidence: { ...valid, phase: 'online', terminalPhase: 'online' },
            expected: false,
        },
        {
            name: 'extra POST body field',
            evidence: {
                ...valid,
                body: JSON.stringify({
                    workspace: cwd,
                    active_worktree: cwd,
                    expanded: { [cwd]: false },
                    extra: true,
                }),
            },
            expected: false,
        },
    ];
    for (const item of cases) {
        expect(isKnownWorktreeStateCompletion(item.evidence), item.name).toBe(
            item.expected,
        );
    }
}

test.beforeAll(() => {
    assertPinClassifier();
    assertWorktreeStateClassifier();
});

async function installDiagnostics(
    context: BrowserContext,
    page: Page,
    phi: PhiServer,
    label: string,
): Promise<Diagnostics> {
    const entries: Diagnostic[] = [];
    const pinRequests: PinRequestRecord[] = [];
    const requestRecords: BrowserRequestRecord[] = [];
    const origin = new URL(phi.url).origin;
    let phase = 'online';
    let online = true;
    const requestMetadata = new Map<Request, BrowserRequestRecord>();
    const pinRequestsByRequest = new Map<Request, PinRequestRecord>();

    await context.route('**/*', async (route) => {
        const url = route.request().url();
        const parsed = new URL(url);
        if (parsed.origin !== origin) {
            const metadata = requestMetadata.get(route.request());
            entries.push({
                phase: metadata?.phase ?? phase,
                kind: 'external-request',
                message: 'Blocked non-fixture browser request',
                url,
                requestId: metadata?.requestId,
            });
            await route.abort();
            return;
        }
        if (
            route.request().method() === 'GET' &&
            parsed.pathname === '/api/update/status'
        ) {
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    current: 'dev',
                    update_available: false,
                }),
            });
            return;
        }
        await route.fallback();
    });

    page.on('request', (request) => {
        const metadata: BrowserRequestRecord = {
            requestId: ++nextRequestId,
            phase,
            onlineAtStart: online,
            url: request.url(),
            origin: new URL(request.url()).origin,
            method: request.method(),
            body: request.postData(),
            redirected:
                request.redirectedFrom() !== null ||
                request.redirectedTo() !== null,
        };
        requestMetadata.set(request, metadata);
        requestRecords.push(metadata);
        if (parsePinPath(request.url()) === null) return;
        const record: PinRequestRecord = {
            requestId: metadata.requestId,
            phase: metadata.phase,
            onlineAtStart: metadata.onlineAtStart,
            url: metadata.url,
            origin: metadata.origin,
            method: metadata.method,
            body: metadata.body,
            redirected: metadata.redirected,
        };
        pinRequests.push(record);
        pinRequestsByRequest.set(request, record);
    });
    page.on('response', (response) => {
        const request = response.request();
        const metadata = requestMetadata.get(request);
        const pinRequest = pinRequestsByRequest.get(request);
        const headers = response.headers();
        if (metadata) {
            metadata.response = {
                status: response.status(),
                contentLength: headers['content-length'] ?? null,
            };
            metadata.redirected ||=
                request.redirectedFrom() !== null ||
                request.redirectedTo() !== null;
        }
        if (pinRequest) {
            pinRequest.response = metadata?.response;
            pinRequest.redirected =
                metadata?.redirected ?? pinRequest.redirected;
        }
        if (response.status() >= 400) {
            entries.push({
                phase: metadata?.phase ?? phase,
                kind: 'http-error',
                message: `HTTP ${response.status()}`,
                url: response.url(),
                requestId: metadata?.requestId,
            });
        }
    });
    page.on('requestfinished', (request) => {
        const terminal: PinTerminal = { kind: 'finished', phase, online };
        const metadata = requestMetadata.get(request);
        if (metadata) metadata.terminal = terminal;
        const record = pinRequestsByRequest.get(request);
        if (record) {
            record.terminal = terminal;
            record.terminalPhase = phase;
            record.onlineAtTerminal = online;
        }
    });
    page.on('requestfailed', (request) => {
        const terminal: PinTerminal = {
            kind: 'failed',
            phase,
            online,
            errorText: request.failure()?.errorText ?? 'request failed',
        };
        const metadata = requestMetadata.get(request);
        if (metadata) metadata.terminal = terminal;
        const record = pinRequestsByRequest.get(request);
        if (record) {
            record.terminal = terminal;
            record.terminalPhase = phase;
            record.onlineAtTerminal = online;
        }
        let classification: string | undefined;
        if (isCancelledSessionListRead(request, origin))
            classification = 'cancelled-session-list-read';
        else if (isCancelledWorktreeRead(request, origin))
            classification = 'cancelled-worktree-read';
        entries.push({
            phase: metadata?.phase ?? phase,
            kind: 'request-failed',
            message: request.failure()?.errorText ?? 'request failed',
            url: request.url(),
            requestId: metadata?.requestId,
            classification,
        });
    });
    page.on('pageerror', (error) => {
        entries.push({ phase, kind: 'page-error', message: error.message });
    });
    page.on('console', (message) => {
        if (message.type() === 'error') {
            entries.push({
                phase,
                kind: 'console-error',
                message: message.text(),
                url: message.location().url,
                requestId: null,
            });
        }
    });

    return {
        label,
        origin,
        entries,
        pinRequests,
        requestRecords,
        getRequestRecord: (request) => requestMetadata.get(request),
        setPhase(next, nextOnline = next !== 'offline' && next !== 'teardown') {
            phase = next;
            online = nextOnline;
        },
    };
}

async function classifyKnownPinFailures(
    fixture: Fixture,
    diagnostics: Diagnostics[],
): Promise<void> {
    const failedPins = diagnostics.flatMap((item) =>
        item.pinRequests.filter(
            (request) =>
                request.terminal?.kind === 'failed' &&
                request.classification === undefined &&
                KNOWN_PIN_PHASES.has(request.phase) &&
                request.onlineAtStart &&
                request.onlineAtTerminal === true,
        ),
    );
    if (failedPins.length === 0) return;

    const response = await fetch(`${fixture.phi.url}/api/terminals`, {
        signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200)
        throw new Error(`pin state request returned HTTP ${response.status}`);
    const terminals = (await response.json()) as Array<{
        id: string;
        pinned: boolean;
    }>;
    const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
    const serverLog = readFileSync(fixture.phi.logPath, 'utf8');
    const allRequests = diagnostics.flatMap((item) => item.pinRequests);

    for (const request of failedPins) {
        const paneId = parsePinPath(request.url);
        if (!paneId) continue;
        const trueWritesRequired = allRequests.filter(
            (candidate) =>
                parsePinPath(candidate.url) === paneId &&
                hasExactPinnedBody(candidate.body) &&
                candidate.terminal !== undefined,
        ).length;
        const serverLogCount = serverLog
            .split('\n')
            .filter((line) =>
                line.includes(`[pty] SetPinned ${paneId}: pinned=true`),
            ).length;
        const state = byId.get(paneId);
        request.serverPinned = state?.pinned === true;
        request.serverLogCount = serverLogCount;
        request.serverLogWritesRequired = trueWritesRequired;
        const evidence: PinClassifierEvidence = {
            requestId: request.requestId,
            url: request.url,
            origin: request.origin,
            method: request.method,
            body: request.body,
            phase: request.phase,
            terminalPhase: request.terminalPhase ?? '',
            onlineAtStart: request.onlineAtStart,
            onlineAtTerminal: request.onlineAtTerminal === true,
            redirected: request.redirected,
            response: request.response,
            terminal: request.terminal,
            seededPaneIds: fixture.shellTabs.map((tab) => tab.id),
            serverPinned: request.serverPinned,
            serverLogApplied:
                trueWritesRequired > 0 && serverLogCount >= trueWritesRequired,
        };
        if (isKnownPinCompletion(evidence)) {
            request.classification = 'known-pin-completion';
            for (const item of diagnostics) {
                for (const entry of item.entries) {
                    if (
                        entry.kind === 'request-failed' &&
                        entry.requestId === request.requestId
                    )
                        entry.classification = 'known-pin-completion';
                }
            }
        }
    }
}

async function classifyKnownWorktreeStateFailures(
    fixture: Fixture,
    diagnostics: Diagnostics[],
): Promise<void> {
    for (const item of diagnostics) {
        if (item.label !== 'latency-mobile-sessions') continue;
        const stateRequests = item.requestRecords.filter((request) => {
            try {
                const url = new URL(request.url);
                return (
                    url.origin === item.origin &&
                    url.pathname === '/api/config/worktree-state' &&
                    KNOWN_WORKTREE_STATE_PHASES.has(request.phase)
                );
            } catch {
                return false;
            }
        });
        if (stateRequests.length !== 4) continue;

        const expectedWrites = [
            { phase: 'injected-session-failure', expanded: false },
            { phase: 'injected-session-failure', expanded: true },
            { phase: 'recovery', expanded: false },
            { phase: 'recovery', expanded: true },
        ];
        const matched: Array<{
            request: BrowserRequestRecord;
            expanded: boolean;
        }> = [];
        for (const expected of expectedWrites) {
            const candidates = stateRequests.filter(
                (request) =>
                    request.phase === expected.phase &&
                    hasExactWorktreeStateBody(
                        request.body,
                        fixture.cwd,
                        expected.expanded,
                    ),
            );
            if (candidates.length !== 1) break;
            const request = candidates[0];
            if (!request) break;
            matched.push({ request, expanded: expected.expanded });
        }
        if (matched.length !== expectedWrites.length) continue;

        for (const { request, expanded } of matched) {
            const evidence: WorktreeStateClassifierEvidence = {
                requestId: request.requestId,
                url: request.url,
                origin: request.origin,
                method: request.method,
                body: request.body,
                phase: request.phase,
                terminalPhase: request.terminal?.phase ?? '',
                onlineAtStart: request.onlineAtStart,
                onlineAtTerminal: request.terminal?.online === true,
                redirected: request.redirected,
                response: request.response,
                terminal: request.terminal,
                fixtureCwd: fixture.cwd,
                expectedExpanded: expanded,
                stateSnapshot: request.worktreeStateSnapshot,
            };
            if (!isKnownWorktreeStateCompletion(evidence)) continue;
            request.classification = 'known-worktree-state-completion';
            for (const entry of item.entries) {
                if (
                    entry.kind === 'request-failed' &&
                    entry.message === 'net::ERR_ABORTED' &&
                    entry.requestId === request.requestId
                )
                    entry.classification = 'known-worktree-state-completion';
            }
        }
    }
}

function isExpectedInjectedSessionRequest(
    request: BrowserRequestRecord,
    fixture: Fixture,
    origin: string,
): boolean {
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return false;
    }
    return (
        request.origin === origin &&
        url.origin === origin &&
        request.method === 'GET' &&
        url.pathname === '/api/sessions' &&
        url.searchParams.get('coder') === 'pi' &&
        url.searchParams.get('cwd') === fixture.cwd &&
        url.searchParams.get('offset') === '0' &&
        request.phase === 'injected-session-failure' &&
        request.onlineAtStart &&
        request.injectedResponse?.status === 500 &&
        request.injectedResponse.body === SESSION_REFRESH_FAILURE &&
        request.response?.status === 500
    );
}

async function classifyExpectedDiagnostics(
    fixture: Fixture,
    diagnostics: Diagnostics[],
): Promise<void> {
    await classifyKnownPinFailures(fixture, diagnostics);
    await classifyKnownWorktreeStateFailures(fixture, diagnostics);
    const seededIds = new Set(fixture.shellTabs.map((tab) => tab.id));
    for (const item of diagnostics) {
        const requestsById = new Map(
            item.requestRecords.map((request) => [request.requestId, request]),
        );
        const injectedRequests = item.requestRecords.filter((request) =>
            isExpectedInjectedSessionRequest(request, fixture, item.origin),
        );
        for (const entry of item.entries) {
            if (entry.classification) continue;
            const request =
                entry.requestId === undefined || entry.requestId === null
                    ? undefined
                    : requestsById.get(entry.requestId);
            if (
                entry.kind === 'request-failed' &&
                entry.phase === 'offline' &&
                request?.phase === 'offline' &&
                !request.onlineAtStart &&
                request.origin === item.origin &&
                OFFLINE_NETWORK_ERRORS.has(entry.message)
            ) {
                entry.classification = 'offline-network-disconnection';
                continue;
            }
            if (
                entry.kind === 'console-error' &&
                (entry.phase === 'offline' || entry.phase === 'recovery') &&
                entry.message ===
                    'Failed to load resource: net::ERR_INTERNET_DISCONNECTED' &&
                entry.url?.startsWith(`${item.origin}/`) &&
                item.requestRecords.some(
                    (candidate) =>
                        candidate.url === entry.url &&
                        candidate.phase === 'offline' &&
                        !candidate.onlineAtStart &&
                        candidate.terminal?.kind === 'failed' &&
                        candidate.terminal.errorText ===
                            'net::ERR_INTERNET_DISCONNECTED',
                )
            ) {
                entry.classification = 'offline-network-resource-error';
                continue;
            }
            if (
                entry.kind === 'console-error' &&
                entry.phase === 'offline' &&
                [...seededIds].some(
                    (paneId) =>
                        entry.message ===
                        `[ws] Connection error for pane: ${paneId}`,
                )
            ) {
                entry.classification = 'offline-pane-disconnection';
                continue;
            }
            if (
                entry.kind === 'console-error' &&
                entry.phase === 'offline' &&
                entry.message.startsWith(
                    '[term] Failed to sync pin on backend:',
                )
            ) {
                const matchingPins = item.pinRequests.filter(
                    (pin) =>
                        pin.phase === 'offline' &&
                        !pin.onlineAtStart &&
                        pin.terminal?.kind === 'failed' &&
                        seededIds.has(parsePinPath(pin.url) ?? ''),
                );
                if (matchingPins.length > 0) {
                    entry.relatedRequestIds = matchingPins.map(
                        (pin) => pin.requestId,
                    );
                    entry.classification = 'offline-pin-sync-error';
                }
                continue;
            }
            if (
                entry.kind === 'http-error' &&
                request &&
                injectedRequests.includes(request) &&
                entry.message === 'HTTP 500'
            ) {
                entry.classification = 'injected-session-refresh-500';
                continue;
            }
            if (
                entry.kind === 'console-error' &&
                entry.phase === 'injected-session-failure' &&
                entry.message.includes('Failed to load resource') &&
                entry.message.includes('500')
            ) {
                const matching = injectedRequests.find(
                    (candidate) =>
                        entry.url === candidate.url ||
                        entry.message.includes(candidate.url),
                );
                if (matching) {
                    entry.requestId = matching.requestId;
                    entry.classification =
                        'injected-session-refresh-resource-error';
                }
            }
        }
    }
}

function unexpectedDiagnostics(diagnostics: Diagnostics[]): Diagnostic[] {
    const knownIds = new Set(
        diagnostics.flatMap((item) =>
            item.pinRequests
                .filter(
                    (request) =>
                        request.classification === 'known-pin-completion',
                )
                .map((request) => request.requestId),
        ),
    );
    return diagnostics.flatMap((item) =>
        item.entries.filter(
            (entry) =>
                !entry.classification &&
                !(
                    entry.kind === 'request-failed' &&
                    entry.message === 'net::ERR_ABORTED' &&
                    entry.requestId !== undefined &&
                    entry.requestId !== null &&
                    knownIds.has(entry.requestId)
                ),
        ),
    );
}

async function assertClean(
    diagnostics: Diagnostics[],
    fixture: Fixture,
): Promise<void> {
    expect(
        diagnostics.flatMap((item) =>
            item.pinRequests.filter(
                (request) => !hasExactPinnedBody(request.body),
            ),
        ),
    ).toEqual([]);
    await expect
        .poll(
            () =>
                diagnostics.every((item) =>
                    item.requestRecords.every(
                        (request) => request.terminal !== undefined,
                    ),
                ),
            { timeout: 5000, intervals: [50, 100, 250] },
        )
        .toBe(true);
    await classifyExpectedDiagnostics(fixture, diagnostics);
    expect(unexpectedDiagnostics(diagnostics)).toEqual([]);
}

async function openMobileSessions(page: Page): Promise<void> {
    await page.locator('#mobile-sidebar-toggle').tap();
    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await page.locator('#drawer-open-sessions').tap();
    await page.locator('#coder-selector .coder-tab[data-coder="pi"]').tap();
}

async function closeAndUndoTab(
    page: Page,
    list: ReturnType<Page['locator']>,
    paneId: string,
    title: string,
    touch: boolean,
): Promise<void> {
    const row = list.locator(
        `.hostname-dropdown-row[data-pane-id="${paneId}"]`,
    );
    const close = row.locator('.hostname-dropdown-close-btn');
    if (touch) await close.tap();
    else await close.click();

    const closingRow = list.locator(
        `.tab-overflow-closing-row[data-pane-id="${paneId}"]`,
    );
    await expect(closingRow).toBeVisible({ timeout: 1000 });
    const undo = closingRow.locator('.hostname-dropdown-close-btn');
    await expect(undo).toHaveAttribute('aria-label', `Undo close ${title}`, {
        timeout: 1000,
    });
    if (touch) await undo.tap();
    else await undo.click();
    await expect(
        page.locator(`#tabs-container .tab[data-pane-id="${paneId}"]`),
    ).not.toHaveClass(/soft-closed/, { timeout: 1000 });
}

async function inspectLongWorktreeHeader(
    page: Page,
    fixture: Fixture,
    viewport: { width: number; height: number },
    geometry: GeometryArtifact[],
): Promise<void> {
    const longPath = fixture.longWorktreePath;
    expect(longPath).toBeTruthy();
    const section = page
        .locator('.worktree-section')
        .filter({ hasText: LONG_WORKTREE_NAME });
    await expect(section).toHaveCount(1);
    const name = section.locator('.worktree-name');
    const branch = section.locator('.worktree-branch');
    const dirty = section.locator('.worktree-dirty-indicator');
    await expect(name).toHaveText(LONG_WORKTREE_NAME);
    await expect(branch).toHaveText(
        `[${LONG_BRANCH.slice(LONG_BRANCH.lastIndexOf('/') + 1)}]`,
    );
    await expect(dirty).toBeVisible({ timeout: 5000 });
    await section.scrollIntoViewIfNeeded();

    const result = await section
        .locator('.worktree-header')
        .evaluate(async (header) => {
            await document.fonts.ready;
            const panel = header.closest('#sidebar-panel');
            await Promise.all(
                (panel?.getAnimations({ subtree: true }) ?? [])
                    .filter(
                        (animation) =>
                            animation.effect?.getComputedTiming().iterations !==
                            Number.POSITIVE_INFINITY,
                    )
                    .map((animation) => animation.finished.catch(() => {})),
            );
            const rect = (element: Element | null) => {
                if (!element)
                    throw new Error('missing worktree header control');
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                const metrics = element as HTMLElement;
                return {
                    left: box.left,
                    right: box.right,
                    top: box.top,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                    clientWidth: metrics.clientWidth,
                    scrollWidth: metrics.scrollWidth,
                    clientHeight: metrics.clientHeight,
                    scrollHeight: metrics.scrollHeight,
                    whiteSpace: style.whiteSpace,
                    overflowWrap: style.overflowWrap,
                };
            };
            return {
                header: rect(header),
                chevron: rect(header.querySelector('.chevron-icon')),
                glyph: rect(header.querySelector('.worktree-glyph-cell')),
                name: rect(header.querySelector('.worktree-name')),
                branch: rect(header.querySelector('.worktree-branch')),
                dirty: rect(header.querySelector('.worktree-dirty-indicator')),
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    coarse: matchMedia('(pointer: coarse)').matches,
                },
            };
        });
    expect(result.viewport.width).toBe(viewport.width);
    expect(result.viewport.height).toBe(viewport.height);
    expect(result.viewport.coarse).toBe(true);
    expect(result.header.left).toBeGreaterThanOrEqual(0);
    expect(result.header.right).toBeLessThanOrEqual(viewport.width);
    expect(result.header.bottom).toBeLessThanOrEqual(viewport.height);
    expect(result.header.scrollWidth).toBeLessThanOrEqual(
        result.header.clientWidth + 1,
    );
    for (const control of [result.chevron, result.glyph, result.dirty])
        expect(control.width).toBeGreaterThan(0);
    for (const label of [result.name, result.branch]) {
        expect(label.width).toBeGreaterThan(0);
        expect(label.whiteSpace).toBe('normal');
        expect(label.overflowWrap).toBe('anywhere');
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
        expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight + 1);
        expect(label.height).toBeGreaterThan(20);
    }
    geometry.push({
        label: 'mobile long worktree header',
        viewport,
        value: result,
    });
}

async function waitForStartupPins(
    fixture: Fixture,
    diagnostics: Diagnostics,
): Promise<void> {
    const seededIds = fixture.shellTabs.map((tab) => tab.id);
    await expect
        .poll(
            () =>
                seededIds.every((id) =>
                    diagnostics.pinRequests.some(
                        (request) =>
                            parsePinPath(request.url) === id &&
                            hasExactPinnedBody(request.body) &&
                            request.terminal !== undefined,
                    ),
                ),
            { timeout: 5000, intervals: [50, 100, 250] },
        )
        .toBe(true);
}

async function openPage(
    browser: Browser,
    fixture: Fixture,
    contexts: BrowserContext[],
    diagnostics: Diagnostics[],
    viewport: { width: number; height: number },
    touch = false,
    label = touch ? 'mobile' : 'desktop',
): Promise<Page> {
    const context = await browser.newContext({
        viewport,
        ...(touch ? { isMobile: true, hasTouch: true } : {}),
    });
    contexts.push(context);
    const page = await context.newPage();
    const tracker = await installDiagnostics(context, page, fixture.phi, label);
    diagnostics.push(tracker);
    await page.goto(fixture.phi.url);
    await expect(page.locator('#tabs-container .tab')).toHaveCount(
        fixture.shellTabs.length,
        { timeout: 30_000 },
    );
    for (const tab of fixture.shellTabs) {
        await expect(
            page.locator(`#tabs-container .tab[data-pane-id="${tab.id}"]`),
        ).toHaveCount(1);
    }
    await waitForStartupPins(fixture, tracker);
    await assertClean([tracker], fixture);
    return page;
}

async function measureText(
    locator: ReturnType<Page['locator']>,
    expected: string,
    wrapped = true,
) {
    const geometry = await locator.evaluate(async (element) => {
        await document.fonts.ready;
        const root =
            element.closest('#sidebar-panel') ??
            element.closest(
                '.tab-overflow-dropdown, .drawer-tabs-body, .hostname-tabs-dropdown, .session-list-container',
            ) ??
            element.parentElement;
        const animations = root ? root.getAnimations({ subtree: true }) : [];
        await Promise.all(
            animations
                .filter(
                    (animation) =>
                        animation.effect?.getComputedTiming().iterations !==
                        Number.POSITIVE_INFINITY,
                )
                .map((animation) => animation.finished.catch(() => {})),
        );
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
            text: element.textContent,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            rect: {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
            },
        };
    });
    expect(geometry.text).toBe(expected);
    expect(geometry.whiteSpace).toBe('normal');
    expect(geometry.overflowWrap).toBe('anywhere');
    expect(geometry.clientWidth).toBeGreaterThan(0);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(
        geometry.clientHeight + 1,
    );
    if (wrapped) expect(geometry.rect.height).toBeGreaterThan(20);
    else expect(geometry.rect.height).toBeLessThanOrEqual(20);
    return geometry;
}

async function selectOtherTab(
    page: Page,
    list: ReturnType<Page['locator']>,
    activate: 'click' | 'tap' | 'enter',
    timeoutMs?: number,
): Promise<string> {
    const activeBefore = await page
        .locator('#tabs-container .tab.active')
        .getAttribute('data-pane-id');
    const ids = await list
        .locator('.hostname-dropdown-row')
        .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute('data-pane-id') ?? ''),
        );
    const targetId = ids.find((id) => id !== activeBefore);
    expect(targetId).toBeTruthy();
    const button = list.locator(
        `.hostname-dropdown-row[data-pane-id="${targetId}"] .hostname-dropdown-select-btn`,
    );
    const actionOptions =
        timeoutMs === undefined ? undefined : { timeout: timeoutMs };
    if (activate === 'enter') {
        await button.focus(actionOptions);
        await page.keyboard.press('Enter');
    } else if (activate === 'tap') {
        await button.tap(actionOptions);
    } else {
        await button.click(actionOptions);
    }
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        targetId as string,
        actionOptions,
    );
    await expect(page.locator('.term-container.active')).toHaveAttribute(
        'id',
        `term-${targetId}`,
        actionOptions,
    );
    return targetId as string;
}

function isPiFirstPageRequest(
    request: Request,
    fixture: Fixture,
    origin: string,
): boolean {
    const url = new URL(request.url());
    return (
        url.origin === origin &&
        request.method() === 'GET' &&
        url.pathname === '/api/sessions' &&
        url.searchParams.get('coder') === 'pi' &&
        url.searchParams.get('cwd') === fixture.cwd &&
        url.searchParams.get('offset') === '0'
    );
}

async function recordWorktreeStateReadback(
    postResponse: Response,
    fixture: Fixture,
    diagnostics: Diagnostics,
    expectedExpanded: boolean,
): Promise<void> {
    const requestRecord = diagnostics.getRequestRecord(postResponse.request());
    if (!requestRecord) throw new Error('worktree-state POST is not tracked');
    const requestUrl = new URL('/api/git/worktrees', fixture.phi.url);
    requestUrl.searchParams.set('cwd', fixture.cwd);
    const stateResponse = await fetch(requestUrl, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    let worktrees: unknown;
    if (stateResponse.status === 200) {
        try {
            worktrees = await stateResponse.json();
        } catch {
            worktrees = undefined;
        }
    }
    const items = Array.isArray(worktrees)
        ? (worktrees as Array<Record<string, unknown>>)
        : [];
    const worktree = items.find((item) => item.path === fixture.cwd);
    const snapshot: WorktreeStateSnapshot = {
        method: 'GET',
        url: requestUrl.href,
        responseUrl: stateResponse.url,
        status: stateResponse.status,
        cwd: fixture.cwd,
        path: typeof worktree?.path === 'string' ? worktree.path : null,
        expanded:
            typeof worktree?.expanded === 'boolean' ? worktree.expanded : null,
        redirected: stateResponse.redirected,
    };
    requestRecord.worktreeStateSnapshot = snapshot;
    expect(snapshot.status).toBe(200);
    expect(snapshot.cwd).toBe(fixture.cwd);
    expect(snapshot.path).toBe(fixture.cwd);
    expect(snapshot.expanded).toBe(expectedExpanded);
    expect(snapshot.redirected).toBe(false);
    expect(snapshot.responseUrl).toBe(snapshot.url);
}

function isWorktreeStateResponse(
    response: Response,
    fixture: Fixture,
    expanded: boolean,
): boolean {
    const request = response.request();
    const url = new URL(response.url());
    if (
        response.status() !== 200 ||
        request.method() !== 'POST' ||
        url.origin !== new URL(fixture.phi.url).origin ||
        url.pathname !== '/api/config/worktree-state'
    )
        return false;
    try {
        const body = JSON.parse(request.postData() ?? 'null') as {
            workspace?: string;
            expanded?: Record<string, boolean>;
        };
        return (
            body.workspace === fixture.cwd &&
            body.expanded?.[fixture.cwd] === expanded
        );
    } catch {
        return false;
    }
}

async function applyAccent(
    page: Page,
    color: 'purple' | 'white',
): Promise<void> {
    const accent = await page.evaluate(
        `(async () => { const theme = await import('/theme.js'); return theme.applyThemeTokens('${color}').accent; })()`,
    );
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    await expect(page.locator('html')).toHaveAttribute(
        'data-theme-color',
        color,
    );
}

async function saveScreenshot(
    page: Page,
    testInfo: TestInfo,
    name: string,
): Promise<void> {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function withFixture(
    testInfo: TestInfo,
    run: (
        fixture: Fixture,
        contexts: BrowserContext[],
        diagnostics: Diagnostics[],
        geometry: GeometryArtifact[],
    ) => Promise<void>,
    options: FixtureOptions = {},
): Promise<void> {
    const fixture = await startFixture(options);
    const contexts: BrowserContext[] = [];
    const diagnostics: Diagnostics[] = [];
    const geometry: GeometryArtifact[] = [];
    let runFailed = false;
    let runError: unknown;
    try {
        await run(fixture, contexts, diagnostics, geometry);
    } catch (error) {
        runFailed = true;
        runError = error;
    }

    const cleanupErrors: unknown[] = [];
    for (const item of diagnostics) item.setPhase('teardown', false);
    for (const context of contexts) {
        try {
            await context.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    const teardownDiagnostics = unexpectedDiagnostics(diagnostics);
    if (teardownDiagnostics.length > 0) {
        cleanupErrors.push(
            new Error(
                `unexpected teardown diagnostics: ${JSON.stringify(teardownDiagnostics)}`,
            ),
        );
    }

    try {
        const geometryPath = testInfo.outputPath('geometry.json');
        writeFileSync(geometryPath, JSON.stringify(geometry, null, 2));
        await testInfo.attach('geometry.json', {
            path: geometryPath,
            contentType: 'application/json',
        });
        const diagnosticsPath = testInfo.outputPath('diagnostics.json');
        writeFileSync(
            diagnosticsPath,
            JSON.stringify(
                diagnostics.map((item) => ({
                    label: item.label,
                    origin: item.origin,
                    entries: item.entries,
                    requests: item.requestRecords,
                    pinRequests: item.pinRequests,
                })),
                null,
                2,
            ),
        );
        await testInfo.attach('diagnostics.json', {
            path: diagnosticsPath,
            contentType: 'application/json',
        });
        if (existsSync(fixture.phi.logPath)) {
            const serverLogPath = testInfo.outputPath('owned-server.log');
            writeFileSync(serverLogPath, readFileSync(fixture.phi.logPath));
            await testInfo.attach('owned-server.log', {
                path: serverLogPath,
                contentType: 'text/plain',
            });
        }
    } catch (error) {
        cleanupErrors.push(error);
    }

    try {
        await fixture.phi.stop();
    } catch (error) {
        cleanupErrors.push(error);
    }
    if (existsSync(fixture.phi.dir)) {
        cleanupErrors.push(
            new Error(
                `fixture directory remains after stop: ${fixture.phi.dir}`,
            ),
        );
    }
    if (runFailed && cleanupErrors.length > 0) {
        throw new AggregateError(
            [runError, ...cleanupErrors],
            'test failed and fixture cleanup reported errors',
        );
    }
    if (runFailed) throw runError;
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'fixture cleanup failed');
    }
}

test('MVP desktop tab lists', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(
        testInfo,
        async (fixture, contexts, diagnostics, geometry) => {
            const viewport = { width: 1440, height: 900 };
            const page = await openPage(
                browser,
                fixture,
                contexts,
                diagnostics,
                viewport,
                false,
                'desktop-tabs',
            );

            await page.locator('#tab-overflow-btn').click();
            const groupedList = page.locator('#tab-overflow-dropdown');
            await expect(groupedList).toBeVisible();
            const groupedTitle = groupedList
                .locator('.hostname-dropdown-title')
                .filter({ hasText: LONG_TITLE });
            geometry.push({
                label: 'desktop grouped tab list',
                viewport,
                value: await measureText(groupedTitle, LONG_TITLE),
            });
            await saveScreenshot(page, testInfo, 'desktop-mvp.png');
            await selectOtherTab(page, groupedList, 'click');

            await page.locator('#hostname-display').click();
            const brandList = page.locator('#hostname-tabs-dropdown');
            await expect(brandList).toBeVisible();
            const brandTitle = brandList
                .locator('.hostname-dropdown-title')
                .filter({ hasText: LONG_TITLE });
            geometry.push({
                label: 'desktop brand tab list',
                viewport,
                value: await measureText(brandTitle, LONG_TITLE),
            });
            await saveScreenshot(page, testInfo, 'desktop-brand-mvp.png');
            await selectOtherTab(page, brandList, 'enter');
            await assertClean(diagnostics, fixture);
        },
    );
});

test('MVP touch titles and review', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(
        testInfo,
        async (fixture, contexts, diagnostics, geometry) => {
            const viewport = { width: 390, height: 844 };
            const tabPage = await openPage(
                browser,
                fixture,
                contexts,
                diagnostics,
                viewport,
                true,
                'mobile-tabs',
            );
            const compact = await tabPage.evaluate(() => ({
                width: window.innerWidth,
                coarse: matchMedia('(pointer: coarse)').matches,
            }));
            expect(compact).toEqual({ width: 390, coarse: true });

            await tabPage.locator('#mobile-sidebar-toggle').tap();
            const drawerTabs = tabPage.locator('#drawer-tabs-body');
            await expect(drawerTabs).toBeVisible();
            const drawerTitle = drawerTabs
                .locator('.hostname-dropdown-title')
                .filter({ hasText: LONG_TITLE });
            geometry.push({
                label: 'mobile drawer tab list',
                viewport,
                value: await measureText(drawerTitle, LONG_TITLE),
            });
            await selectOtherTab(tabPage, drawerTabs, 'tap');
            await assertClean(diagnostics, fixture);

            const sessionPage = await openPage(
                browser,
                fixture,
                contexts,
                diagnostics,
                viewport,
                true,
                'mobile-sessions',
            );
            const sessionCompact = await sessionPage.evaluate(() => ({
                width: window.innerWidth,
                coarse: matchMedia('(pointer: coarse)').matches,
            }));
            expect(sessionCompact).toEqual({ width: 390, coarse: true });
            await sessionPage.locator('#mobile-sidebar-toggle').tap();
            await expect(sessionPage.locator('#sidebar-panel')).toHaveClass(
                /drawer-open/,
            );
            await sessionPage.locator('#drawer-open-sessions').tap();
            await sessionPage
                .locator('#coder-selector .coder-tab[data-coder="pi"]')
                .tap();
            const session = sessionPage.locator(
                '.session-item[data-session-id="fixture-session-long"]',
            );
            await expect(session).toBeVisible({ timeout: 30_000 });
            const sessionTitle = session.locator('.session-title');
            const titleGeometry = await measureText(sessionTitle, LONG_TITLE);
            const action = session.locator('.session-actions');
            const review = action.locator('.review-btn');
            await expect(review).toBeVisible();
            const actionStyle = await action.evaluate((element) => ({
                opacity: getComputedStyle(element).opacity,
                pointerEvents: getComputedStyle(element).pointerEvents,
            }));
            expect(actionStyle).toEqual({
                opacity: '1',
                pointerEvents: 'auto',
            });
            const rowGeometry = await session.evaluate((element) => {
                const rect = (selector: string) => {
                    const node = element.querySelector(selector);
                    if (!node) throw new Error(`missing ${selector}`);
                    const { left, right, top, bottom, width, height } =
                        node.getBoundingClientRect();
                    return { left, right, top, bottom, width, height };
                };
                return {
                    title: rect('.session-title'),
                    time: rect('.session-time'),
                    actions: rect('.session-actions'),
                };
            });
            const overlaps = (
                a: { left: number; right: number; top: number; bottom: number },
                b: { left: number; right: number; top: number; bottom: number },
            ) =>
                a.left < b.right &&
                a.right > b.left &&
                a.top < b.bottom &&
                a.bottom > b.top;
            expect(overlaps(rowGeometry.title, rowGeometry.time)).toBe(false);
            expect(overlaps(rowGeometry.title, rowGeometry.actions)).toBe(
                false,
            );
            expect(overlaps(rowGeometry.time, rowGeometry.actions)).toBe(false);
            geometry.push({
                label: 'mobile session title and actions',
                viewport,
                value: { title: titleGeometry, row: rowGeometry },
            });
            await saveScreenshot(sessionPage, testInfo, 'mobile-mvp.png');

            const initialTabCount = await sessionPage
                .locator('#tabs-container .tab')
                .count();
            const sessionPath = fixture.sessionPaths.get(
                'fixture-session-long',
            );
            expect(sessionPath).toBeTruthy();
            await review.tap();
            const rpcPaneId = `pi-rpc:session:${encodeURIComponent(sessionPath as string)}`;
            await expect(
                sessionPage.locator('#tabs-container .tab'),
            ).toHaveCount(initialTabCount + 1, { timeout: 30_000 });
            await expect(
                sessionPage.locator('#tabs-container .tab.active'),
            ).toHaveAttribute('data-pane-id', rpcPaneId, { timeout: 30_000 });
            await expect(sessionPage.locator('#sidebar-panel')).not.toHaveClass(
                /drawer-open/,
            );
            await assertClean(diagnostics, fixture);
        },
    );
});

const EDGE_VIEWPORTS = [
    { width: 320, height: 844 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
];

for (const viewport of EDGE_VIEWPORTS) {
    test(`edge touch labels ${viewport.width}x${viewport.height}`, async ({
        browser,
    }, testInfo) => {
        test.setTimeout(120_000);
        await withFixture(
            testInfo,
            async (fixture, contexts, diagnostics, geometry) => {
                const tabPage = await openPage(
                    browser,
                    fixture,
                    contexts,
                    diagnostics,
                    viewport,
                    true,
                    'edge-mobile-tabs',
                );
                const tabViewport = await tabPage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight,
                    coarse: matchMedia('(pointer: coarse)').matches,
                }));
                expect(tabViewport).toEqual({ ...viewport, coarse: true });
                await tabPage.locator('#mobile-sidebar-toggle').tap();
                const drawerTabs = tabPage.locator('#drawer-tabs-body');
                await expect(drawerTabs).toBeVisible();
                const drawerWidth = await drawerTabs.evaluate((element) => ({
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                }));
                expect(drawerWidth.scrollWidth).toBeLessThanOrEqual(
                    drawerWidth.clientWidth + 1,
                );
                for (const title of [LONG_UNBROKEN_TITLE, UNICODE_TITLE]) {
                    const locator = drawerTabs
                        .locator('.hostname-dropdown-title')
                        .filter({ hasText: title });
                    geometry.push({
                        label: `mobile ${viewport.width} tab title`,
                        viewport,
                        value: await measureText(locator, title),
                    });
                }
                const shortTabTitle = drawerTabs
                    .locator('.hostname-dropdown-title')
                    .filter({ hasText: SHORT_TITLE });
                geometry.push({
                    label: `mobile ${viewport.width} short tab title`,
                    viewport,
                    value: await measureText(shortTabTitle, SHORT_TITLE, false),
                });
                await selectOtherTab(tabPage, drawerTabs, 'tap');
                if (viewport.width === 390) {
                    await tabPage.locator('#mobile-sidebar-toggle').tap();
                    await expect(drawerTabs).toBeVisible();
                    await closeAndUndoTab(
                        tabPage,
                        drawerTabs,
                        'fixture-short',
                        SHORT_TITLE,
                        true,
                    );
                }
                await assertClean(diagnostics, fixture);

                const sessionPage = await openPage(
                    browser,
                    fixture,
                    contexts,
                    diagnostics,
                    viewport,
                    true,
                    'edge-mobile-sessions',
                );
                const sessionViewport = await sessionPage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight,
                    coarse: matchMedia('(pointer: coarse)').matches,
                }));
                expect(sessionViewport).toEqual({ ...viewport, coarse: true });
                await openMobileSessions(sessionPage);
                const sessionContainer = sessionPage.locator(
                    '#sidebar-panel.drawer-open .session-list-container',
                );
                const sessionWidth = await sessionContainer.evaluate(
                    (element) => ({
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                    }),
                );
                expect(sessionWidth.scrollWidth).toBeLessThanOrEqual(
                    sessionWidth.clientWidth + 1,
                );
                await inspectLongWorktreeHeader(
                    sessionPage,
                    fixture,
                    viewport,
                    geometry,
                );
                for (const sessionInfo of [
                    {
                        id: 'fixture-session-short',
                        title: SHORT_TITLE,
                        wrapped: false,
                    },
                    {
                        id: 'fixture-session-unbroken',
                        title: LONG_UNBROKEN_TITLE,
                    },
                    {
                        id: 'fixture-session-unicode',
                        title: UNICODE_TITLE,
                    },
                ]) {
                    const row = sessionPage.locator(
                        `.session-item[data-session-id="${sessionInfo.id}"]`,
                    );
                    await expect(row).toBeVisible({ timeout: 30_000 });
                    await row.scrollIntoViewIfNeeded();
                    const titleGeometry = await measureText(
                        row.locator('.session-title'),
                        sessionInfo.title,
                        sessionInfo.wrapped ?? true,
                    );
                    const review = row.locator('.session-actions .review-btn');
                    await expect(review).toBeVisible();
                    const rowBox = await row.boundingBox();
                    const reviewBox = await review.boundingBox();
                    if (!rowBox || !reviewBox)
                        throw new Error(
                            'session row or Review button is offscreen',
                        );
                    expect(rowBox.y).toBeGreaterThanOrEqual(0);
                    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
                        viewport.height,
                    );
                    expect(reviewBox.x).toBeGreaterThanOrEqual(0);
                    expect(reviewBox.x + reviewBox.width).toBeLessThanOrEqual(
                        viewport.width,
                    );
                    expect(reviewBox.y).toBeGreaterThanOrEqual(0);
                    expect(reviewBox.y + reviewBox.height).toBeLessThanOrEqual(
                        viewport.height,
                    );
                    geometry.push({
                        label: `mobile ${viewport.width} session title and Review action`,
                        viewport,
                        value: {
                            title: titleGeometry,
                            row: rowBox,
                            review: reviewBox,
                        },
                    });
                }
                if (viewport.width === 320) {
                    await saveScreenshot(
                        sessionPage,
                        testInfo,
                        'mobile-320.png',
                    );
                } else if (viewport.height === 390) {
                    await saveScreenshot(
                        sessionPage,
                        testInfo,
                        'mobile-landscape.png',
                    );
                } else {
                    await applyAccent(sessionPage, 'purple');
                    await saveScreenshot(
                        sessionPage,
                        testInfo,
                        'mobile-purple.png',
                    );
                    await applyAccent(sessionPage, 'white');
                    await saveScreenshot(
                        sessionPage,
                        testInfo,
                        'mobile-white.png',
                    );
                }
                await assertClean(diagnostics, fixture);
            },
            {
                shellTabs: EDGE_TABS,
                piSessions: EDGE_SESSIONS,
                longWorktree: true,
            },
        );
    });
}

test('edge desktop brand scroll and controls', async ({
    browser,
}, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(
        testInfo,
        async (fixture, contexts, diagnostics, geometry) => {
            const viewport = { width: 1440, height: 900 };
            const page = await openPage(
                browser,
                fixture,
                contexts,
                diagnostics,
                viewport,
                false,
                'edge-desktop-brand',
            );
            await page.locator('#tab-overflow-btn').click();
            const overflow = page.locator('#tab-overflow-dropdown');
            await expect(overflow).toBeVisible();
            await closeAndUndoTab(
                page,
                overflow,
                'fixture-scroll-1',
                'Scrollable tab 1',
                false,
            );

            await page.locator('#hostname-display').click();
            const brandList = page.locator('#hostname-tabs-dropdown');
            await expect(brandList).toBeVisible();
            const menuGeometry = await brandList.evaluate((menu) => ({
                clientHeight: menu.clientHeight,
                scrollHeight: menu.scrollHeight,
                overflowY: getComputedStyle(menu).overflowY,
                maxHeight: getComputedStyle(menu).maxHeight,
            }));
            expect(menuGeometry.scrollHeight).toBeGreaterThan(
                menuGeometry.clientHeight,
            );
            expect(menuGeometry.overflowY).toBe('auto');
            expect(menuGeometry.maxHeight).toBe('540px');

            const longPath = fixture.longWorktreePath;
            expect(longPath).not.toBeNull();
            if (!longPath) throw new Error('long worktree fixture is missing');
            const expectedMeta = `${basename(dirname(longPath))}/${basename(longPath)}`;
            const longRow = brandList.locator(
                '.hostname-dropdown-row[data-pane-id="fixture-scroll-long"]',
            );
            const longTitle = longRow.locator('.hostname-dropdown-title');
            geometry.push({
                label: 'desktop brand long title',
                viewport,
                value: await measureText(longTitle, LONG_TITLE),
            });
            const metadata = longRow.locator('.hostname-dropdown-meta');
            await expect(metadata).toHaveText(expectedMeta);
            geometry.push({
                label: 'desktop brand worktree metadata',
                viewport,
                value: await measureText(metadata, expectedMeta),
            });
            const emptyTitle = brandList.locator(
                '.hostname-dropdown-row[data-pane-id="fixture-scroll-empty"] .hostname-dropdown-title',
            );
            await expect(emptyTitle).toHaveText('bash');
            geometry.push({
                label: 'desktop brand empty-title fallback',
                viewport,
                value: await measureText(emptyTitle, 'bash', false),
            });

            await applyAccent(page, 'purple');
            await saveScreenshot(page, testInfo, 'desktop-purple.png');
            await applyAccent(page, 'white');
            await saveScreenshot(page, testInfo, 'desktop-white.png');

            const lastRow = brandList.locator('.hostname-dropdown-row').last();
            await lastRow.scrollIntoViewIfNeeded();
            const lastClose = lastRow.locator('.hostname-dropdown-close-btn');
            const lastCloseBox = await lastClose.boundingBox();
            if (!lastCloseBox)
                throw new Error('last close control is not visible');
            await lastClose.focus();
            await page.keyboard.press('Shift+Tab');
            const focusedPin = lastRow.locator('.hostname-dropdown-pin-btn');
            await expect(focusedPin).toBeFocused();
            const scrollAccess = await focusedPin.evaluate((button) => {
                const menu = button.closest('.hostname-tabs-dropdown');
                if (!menu) throw new Error('brand menu is missing');
                const menuRect = menu.getBoundingClientRect();
                const buttonRect = button.getBoundingClientRect();
                return {
                    scrollTop: menu.scrollTop,
                    menu: {
                        top: menuRect.top,
                        bottom: menuRect.bottom,
                    },
                    button: {
                        top: buttonRect.top,
                        bottom: buttonRect.bottom,
                    },
                    focusStyle: getComputedStyle(button).boxShadow,
                };
            });
            expect(scrollAccess.scrollTop).toBeGreaterThan(0);
            expect(scrollAccess.button.top).toBeGreaterThanOrEqual(
                scrollAccess.menu.top,
            );
            expect(lastCloseBox.y).toBeGreaterThanOrEqual(
                scrollAccess.menu.top,
            );
            expect(lastCloseBox.y + lastCloseBox.height).toBeLessThanOrEqual(
                scrollAccess.menu.bottom,
            );
            expect(scrollAccess.button.bottom).toBeLessThanOrEqual(
                scrollAccess.menu.bottom,
            );
            expect(scrollAccess.focusStyle).not.toBe('none');

            const closeRow = brandList.locator(
                '.hostname-dropdown-row[data-pane-id="fixture-scroll-long"]',
            );
            const closeButton = closeRow.locator(
                '.hostname-dropdown-close-btn',
            );
            await closeButton.scrollIntoViewIfNeeded();
            await closeButton.focus();
            await expect(closeButton).toBeFocused();
            const dialogPromise = page.waitForEvent('dialog');
            const enterPromise = page.keyboard.press('Enter');
            const dialog = await dialogPromise;
            expect(dialog.type()).toBe('confirm');
            await dialog.accept();
            await enterPromise;
            const closedTab = page.locator(
                '#tabs-container .tab[data-pane-id="fixture-scroll-long"]',
            );
            await expect(closedTab).toHaveClass(/soft-closed/, {
                timeout: 1000,
            });
            const undoToast = page
                .locator('#toast-container .toast')
                .filter({ hasText: `Closed "${LONG_TITLE}"` })
                .locator('.toast-action-btn');
            await expect(undoToast).toHaveCount(1, { timeout: 1000 });
            await expect(undoToast).toBeVisible({ timeout: 1000 });
            await undoToast.click();
            await expect(closedTab).not.toHaveClass(/soft-closed/, {
                timeout: 1000,
            });

            await page.locator('#hostname-display').click();
            await page
                .locator('#coder-selector .coder-tab[data-coder="pi"]')
                .click();
            const desktopSessionTitle = page.locator(
                '.session-item[data-session-id="fixture-session-long"] .session-title',
            );
            await expect(desktopSessionTitle).toBeVisible({ timeout: 30_000 });
            expect(
                await desktopSessionTitle.evaluate(
                    (element) => getComputedStyle(element).whiteSpace,
                ),
            ).toBe('nowrap');
            expect(
                await page
                    .locator('#tabs-container .tab-title')
                    .first()
                    .evaluate(
                        (element) => getComputedStyle(element).whiteSpace,
                    ),
            ).toBe('nowrap');
            await assertClean(diagnostics, fixture);
        },
        {
            shellTabs: SCROLL_TABS,
            longWorktree: true,
            tabCwd: 'long-worktree',
        },
    );
});

test('edge touch no branch or sessions', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(
        testInfo,
        async (fixture, contexts, diagnostics, geometry) => {
            const viewport = { width: 390, height: 844 };
            const page = await openPage(
                browser,
                fixture,
                contexts,
                diagnostics,
                viewport,
                true,
                'mobile-empty-sessions',
            );
            await openMobileSessions(page);
            const section = page
                .locator('.worktree-section')
                .filter({ hasText: 'workspace' });
            await expect(section).toHaveCount(1);
            const name = section.locator('.worktree-name');
            await expect(name).toHaveText('workspace');
            await expect(section.locator('.worktree-branch')).toHaveCount(0);
            await expect(page.locator('.no-sessions-found')).toBeVisible({
                timeout: 30_000,
            });
            await expect(page.locator('.session-item')).toHaveCount(0);
            await expect(page.locator('.session-actions')).toHaveCount(0);
            const header = section.locator('.worktree-header');
            await header.scrollIntoViewIfNeeded();
            const result = await header.evaluate((element) => {
                const nameElement = element.querySelector('.worktree-name');
                if (!nameElement) throw new Error('worktree name is missing');
                return {
                    header: {
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                    },
                    name: {
                        text: nameElement.textContent,
                        clientWidth: nameElement.clientWidth,
                        scrollWidth: nameElement.scrollWidth,
                        clientHeight: nameElement.clientHeight,
                        scrollHeight: nameElement.scrollHeight,
                        whiteSpace: getComputedStyle(nameElement).whiteSpace,
                        overflowWrap:
                            getComputedStyle(nameElement).overflowWrap,
                    },
                };
            });
            expect(result.header.clientWidth).toBeGreaterThan(0);
            expect(result.header.scrollWidth).toBeLessThanOrEqual(
                result.header.clientWidth + 1,
            );
            expect(result.name.clientWidth).toBeGreaterThan(0);
            expect(result.name.scrollWidth).toBeLessThanOrEqual(
                result.name.clientWidth + 1,
            );
            geometry.push({
                label: 'mobile no-branch worktree and empty sessions',
                viewport,
                value: result,
            });
            await assertClean(diagnostics, fixture);
        },
        { noGit: true, piSessions: [] },
    );
});

test('offline warmed tabs', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(testInfo, async (fixture, contexts, diagnostics) => {
        const desktopPage = await openPage(
            browser,
            fixture,
            contexts,
            diagnostics,
            { width: 1440, height: 900 },
            false,
            'offline-desktop-tabs',
        );
        const mobilePage = await openPage(
            browser,
            fixture,
            contexts,
            diagnostics,
            { width: 390, height: 844 },
            true,
            'offline-mobile-tabs',
        );
        const desktopContext = contexts[0];
        const mobileContext = contexts[1];
        const desktopTracker = diagnostics.find(
            (item) => item.label === 'offline-desktop-tabs',
        );
        const mobileTracker = diagnostics.find(
            (item) => item.label === 'offline-mobile-tabs',
        );
        if (
            !desktopContext ||
            !mobileContext ||
            !desktopTracker ||
            !mobileTracker
        )
            throw new Error('offline tab contexts are missing');

        let runError: unknown;
        try {
            desktopTracker.setPhase('offline', false);
            await desktopContext.setOffline(true);
            mobileTracker.setPhase('offline', false);
            await mobileContext.setOffline(true);

            await desktopPage.locator('#hostname-display').click({
                timeout: 1000,
            });
            const brandList = desktopPage.locator('#hostname-tabs-dropdown');
            await expect(brandList).toBeVisible({ timeout: 1000 });
            const desktopTarget = await selectOtherTab(
                desktopPage,
                brandList,
                'click',
                1000,
            );

            await mobilePage.locator('#mobile-sidebar-toggle').tap({
                timeout: 1000,
            });
            const drawerTabs = mobilePage.locator('#drawer-tabs-body');
            await expect(drawerTabs).toBeVisible({ timeout: 1000 });
            const mobileTarget = await selectOtherTab(
                mobilePage,
                drawerTabs,
                'tap',
                5000,
            );

            desktopTracker.setPhase('recovery', true);
            mobileTracker.setPhase('recovery', true);
            await desktopContext.setOffline(false);
            await mobileContext.setOffline(false);

            await desktopPage.locator('#hostname-display').click({
                timeout: 1000,
            });
            await expect(
                desktopPage
                    .locator('#hostname-tabs-dropdown')
                    .locator('.hostname-dropdown-title')
                    .filter({ hasText: LONG_TITLE }),
            ).toBeVisible({ timeout: 1000 });
            await expect(
                desktopPage.locator('#tabs-container .tab.active'),
            ).toHaveAttribute('data-pane-id', desktopTarget, {
                timeout: 1000,
            });

            await mobilePage.locator('#mobile-sidebar-toggle').tap({
                timeout: 1000,
            });
            await expect(mobilePage.locator('#drawer-tabs-body')).toBeVisible({
                timeout: 1000,
            });
            await expect(
                mobilePage
                    .locator('#drawer-tabs-body')
                    .locator('.hostname-dropdown-title')
                    .filter({ hasText: LONG_TITLE }),
            ).toBeVisible({ timeout: 1000 });
            await expect(
                mobilePage.locator('#tabs-container .tab.active'),
            ).toHaveAttribute('data-pane-id', mobileTarget, {
                timeout: 1000,
            });
        } catch (error) {
            runError = error;
        }

        const restoreErrors: unknown[] = [];
        for (const [context, tracker] of [
            [desktopContext, desktopTracker],
            [mobileContext, mobileTracker],
        ] as const) {
            tracker.setPhase('recovery', true);
            try {
                await context.setOffline(false);
            } catch (error) {
                restoreErrors.push(error);
            }
        }
        if (runError && restoreErrors.length > 0)
            throw new AggregateError(
                [runError, ...restoreErrors],
                'offline tab assertion and online recovery failed',
            );
        if (runError) throw runError;
        if (restoreErrors.length > 0)
            throw new AggregateError(
                restoreErrors,
                'offline tab online recovery failed',
            );
        await assertClean(diagnostics, fixture);
    });
});

test('offline warmed sessions', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(testInfo, async (fixture, contexts, diagnostics) => {
        const page = await openPage(
            browser,
            fixture,
            contexts,
            diagnostics,
            { width: 390, height: 844 },
            true,
            'offline-mobile-sessions',
        );
        const context = contexts[0];
        const tracker = diagnostics[0];
        if (!context || !tracker)
            throw new Error('offline session context is missing');

        await page.locator('#mobile-sidebar-toggle').tap();
        await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
        await page.locator('#drawer-open-sessions').tap();
        const initialResponse = page.waitForResponse(
            (response) =>
                isPiFirstPageRequest(
                    response.request(),
                    fixture,
                    tracker.origin,
                ),
            { timeout: 30_000 },
        );
        await page.locator('#coder-selector .coder-tab[data-coder="pi"]').tap();
        expect((await initialResponse).status()).toBe(200);
        const longRow = page.locator(
            '.session-item[data-session-id="fixture-session-long"]',
        );
        await expect(longRow).toBeVisible({ timeout: 30_000 });
        await expect(longRow.locator('.session-title')).toHaveText(LONG_TITLE);
        await expect(
            longRow.locator('.session-actions .review-btn'),
        ).toBeVisible();
        await page.locator('#mobile-sidebar-toggle').tap();

        let runError: unknown;
        try {
            tracker.setPhase('offline', false);
            await context.setOffline(true);
            await page.locator('#mobile-sidebar-toggle').tap({
                timeout: 1000,
            });
            const drawerTabs = page.locator('#drawer-tabs-body');
            await expect(drawerTabs).toBeVisible({ timeout: 1000 });
            await expect(
                drawerTabs
                    .locator('.hostname-dropdown-title')
                    .filter({ hasText: LONG_TITLE }),
            ).toBeVisible({ timeout: 1000 });
            await page.locator('#drawer-open-sessions').tap({
                timeout: 1000,
            });
            await expect(longRow.locator('.session-title')).toHaveText(
                LONG_TITLE,
                { timeout: 1000 },
            );
            await expect(
                longRow.locator('.session-actions .review-btn'),
            ).toBeVisible({ timeout: 1000 });
            tracker.setPhase('recovery', true);
            await context.setOffline(false);
            await expect(longRow.locator('.session-title')).toHaveText(
                LONG_TITLE,
                { timeout: 1000 },
            );
        } catch (error) {
            runError = error;
        }

        tracker.setPhase('recovery', true);
        let restoreError: unknown;
        try {
            await context.setOffline(false);
        } catch (error) {
            restoreError = error;
        }
        if (runError && restoreError)
            throw new AggregateError(
                [runError, restoreError],
                'offline session assertion and online recovery failed',
            );
        if (runError) throw runError;
        if (restoreError) throw restoreError;
        await assertClean(diagnostics, fixture);
    });
});

test('latency cached sessions refresh', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    await withFixture(testInfo, async (fixture, contexts, diagnostics) => {
        const page = await openPage(
            browser,
            fixture,
            contexts,
            diagnostics,
            { width: 390, height: 844 },
            true,
            'latency-mobile-sessions',
        );
        const tracker = diagnostics[0];
        if (!tracker) throw new Error('latency diagnostic tracker missing');
        await page.locator('#mobile-sidebar-toggle').tap();
        await page.locator('#drawer-open-sessions').tap();
        const initialResponse = page.waitForResponse(
            (response) =>
                isPiFirstPageRequest(
                    response.request(),
                    fixture,
                    tracker.origin,
                ),
            { timeout: 30_000 },
        );
        await page.locator('#coder-selector .coder-tab[data-coder="pi"]').tap();
        expect((await initialResponse).status()).toBe(200);
        const longRow = page.locator(
            '.session-item[data-session-id="fixture-session-long"]',
        );
        await expect(longRow).toBeVisible({ timeout: 30_000 });
        const title = longRow.locator('.session-title');
        const review = longRow.locator('.session-actions .review-btn');
        await expect(title).toHaveText(LONG_TITLE);
        await expect(review).toBeVisible();

        const context = contexts[0];
        if (!context) throw new Error('latency browser context missing');
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => {
            releaseResponse = resolve;
        });
        let routeClaimed = false;
        let routeFinished = false;
        let resolveClaimed!: (request: Request) => void;
        const claimedRoute = new Promise<Request>((resolve) => {
            resolveClaimed = resolve;
        });
        let resolveRouteFinished!: () => void;
        const routeFinishedPromise = new Promise<void>((resolve) => {
            resolveRouteFinished = resolve;
        });
        const routePattern = '**/api/sessions**';
        const routeHandler = async (
            route: import('@playwright/test').Route,
        ) => {
            const request = route.request();
            if (
                routeClaimed ||
                !isPiFirstPageRequest(request, fixture, tracker.origin)
            ) {
                await route.fallback();
                return;
            }
            routeClaimed = true;
            const record = tracker.getRequestRecord(request);
            if (record)
                record.injectedResponse = {
                    status: 500,
                    body: SESSION_REFRESH_FAILURE,
                };
            resolveClaimed(request);
            try {
                await responseGate;
                await route.fulfill({
                    status: 500,
                    contentType: 'text/plain',
                    body: SESSION_REFRESH_FAILURE,
                });
            } finally {
                routeFinished = true;
                resolveRouteFinished();
            }
        };
        let routeInstalled = false;
        let runError: unknown;
        const cleanupErrors: unknown[] = [];
        try {
            await page.route(routePattern, routeHandler);
            routeInstalled = true;
            tracker.setPhase('injected-session-failure', true);
            const rootHeader = page
                .locator('.worktree-section')
                .first()
                .locator('.worktree-header');
            const collapseState = page.waitForResponse(
                (response) => isWorktreeStateResponse(response, fixture, false),
                { timeout: 5000 },
            );
            await rootHeader.tap();
            const collapsed = await collapseState;
            expect(collapsed.status()).toBe(200);
            await recordWorktreeStateReadback(
                collapsed,
                fixture,
                tracker,
                false,
            );

            const expandState = page.waitForResponse(
                (response) => isWorktreeStateResponse(response, fixture, true),
                { timeout: 5000 },
            );
            const sessionRequest = page.waitForRequest(
                (request) =>
                    isPiFirstPageRequest(request, fixture, tracker.origin),
                { timeout: 5000 },
            );
            await rootHeader.tap();
            const [expanded, requested] = await Promise.all([
                expandState,
                sessionRequest,
            ]);
            expect(expanded.status()).toBe(200);
            await expect.poll(() => routeClaimed, { timeout: 5000 }).toBe(true);
            const claimed = await claimedRoute;
            expect(claimed.url()).toBe(requested.url());
            const requestRecord = tracker.getRequestRecord(requested);
            expect(requestRecord).toBeTruthy();
            if (!requestRecord)
                throw new Error('held session request is not tracked');
            requestRecord.injectedResponse = {
                status: 500,
                body: SESSION_REFRESH_FAILURE,
            };

            await expect(longRow).toBeVisible({ timeout: 1000 });
            await expect(title).toHaveText(LONG_TITLE, { timeout: 1000 });
            await expect(review).toBeVisible({ timeout: 1000 });
            await recordWorktreeStateReadback(expanded, fixture, tracker, true);

            const failedResponsePromise = page.waitForResponse(
                (response) => response.request() === requested,
                { timeout: 5000 },
            );
            releaseResponse();
            const failedResponse = await failedResponsePromise;
            expect(failedResponse.status()).toBe(500);
            expect(await failedResponse.text()).toBe(SESSION_REFRESH_FAILURE);
            await expect
                .poll(() => routeFinished, { timeout: 5000 })
                .toBe(true);
            await expect(page.locator('.error-sessions')).toHaveText(
                `Error: ${SESSION_REFRESH_FAILURE}`,
                {
                    timeout: 5000,
                },
            );
            await expect(page.locator('.modal-overlay:visible')).toHaveCount(0);
            await page.unroute(routePattern, routeHandler);
            routeInstalled = false;

            tracker.setPhase('recovery', true);
            const collapseAgain = page.waitForResponse(
                (response) => isWorktreeStateResponse(response, fixture, false),
                { timeout: 5000 },
            );
            await rootHeader.tap();
            const collapsedAgain = await collapseAgain;
            expect(collapsedAgain.status()).toBe(200);
            await recordWorktreeStateReadback(
                collapsedAgain,
                fixture,
                tracker,
                false,
            );
            const expandAgain = page.waitForResponse(
                (response) => isWorktreeStateResponse(response, fixture, true),
                { timeout: 5000 },
            );
            const recoveredSession = page.waitForResponse(
                (response) =>
                    isPiFirstPageRequest(
                        response.request(),
                        fixture,
                        tracker.origin,
                    ),
                { timeout: 5000 },
            );
            await rootHeader.tap();
            const [expandedAgain, recovered] = await Promise.all([
                expandAgain,
                recoveredSession,
            ]);
            expect(expandedAgain.status()).toBe(200);
            await recordWorktreeStateReadback(
                expandedAgain,
                fixture,
                tracker,
                true,
            );
            expect(recovered.status()).toBe(200);
            await expect(title).toHaveText(LONG_TITLE);
            await expect(review).toBeVisible();
            await expect(page.locator('.error-sessions')).toHaveCount(0);
            await assertClean(diagnostics, fixture);
        } catch (error) {
            runError = error;
        }

        releaseResponse();
        if (routeInstalled) {
            try {
                await page.unroute(routePattern, routeHandler);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (routeClaimed && !routeFinished) {
            try {
                await expect
                    .poll(() => routeFinished, { timeout: 5000 })
                    .toBe(true);
                await routeFinishedPromise;
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (runError && cleanupErrors.length > 0)
            throw new AggregateError(
                [runError, ...cleanupErrors],
                'latency assertion and route cleanup failed',
            );
        if (runError) throw runError;
        if (cleanupErrors.length > 0)
            throw new AggregateError(
                cleanupErrors,
                'latency route cleanup failed',
            );
    });
});
