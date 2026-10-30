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
