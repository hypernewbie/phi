import { describe, expect, it } from 'vitest';
import {
    isCancelledGitInfoRead,
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from '../e2e/_session-requests.ts';

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

describe('expected background session-list cancellation diagnostics', () => {
    it('recognizes only canceled same-origin GET /api/sessions', () => {
        expect(
            isCancelledSessionListRead(
                request(`${origin}/api/sessions?coder=pi&offset=0`),
                origin,
            ),
        ).toBe(true);
    });

    it.each([
        [`${origin}/api/sessions`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/sessions`, 'GET', 'net::ERR_FAILED'],
        [`${origin}/api/sessions/extra`, 'GET', 'net::ERR_ABORTED'],
        [`${origin}/api/git/worktrees`, 'GET', 'net::ERR_ABORTED'],
        ['http://127.0.0.1:17778/api/sessions', 'GET', 'net::ERR_ABORTED'],
    ])('does not exempt %s %s %s', (url, method, errorText) => {
        expect(
            isCancelledSessionListRead(request(url, method, errorText), origin),
        ).toBe(false);
    });
});

describe('expected Git-info cancellation diagnostics', () => {
    it('recognizes a canceled same-origin GET with a cwd query', () => {
        expect(
            isCancelledGitInfoRead(
                request(`${origin}/api/git/info?cwd=%2Fwork`),
                origin,
            ),
        ).toBe(true);
    });

    it.each([
        [`${origin}/api/git/action`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/info`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/info`, 'GET', 'net::ERR_FAILED'],
        [`${origin}/api/git/info`, 'GET', null],
        [`${origin}/api/git/info/extra`, 'GET', 'net::ERR_ABORTED'],
        ['http://127.0.0.1:17778/api/git/info', 'GET', 'net::ERR_ABORTED'],
        ['http://localhost:17777/api/git/info', 'GET', 'net::ERR_ABORTED'],
    ])('does not exempt %s %s %s', (url, method, errorText) => {
        expect(
            isCancelledGitInfoRead(request(url, method, errorText), origin),
        ).toBe(false);
    });
});
