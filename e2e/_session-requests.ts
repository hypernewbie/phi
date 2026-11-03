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
