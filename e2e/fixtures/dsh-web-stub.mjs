#!/usr/bin/env node
// Owned loopback DSH stub for e2e/dsh-tab-carrier.spec.ts. It mimics the
// rc.5 web announcement (`dsh web: <url>?token=...`), the token-gated
// root (401 without credentials, 303 plus cookie for the launch token),
// and a marker page behind the cookie. It is NOT DSH: it carries no
// model, workspace, or session behavior. DSH flags are accepted and
// ignored except --trusted-host, which selects the cookie authority the
// same way CookieName does. Receipts carry pid/port only, never tokens.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

function trustedHost() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--trusted-host') return args[i + 1];
    }
    return '127.0.0.1:8080';
}

function cookieName(authority) {
    const url = new URL(`http://${authority}`);
    let host = url.hostname.toLowerCase();
    let port = url.port;
    if (port === '80') port = '';
    let scoped = host;
    if (port !== '') scoped += `:${port}`;
    const sum = createHash('sha256').update(scoped).digest();
    return `dsh-auth-${sum.toString('base64url')}`;
}

const expected = cookieName(trustedHost());
const token = randomBytes(16).toString('hex');

const page =
    '<!doctype html><html><head><title>DSH stub</title></head>' +
    '<body data-stub="dsh-carrier-ok"><h1>DSH carrier stub</h1></body></html>';

function hasCookie(req) {
    const header = req.headers.cookie || '';
    return header.split(';').some((part) => {
        const [name, ...rest] = part.trim().split('=');
        return name === expected && rest.join('=').length > 0;
    });
}

const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://stub');
    const keys = [...url.searchParams.keys()];
    if (
        req.method === 'GET' &&
        url.pathname === '/' &&
        keys.length === 1 &&
        url.searchParams.get('token') === token
    ) {
        res.writeHead(303, {
            Location: './',
            'Set-Cookie': `${expected}=stub-signed; Path=/; HttpOnly; SameSite=Strict`,
            'Cache-Control': 'no-store',
        });
        res.end();
        return;
    }
    if (req.method === 'GET' && hasCookie(req)) {
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
        });
        res.end(page);
        return;
    }
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
});

server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    writeFileSync(
        new URL('./dsh-stub-receipt.json', import.meta.url),
        JSON.stringify({ pid: process.pid, port }) + '\n',
    );
    process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${token}\n`);
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
});
