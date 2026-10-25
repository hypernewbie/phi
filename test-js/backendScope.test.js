// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackendScope } from '../web/backend-scope.js';

describe('BackendScope', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('properties and headers', () => {
        it('sets profileId and origin from constructor', () => {
            const scope = new BackendScope('prof1', 'http://127.0.0.1:8080');
            expect(scope.profileId).toBe('prof1');
            expect(scope.origin).toBe('http://127.0.0.1:8080');
            expect(scope.aborted).toBe(false);
            expect(scope.signal).toBeDefined();
        });

        it('injects X-Phi-Backend when profileId is set', () => {
            const scope = new BackendScope('prof1', 'http://127.0.0.1:8080');
            const headers = scope.headers();
            expect(headers).toEqual({ 'X-Phi-Backend': 'prof1' });
        });

        it('omits X-Phi-Backend when profileId is empty', () => {
            const scope = new BackendScope('', '');
            const headers = scope.headers();
            expect(headers).toEqual({});
        });

        it('normalizes and merges extra headers from plain object, Headers, and Array', () => {
            const scope = new BackendScope('prof1');

            // Plain object
            const objHeaders = scope.headers({
                'Content-Type': 'application/json',
                Authorization: 'Bearer token',
            });
            expect(objHeaders).toEqual({
                'Content-Type': 'application/json',
                Authorization: 'Bearer token',
                'X-Phi-Backend': 'prof1',
            });

            // Headers instance
            const h = new Headers();
            h.set('Accept', 'text/html');
            const fromHeaders = scope.headers(h);
            expect(fromHeaders).toEqual({
                accept: 'text/html',
                'X-Phi-Backend': 'prof1',
            });

            // Array
            const fromArray = scope.headers([
                ['X-Custom', 'val1'],
                ['X-Another', 'val2'],
            ]);
            expect(fromArray).toEqual({
                'X-Custom': 'val1',
                'X-Another': 'val2',
                'X-Phi-Backend': 'prof1',
            });
        });

        it('preserves explicit X-Phi-Backend header in extra over scope.profileId', () => {
            const scope = new BackendScope('scope-prof');
            const headers = scope.headers({ 'X-Phi-Backend': 'explicit-prof' });
            expect(headers['X-Phi-Backend']).toBe('explicit-prof');

            const lowerHeaders = scope.headers({
                'x-phi-backend': 'lowercase-prof',
            });
            expect(lowerHeaders['x-phi-backend']).toBe('lowercase-prof');
            expect(lowerHeaders['X-Phi-Backend']).toBeUndefined();
        });
    });

    describe('fetch & fetchText', () => {
        it('merges headers and passes signal to globalThis.fetch', async () => {
            const scope = new BackendScope('prof1');
            const mockFetch = vi
                .fn()
                .mockResolvedValue(new Response('OK', { status: 200 }));
            vi.stubGlobal('fetch', mockFetch);

            const res = await scope.fetch('/api/test', {
                headers: { 'Content-Type': 'application/json' },
            });
            expect(res.status).toBe(200);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/test',
                expect.objectContaining({
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Phi-Backend': 'prof1',
                    },
                    signal: scope.signal,
                }),
            );
        });

        it('throws AbortError if fetch is called after scope is aborted', async () => {
            const scope = new BackendScope('prof1');
            scope.abort();
            expect(scope.aborted).toBe(true);

            await expect(scope.fetch('/api/test')).rejects.toThrow(
                'BackendScope aborted',
            );
        });

        it('throws AbortError if aborted while fetch is in-flight', async () => {
            const scope = new BackendScope('prof1');
            let resolveFetch;
            const mockFetch = vi.fn().mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            );
            vi.stubGlobal('fetch', mockFetch);

            const fetchPromise = scope.fetch('/api/test');
            scope.abort();
            resolveFetch(new Response('OK', { status: 200 }));

            await expect(fetchPromise).rejects.toThrow('BackendScope aborted');
        });

        it('fetchText returns text on 2xx', async () => {
            const scope = new BackendScope('prof1');
            const mockFetch = vi
                .fn()
                .mockResolvedValue(
                    new Response('Hello World', { status: 200 }),
                );
            vi.stubGlobal('fetch', mockFetch);

            const text = await scope.fetchText('/api/greet');
            expect(text).toBe('Hello World');
        });

        it('fetchText throws with .status on non-2xx', async () => {
            const scope = new BackendScope('prof1');
            const mockFetch = vi
                .fn()
                .mockResolvedValue(new Response('Not Found', { status: 404 }));
            vi.stubGlobal('fetch', mockFetch);

            let caughtError;
            try {
                await scope.fetchText('/api/missing');
            } catch (err) {
                caughtError = err;
            }
            expect(caughtError).toBeDefined();
            expect(caughtError.message).toContain('HTTP 404');
            expect(caughtError.status).toBe(404);
        });
    });

    describe('timers and events cleanup on abort', () => {
        it('clears interval on scope.abort()', () => {
            const scope = new BackendScope();
            const fn = vi.fn();
            scope.interval(fn, 1000);

            vi.advanceTimersByTime(2500);
            expect(fn).toHaveBeenCalledTimes(2);

            scope.abort();
            vi.advanceTimersByTime(5000);
            expect(fn).toHaveBeenCalledTimes(2); // no further calls
        });

        it('clears timeout on scope.abort()', () => {
            const scope = new BackendScope();
            const fn = vi.fn();
            scope.timeout(fn, 1000);

            scope.abort();
            vi.advanceTimersByTime(2000);
            expect(fn).not.toHaveBeenCalled();
        });

        it('does not schedule interval or timeout if already aborted', () => {
            const scope = new BackendScope();
            scope.abort();

            const fn = vi.fn();
            scope.interval(fn, 1000);
            scope.timeout(fn, 1000);

            vi.advanceTimersByTime(3000);
            expect(fn).not.toHaveBeenCalled();
        });

        it('removes event listener on scope.abort()', () => {
            const scope = new BackendScope();
            const target = new EventTarget();
            const listener = vi.fn();

            scope.listen(target, 'test-event', listener);
            target.dispatchEvent(new Event('test-event'));
            expect(listener).toHaveBeenCalledTimes(1);

            scope.abort();
            target.dispatchEvent(new Event('test-event'));
            expect(listener).toHaveBeenCalledTimes(1); // not called again
        });
    });
});
