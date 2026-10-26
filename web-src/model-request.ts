// Browser/network budget, deliberately longer than Phi's local Pi model
// operation budget. A slow uplink must not inherit the one-second IPC timeout.
export const ModelRequestTimeout = 45_000;

interface ModelRequestOptions {
    canSend?: () => boolean;
    onQueued?: () => void;
    onDispatch?: () => void;
}

function waitOnline(signal: AbortSignal, onQueued?: () => void): Promise<void> {
    if (navigator.onLine !== false) return Promise.resolve();
    onQueued?.();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            window.removeEventListener('online', online);
            signal.removeEventListener('abort', aborted);
        };
        const online = () => {
            cleanup();
            resolve();
        };
        const aborted = () => {
            cleanup();
            reject(new DOMException('Request timed out', 'AbortError'));
        };
        window.addEventListener('online', online, { once: true });
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    });
}

function retryDelay(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const aborted = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            reject(new DOMException('Request timed out', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', aborted);
            resolve();
        }, ms);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    });
}

/**
 * Buffer while offline, with one total deadline covering queue, fetch and body.
 * Only GETs retry; a dispatched mutation may have landed even if its reply was
 * lost. Never replay one against either the original or a replacement session.
 */
export async function modelRequestJson(
    url: string,
    init: RequestInit = {},
    options: ModelRequestOptions = {},
): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ModelRequestTimeout);
    const { signal } = controller;
    const read = !init.method || init.method === 'GET';
    try {
        for (let attempt = 0; ; attempt++) {
            await waitOnline(signal, options.onQueued);
            if (signal.aborted)
                throw new DOMException('Request timed out', 'AbortError');
            if (options.canSend && !options.canSend())
                throw new Error('Pi session changed; choose the model again');
            let response: Response;
            options.onDispatch?.();
            try {
                response = await fetch(url, {
                    ...init,
                    signal,
                    cache: 'no-store',
                });
            } catch (error) {
                if (!read || signal.aborted || attempt >= 2) throw error;
                await retryDelay(signal, 500 * (attempt + 1));
                continue;
            }
            if (!response.ok) {
                if (
                    read &&
                    [408, 429, 502, 503, 504].includes(response.status) &&
                    attempt < 2
                ) {
                    await retryDelay(signal, 500 * (attempt + 1));
                    continue;
                }
                throw new Error(`Pi models unavailable (${response.status})`);
            }
            return await response.json();
        }
    } finally {
        clearTimeout(timer);
    }
}
