import { describe, expect, it } from 'vitest';
import { isCancelledWorktreeRead } from '../e2e/_session-requests.ts';

const origin = 'http://127.0.0.1:17777';
const request = (url, method = 'GET', errorText = 'net::ERR_ABORTED') => ({
    url: () => url,
    method: () => method,
    failure: () => (errorText ? { errorText } : null),
});

describe('expected background worktree cancellation diagnostics', () => {
    it.each(['/api/git/worktrees', '/api/git/worktree-dirty'])(
        'recognizes only canceled same-origin GET %s',
        (path) => {
            expect(
                isCancelledWorktreeRead(
                    request(`${origin}${path}?cwd=%2Fwork`),
                    origin,
                ),
            ).toBe(true);
        },
    );

    it.each([
        [`${origin}/api/git/worktrees`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/worktrees`, 'GET', 'net::ERR_FAILED'],
        [`${origin}/api/git/worktrees`, 'GET', 'net::ERR_CONNECTION_RESET'],
        [`${origin}/api/git/worktrees`, 'GET', null],
        [`${origin}/api/git/worktrees/extra`, 'GET', 'net::ERR_ABORTED'],
        [`${origin}/api/sessions`, 'GET', 'net::ERR_ABORTED'],
        [`${origin}/api/terminals`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/config/theme`, 'POST', 'net::ERR_ABORTED'],
        ['http://127.0.0.1:17778/api/git/worktrees', 'GET', 'net::ERR_ABORTED'],
        ['http://localhost:17777/api/git/worktrees', 'GET', 'net::ERR_ABORTED'],
    ])('does not exempt %s %s %s', (url, method, errorText) => {
        expect(
            isCancelledWorktreeRead(request(url, method, errorText), origin),
        ).toBe(false);
    });
});
