import {
    test as base,
    expect,
    request as playwrightRequest,
    type APIRequestContext,
    type BrowserContext,
} from '@playwright/test';
import { startFoundationStack, type FoundationStack } from './phi-server.ts';

interface StatusReply {
    status?: number;
    body?: unknown;
    raw?: string;
    wait?: Promise<void>;
    setCookie?: string;
}
export interface StatusMock {
    reply?: StatusReply;
}

export interface GuardFaults {
    offline: boolean;
    stripSetCookie: boolean;
    loginGate?: Promise<void>;
    // Synthetic login rejection without upstream contact. Tests client
    // honoring of server waits, never server behavior.
    loginFault?: { status: number; retryAfter?: string };
}

export interface ForwardedRequest {
    route: string;
    authorization: boolean;
    cookie: boolean;
}

export interface GuardHandle {
    violations: string[];
    forwarded: ForwardedRequest[];
    dispose(): Promise<void>;
}

export async function guardBrowserContext(
    context: BrowserContext,
    stack: Pick<FoundationStack, 'reactUrl' | 'phiUrl'>,
    options: {
        statusMock?: StatusMock;
        configMock?: StatusMock;
        allowAuthPosts?: boolean;
        faults?: GuardFaults;
    } = {},
): Promise<GuardHandle> {
    const violations: string[] = [];
    const forwarded: ForwardedRequest[] = [];
    const faults = options.faults;
    // Isolated forwarding jar: route.fetch would share the browser cookie
    // jar and could install Set-Cookie even for credentials:'omit' pages.
    const forwarder: APIRequestContext = await playwrightRequest.newContext();
    const dispose = async () => {
        await forwarder.dispose().catch(() => {});
    };
    const origins = new Set([stack.reactUrl, stack.phiUrl]);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const apiAllowed =
            request.method() === 'GET' &&
            (url.pathname === '/api/auth/v2/status' ||
                url.pathname === '/api/config' ||
                url.pathname === '/api/version') &&
            url.origin === stack.reactUrl;
        const authAllowed =
            options.allowAuthPosts === true &&
            request.method() === 'POST' &&
            (url.pathname === '/api/auth/v2/login' ||
                url.pathname === '/api/auth/v2/refresh') &&
            url.origin === stack.reactUrl;
        const configPostAllowed =
            options.allowAuthPosts === true &&
            request.method() === 'POST' &&
            (url.pathname === '/api/config/use-hidden-terminal' ||
                url.pathname === '/api/config/use-existing-terminal-tab' ||
                url.pathname === '/api/config/auto-reconnect' ||
                url.pathname === '/api/config/pi-offline' ||
                url.pathname === '/api/config/pi-bridge-no-inject' ||
                url.pathname ===
                    '/api/config/claude-dangerously-skip-permissions' ||
                url.pathname === '/api/config/agy-theme-ansi' ||
                url.pathname === '/api/config/opencode-idle-stop') &&
            url.origin === stack.reactUrl;
        if (
            !origins.has(url.origin) ||
            (url.pathname.startsWith('/api') &&
                !apiAllowed &&
                !authAllowed &&
                !configPostAllowed) ||
            url.pathname.startsWith('/ws')
        ) {
            violations.push(`${request.method()} ${url.origin}${url.pathname}`);
            await route.abort('blockedbyclient');
            return;
        }
        // Both route.fetch and isolated forwarding ignore browser offline
        // emulation, so the guard aborts allowed API work itself.
        if (
            (apiAllowed || authAllowed || configPostAllowed) &&
            faults?.offline === true
        ) {
            await route.abort('internetdisconnected');
            return;
        }
        if (
            apiAllowed &&
            url.pathname === '/api/auth/v2/status' &&
            options.statusMock?.reply
        ) {
            const reply = options.statusMock.reply;
            await reply.wait;
            await route.fulfill({
                status: reply.status ?? 200,
                contentType: 'application/json',
                headers: reply.setCookie
                    ? { 'set-cookie': reply.setCookie }
                    : undefined,
                body: reply.raw ?? JSON.stringify(reply.body),
            });
            return;
        }
        if (
            authAllowed &&
            url.pathname === '/api/auth/v2/login' &&
            faults?.loginFault !== undefined
        ) {
            const fault = faults.loginFault;
            await route.fulfill({
                status: fault.status,
                contentType: 'application/json',
                headers:
                    fault.retryAfter === undefined
                        ? undefined
                        : { 'retry-after': fault.retryAfter },
                body: '{}',
            });
            return;
        }
        if (
            apiAllowed &&
            url.pathname === '/api/config' &&
            options.configMock?.reply
        ) {
            const reply = options.configMock.reply;
            await reply.wait;
            await route.fulfill({
                status: reply.status ?? 200,
                contentType: 'application/json',
                body: reply.raw ?? JSON.stringify(reply.body),
            });
            return;
        }
        try {
            // The gate waits inside the abort-safe block: by release time
            // the page may have aborted, and touching a dead request or
            // route must stay silent, not a violation.
            if (
                authAllowed &&
                url.pathname === '/api/auth/v2/login' &&
                faults?.loginGate
            )
                await faults.loginGate;
            // Routing does not intercept the next request in an HTTP redirect chain.
            // Keep an omitted Cookie header omitted even in the forwarding context.
            const headers = await request.allHeaders();
            const sentCookie = Object.entries(headers).find(
                ([name]) => name.toLowerCase() === 'cookie',
            )?.[1];
            const sentAuthorization = Object.keys(headers).some(
                (name) => name.toLowerCase() === 'authorization',
            );
            if (sentCookie === undefined) headers.cookie = '';
            const postData = request.postDataBuffer();
            const response = await forwarder.fetch(request.url(), {
                method: request.method(),
                headers,
                data: postData ?? undefined,
                maxRedirects: 0,
                maxRetries: 0,
                timeout: 20_000,
            });
            try {
                if (response.status() >= 300 && response.status() < 400) {
                    violations.push(
                        `Redirect ${request.method()} ${url.origin}${url.pathname}`,
                    );
                    await route.abort('blockedbyclient');
                    return;
                }
                forwarded.push({
                    route: `${request.method()} ${url.origin}${url.pathname}`,
                    authorization: sentAuthorization,
                    cookie: sentCookie !== undefined && sentCookie !== '',
                });
                if (authAllowed && faults?.stripSetCookie === true) {
                    const kept: Record<string, string> = {};
                    for (const {
                        name,
                        value,
                    } of await response.headersArray()) {
                        if (name.toLowerCase() === 'set-cookie') continue;
                        kept[name] =
                            kept[name] === undefined
                                ? value
                                : `${kept[name]}, ${value}`;
                    }
                    await route.fulfill({
                        status: response.status(),
                        headers: kept,
                        body: await response.body(),
                    });
                } else {
                    // Fulfilling delivers Set-Cookie to the browser, which
                    // applies the original fetch credential policy.
                    await route.fulfill({ response });
                }
            } finally {
                await response.dispose();
            }
        } catch (error) {
            // The page can abort during an injected hold, or the context can
            // close under a pending forward. Neither is a guard failure.
            if (context.browser() === null) return;
            const message =
                error instanceof Error ? error.message : String(error);
            if (/closed|aborted|abort/i.test(message)) {
                try {
                    await route.abort('blockedbyclient');
                } catch {
                    /* The page is already gone. */
                }
                return;
            }
            violations.push(
                `Forward failed ${request.method()} ${url.origin}${url.pathname}`,
            );
        }
    });
    await context.routeWebSocket('**/*', (socket) => {
        const url = new URL(socket.url());
        if (
            url.protocol === 'ws:' &&
            url.host === new URL(stack.reactUrl).host &&
            url.pathname === '/'
        ) {
            socket.connectToServer();
        } else {
            violations.push(`WebSocket ${url.origin}${url.pathname}`);
            socket.close();
        }
    });
    return { violations, forwarded, dispose };
}

