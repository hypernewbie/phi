import { test as base, expect, type BrowserContext } from '@playwright/test';
import { startFoundationStack, type FoundationStack } from './phi-server.ts';

interface StatusReply {
    status?: number;
    body?: unknown;
    raw?: string;
    wait?: Promise<void>;
}
interface StatusMock {
    reply?: StatusReply;
}

export async function guardBrowserContext(
    context: BrowserContext,
    stack: Pick<FoundationStack, 'reactUrl' | 'phiUrl'>,
    statusMock: StatusMock = {},
): Promise<string[]> {
    const violations: string[] = [];
    const origins = new Set([stack.reactUrl, stack.phiUrl]);
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const apiAllowed =
            url.pathname === '/api/auth/v2/status' &&
            request.method() === 'GET' &&
            url.origin === stack.reactUrl;
        if (
            !origins.has(url.origin) ||
            (url.pathname.startsWith('/api') && !apiAllowed) ||
            url.pathname.startsWith('/ws')
        ) {
            violations.push(`${request.method()} ${url.origin}${url.pathname}`);
            await route.abort('blockedbyclient');
            return;
        }
        if (apiAllowed && statusMock.reply) {
            const reply = statusMock.reply;
            await reply.wait;
            await route.fulfill({
                status: reply.status ?? 200,
                contentType: 'application/json',
                body: reply.raw ?? JSON.stringify(reply.body),
            });
            return;
        }
        // Routing does not intercept the next request in an HTTP redirect chain.
        // Keep an omitted Cookie header omitted even in the shared request context.
        const headers = await request.allHeaders();
        const response = await route.fetch({
            maxRedirects: 0,
            headers: { ...headers, cookie: headers.cookie ?? '' },
        });
        try {
            if (response.status() >= 300 && response.status() < 400) {
                violations.push(
                    `Redirect ${request.method()} ${url.origin}${url.pathname}`,
                );
                await route.abort('blockedbyclient');
                return;
            }
            await route.fulfill({ response });
        } finally {
            await response.dispose();
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
    return violations;
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
        const violations = await guardBrowserContext(
            context,
            stack,
            statusMock,
        );
        try {
            await use(context);
        } finally {
            expect(
                violations,
                'Unexpected browser HTTP/WebSocket destination',
            ).toEqual([]);
        }
    },
});

export { expect };
