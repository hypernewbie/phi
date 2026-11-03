import type { Request } from '@playwright/test';

// Sidebar ownership changes deliberately cancel these background reads.
export function isCancelledWorktreeRead(
    request: Request,
    origin: string,
): boolean {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        url.origin === new URL(origin).origin &&
        (url.pathname === '/api/git/worktrees' ||
            url.pathname === '/api/git/worktree-dirty')
    );
}

export function isCancelledSessionListRead(
    request: Request,
    origin: string,
): boolean {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        url.origin === new URL(origin).origin &&
        url.pathname === '/api/sessions'
    );
}

// Sidebar ownership changes deliberately cancel these background reads.
export function isCancelledGitRead(request: Request, origin: string): boolean {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        url.origin === new URL(origin).origin &&
        (url.pathname === '/api/git/info' ||
            url.pathname === '/api/git/status-files')
    );
}

// A pane refresh, close, or replacement aborts its in-flight replay fetch.
export function isCancelledTerminalReplay(
    request: Request,
    origin: string,
): boolean {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        url.origin === new URL(origin).origin &&
        /^\/api\/terminals\/[^/]+\/replay$/.test(url.pathname)
    );
}

// Restarting a chime can cancel its previous media range request.
export function isCancelledBellAudio(
    request: Request,
    origin: string,
): boolean {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        request.resourceType() === 'media' &&
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        url.origin === new URL(origin).origin &&
        url.pathname === '/vendor/bell.wav'
    );
}

// Any background read the sidebar may supersede. Specs that assert "no
// unexpected failed requests" use this so an ordinary supersede does not
// read as a regression.
export function isCancelledBackgroundRead(
    request: Request,
    origin: string,
): boolean {
    return (
        isCancelledWorktreeRead(request, origin) ||
        isCancelledSessionListRead(request, origin)
    );
}

// Every failure the app causes on purpose: a superseded background read, a
// replay aborted by a pane switch or close, a git read the drawer dropped, a
// bell range request replaced by the next chime. Specs that assert "no
// unexpected failed request" filter with this instead of naming one case, so
// a test cannot fail on an abort the UI performs by design.
export function isExpectedRequestFailure(
    request: Request,
    origin: string,
): boolean {
    return (
        isCancelledBackgroundRead(request, origin) ||
        isCancelledGitRead(request, origin) ||
        isCancelledTerminalReplay(request, origin) ||
        isCancelledBellAudio(request, origin)
    );
}
