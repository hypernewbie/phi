// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelRequestJson, ModelRequestTimeout } from '../web/model-request.js';

const ok = () => ({ ok: true, json: async () => ({ ok: true }) });
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('model request network buffer', () => {
    it('allows a slow response instead of dropping it at one second', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(
            () =>
                new Promise((resolve) => setTimeout(() => resolve(ok()), 5000)),
        );
        vi.stubGlobal('fetch', fetch);
        const result = modelRequestJson('/models');
        await vi.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retries transient catalog failures, with a bounded attempt count', async () => {
        vi.useFakeTimers();
        const fetch = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('network lost'))
            .mockResolvedValueOnce({ ok: false, status: 503 })
            .mockResolvedValueOnce(ok());
        vi.stubGlobal('fetch', fetch);
        const result = modelRequestJson('/models');
        await vi.advanceTimersByTimeAsync(1500);
        await expect(result).resolves.toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never replays a dispatched mutation when its acknowledgement is lost', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockRejectedValue(new TypeError('network lost'));
        vi.stubGlobal('fetch', fetch);
        await expect(
            modelRequestJson('/model', { method: 'POST' }),
        ).rejects.toThrow('network lost');
        await vi.advanceTimersByTimeAsync(ModelRequestTimeout);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('buffers an unsent change offline and sends exactly once after reconnect', async () => {
        vi.useFakeTimers();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const fetch = vi.fn().mockResolvedValue(ok());
        const onQueued = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const result = modelRequestJson(
            '/model',
            { method: 'POST' },
            { onQueued },
        );
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetch).not.toHaveBeenCalled();
        expect(onQueued).toHaveBeenCalledTimes(1);
        window.dispatchEvent(new Event('online'));
        await expect(result).resolves.toEqual({ ok: true });
        window.dispatchEvent(new Event('online'));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('expires offline work and never sends a ghost change on a later reconnect', async () => {
        vi.useFakeTimers();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const result = modelRequestJson('/model', { method: 'POST' });
        const failed = expect(result).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(ModelRequestTimeout);
        await failed;
        window.dispatchEvent(new Event('online'));
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('checks the original session before dispatching queued work', async () => {
        vi.useFakeTimers();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        let current = true;
        const result = modelRequestJson(
            '/model',
            { method: 'POST' },
            { canSend: () => current },
        );
        const failed = expect(result).rejects.toThrow('session changed');
        current = false;
        window.dispatchEvent(new Event('online'));
        await failed;
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps one total deadline through response-body delivery', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, { signal }) => ({
                ok: true,
                json: () =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () =>
                            reject(new DOMException('timed out', 'AbortError')),
                        );
                    }),
            })),
        );
        const result = modelRequestJson('/model', { method: 'POST' });
        const failed = expect(result).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(ModelRequestTimeout);
        await failed;
        expect(vi.getTimerCount()).toBe(0);
    });
});