export const test = base.extend<
    { statusMock: StatusMock },
    { stack: FoundationStack }
>({
    stack: [
        // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
        async ({}, use) => {
            const stack = await startFoundationStack();
            try {
                await use(stack);
            } finally {
                await stack.stop();
            }
        },
        { scope: 'worker', timeout: 600_000 },
    ],
    // biome-ignore lint/correctness/noEmptyPattern: This fixture has no dependencies.
    statusMock: async ({}, use) => {
        await use({});
    },
    context: async ({ context, stack, statusMock }, use) => {
        const guard = await guardBrowserContext(context, stack, { statusMock });
        try {
            await use(context);
        } finally {
            await guard.dispose();
            expect(
                guard.violations,
                'Unexpected browser HTTP/WebSocket destination',
            ).toEqual([]);
        }
    },
});

// Auth cases need POST login/refresh plus fresh server state per case:
// password changes cannot contaminate another case. Exported from raw
// Playwright base because changing an inherited fixture's scope is invalid.
export const authTest = base.extend<{
    authStack: FoundationStack;
    authFaults: GuardFaults;
    authStatusMock: StatusMock;
    configMock: StatusMock;
    guard: GuardHandle;
}>({
    authStack: [
        // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
        async ({}, use) => {
            const stack = await startFoundationStack();
            try {
                await use(stack);
            } finally {
                await stack.stop();
            }
        },
        { scope: 'test', timeout: 600_000 },
    ],
    // biome-ignore lint/correctness/noEmptyPattern: This fixture has no dependencies.
    authFaults: async ({}, use) => {
        await use({ offline: false, stripSetCookie: false });
    },
    // biome-ignore lint/correctness/noEmptyPattern: This fixture has no dependencies.
    authStatusMock: async ({}, use) => {
        await use({});
    },
    // biome-ignore lint/correctness/noEmptyPattern: This fixture has no dependencies.
    configMock: async ({}, use) => {
        await use({});
    },
    guard: async (
        { context, authStack, authFaults, authStatusMock, configMock },
        use,
    ) => {
        const guard = await guardBrowserContext(context, authStack, {
            allowAuthPosts: true,
            faults: authFaults,
            statusMock: authStatusMock,
            configMock,
        });
        try {
            await use(guard);
        } finally {
            await guard.dispose();
            expect(
                guard.violations,
                'Unexpected browser HTTP/WebSocket destination',
            ).toEqual([]);
        }
    },
    page: async ({ page, guard }, use) => {
        void guard;
        await use(page);
    },
});

export { expect };
