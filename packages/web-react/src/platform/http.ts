export type ConnectionResult =
    | 'disabled'
    | 'protected'
    | 'unsupported'
    | 'unavailable'
    | 'cancelled';

export interface ConnectionService {
    readonly serverLabel: string;
    getStatus(signal: AbortSignal): Promise<ConnectionResult>;
}

export function createConnectionService(
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    upstreamOrigin: string = __PHI_UPSTREAM_ORIGIN__,
): ConnectionService {
    return {
        serverLabel: upstreamOrigin,
        async getStatus(signal) {
            if (signal.aborted) return 'cancelled';
            const controller = new AbortController();
            let interrupt: (result: ConnectionResult) => void = () => {};
            const interrupted = new Promise<ConnectionResult>((resolve) => {
                interrupt = resolve;
            });
            const cancel = () => {
                interrupt('cancelled');
                controller.abort();
            };
            signal.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => {
                interrupt('unavailable');
                controller.abort();
            }, 5_000);
            const probe = async (): Promise<ConnectionResult> => {
                try {
                    const response = await fetchImpl('/api/auth/v2/status', {
                        method: 'GET',
                        credentials: 'omit',
                        redirect: 'error',
                        headers: { Accept: 'application/json' },
                        signal: controller.signal,
                    });
                    if (response.redirected) return 'unavailable';
                    if (response.status === 404 || response.status === 405)
                        return 'unsupported';
                    if (response.status !== 200) return 'unavailable';
                    const body: unknown = await response.json();
                    if (
                        typeof body !== 'object' ||
                        body === null ||
                        !('enabled' in body) ||
                        !('authenticated' in body)
                    )
                        return 'unavailable';
                    if (
                        typeof body.enabled !== 'boolean' ||
                        typeof body.authenticated !== 'boolean'
                    )
                        return 'unavailable';
                    return body.enabled ? 'protected' : 'disabled';
                } catch {
                    return 'unavailable';
                }
            };
            try {
                return await Promise.race([interrupted, probe()]);
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                controller.abort();
            }
        },
    };
}
