import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startPhi, type PhiServer } from './_server.js';

// The Kanban session belongs to the server.
//
// The browser used to log in to Vikunja itself: one login per view, four
// logins for one board open when the token was stale, and three clicks
// enough to reach the instance's ten-logins-a-minute limit - which the user
// saw as "Saved login failed: {"message":"Too Many Requests"}".
//
// This spec pins the contract: the server logs in once and every client of
// that backend shares the session. The mock counts the logins, so a
// regression that moves the login back into the browser fails here.

interface MockVikunja {
    server: Server;
    url: string;
    logins: () => number;
}

async function startMockVikunja(): Promise<MockVikunja> {
    let logins = 0;
    const server = createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/api/v1/login') {
            logins++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: 'mock-token' }));
            return;
        }
        if (path === '/api/v1/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ id: 1, title: 'Demo' }]));
            return;
        }
        if (path === '/api/v1/projects/1/views') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ id: 10, view_kind: 'kanban' }]));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    return {
        server,
        url: `http://127.0.0.1:${port}`,
        logins: () => logins,
    };
}

let phi: PhiServer;
let vikunja: MockVikunja;

test.beforeAll(async () => {
    vikunja = await startMockVikunja();
    phi = await startPhi();
    // The server owns the credentials: the client never sees the password.
    const saved = await fetch(`${phi.url}/api/config/kanban-vault`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            password: 'mock-password',
            username: 'tester',
            url: vikunja.url,
        }),
    });
    expect(saved.ok).toBe(true);
});

test.afterAll(async () => {
    await phi.stop();
    await new Promise<void>((resolve) => vikunja.server.close(() => resolve()));
});

test('the board asks the server for a session, and the server logs in once', async ({
    page,
}) => {
    await page.goto(phi.url);
    await page.locator('#header-kanban-btn').click();
    await expect(page.locator('.kanban-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    // The server logged in once. The browser never did.
    expect(vikunja.logins()).toBe(1);

    // A reload is a new page: the board opens again, and the session is
    // still the server's. No second login.
    await page.reload();
    await expect(page.locator('.kanban-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    expect(vikunja.logins()).toBe(1);

    // Clicking the board again must not ask the instance for anything.
    await page.locator('#header-kanban-btn').click();
    await page.waitForTimeout(1_000);
    expect(vikunja.logins()).toBe(1);
});

test('a second view shares the session instead of logging in again', async ({
    browser,
}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(phi.url);
    await page.locator('#header-kanban-btn').click();
    await expect(page.locator('.kanban-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    // A new view is a new browser storage: the client has no session of
    // its own, so it asks the server - and the server's session is still
    // valid.
    expect(vikunja.logins()).toBe(1);
    await context.close();
});
