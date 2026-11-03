import { describe, expect, it } from 'vitest';
import {
    isCancelledBellAudio,
    isCancelledGitRead,
    isCancelledSessionListRead,
    isCancelledTerminalReplay,
    isCancelledWorktreeRead,
} from '../e2e/_session-requests.ts';

const origin = 'http://127.0.0.1:17777';
const request = (
    url,
    method = 'GET',
    errorText = 'net::ERR_ABORTED',
    resourceType = 'fetch',
) => ({
    url: () => url,
    method: () => method,
    failure: () => (errorText ? { errorText } : null),
    resourceType: () => resourceType,
});

describe('expected bell media cancellation diagnostics', () => {
    const bell = `${origin}/vendor/bell.wav`;
    it('recognizes an aborted same-origin bell media GET', () => {
        expect(
            isCancelledBellAudio(
                request(bell, 'GET', 'net::ERR_ABORTED', 'media'),
                origin,
            ),
        ).toBe(true);
    });

    it.each([
        [bell, 'POST', 'net::ERR_ABORTED', 'media'],
        [bell, 'GET', 'net::ERR_ABORTED', 'fetch'],
        [bell, 'GET', 'net::ERR_CONNECTION_RESET', 'media'],
        [bell, 'GET', null, 'media'],
        [`${bell}/extra`, 'GET', 'net::ERR_ABORTED', 'media'],
        [
            'http://127.0.0.1:17778/vendor/bell.wav',
            'GET',
            'net::ERR_ABORTED',
            'media',
        ],
        [
            `${origin}/api/terminals/pane/replay`,
            'GET',
            'net::ERR_ABORTED',
            'media',
        ],
    ])(
        'does not exempt %s %s %s %s',
        (url, method, errorText, resourceType) => {
            expect(
                isCancelledBellAudio(
                    request(url, method, errorText, resourceType),
                    origin,
                ),
            ).toBe(false);
        },
    );
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

describe('expected terminal replay cancellation diagnostics', () => {
    it('recognizes only an aborted same-origin GET replay', () => {
        expect(
            isCancelledTerminalReplay(
                request(`${origin}/api/terminals/pane/replay?from=0`),
                origin,
            ),
        ).toBe(true);
    });

    it.each([
        [`${origin}/api/terminals/pane/replay`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/terminals/pane/replay`, 'GET', 'net::ERR_FAILED'],
        [
            `${origin}/api/terminals/pane/replay`,
            'GET',
            'net::ERR_INTERNET_DISCONNECTED',
        ],
        [`${origin}/api/terminals/pane/replay`, 'GET', 'net::ERR_TIMED_OUT'],
        [
            `${origin}/api/terminals/pane/replay`,
            'GET',
            'net::ERR_CONNECTION_RESET',
        ],
        [`${origin}/api/terminals/pane/replay`, 'GET', null],
        [
            `${origin}/api/terminals/pane/replay/extra`,
            'GET',
            'net::ERR_ABORTED',
        ],
        [`${origin}/api/terminals/pane/input`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/terminals`, 'GET', 'net::ERR_ABORTED'],
        [
            'http://127.0.0.1:17778/api/terminals/pane/replay',
            'GET',
            'net::ERR_ABORTED',
        ],
    ])('does not exempt %s %s %s', (url, method, errorText) => {
        expect(
            isCancelledTerminalReplay(request(url, method, errorText), origin),
        ).toBe(false);
    });
});

describe('expected Git read cancellation diagnostics', () => {
    it.each([
        [`${origin}/api/git/info?cwd=%2Fwork`],
        [`${origin}/api/git/status-files?cwd=%2Fwork`],
    ])('recognizes a canceled same-origin GET of %s', (url) => {
        expect(isCancelledGitRead(request(url), origin)).toBe(true);
    });

    it.each([
        [`${origin}/api/git/action`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/info`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/info`, 'GET', 'net::ERR_FAILED'],
        [`${origin}/api/git/info`, 'GET', null],
        [`${origin}/api/git/info/extra`, 'GET', 'net::ERR_ABORTED'],
        [`${origin}/api/git/status-files`, 'POST', 'net::ERR_ABORTED'],
        [`${origin}/api/git/status-files`, 'GET', 'net::ERR_FAILED'],
        [`${origin}/api/git/status-files/extra`, 'GET', 'net::ERR_ABORTED'],
        ['http://127.0.0.1:17778/api/git/info', 'GET', 'net::ERR_ABORTED'],
        ['http://localhost:17777/api/git/info', 'GET', 'net::ERR_ABORTED'],
        [
            'http://127.0.0.1:17778/api/git/status-files?cwd=%2Fwork',
            'GET',
            'net::ERR_ABORTED',
        ],
    ])('does not exempt %s %s %s', (url, method, errorText) => {
        expect(
            isCancelledGitRead(request(url, method, errorText), origin),
        ).toBe(false);
    });
});
