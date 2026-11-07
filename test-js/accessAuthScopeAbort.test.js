// @vitest-environment jsdom
//
// ─────────────────────────────────────────────────────────────────────────
// FUNDAMENTAL CONTRACT — DO NOT CHANGE.
//
// The desktop runs ONE embedded page (phi-app://app) for EVERY server and
// switches servers in place. Every switch replaces the page's BackendScope,
// and every request bound to the old scope dies with it — the abort reason
// is the internal string 'Owner changed'.
//
// A sign-in prompt that was open across such a switch must:
//   1. send the password through the scope the page shows NOW — never
//      through a dead scope (which surfaces 'Owner changed' to the user
//      as if the server had answered);
//   2. close itself, without posting anything, when the credential
//      namespace it was opened for is no longer the one on screen —
//      the password must never be sent to a server the user has
//      navigated away from;
//   3. never show an internal abort reason, and never read as a
//      rejected password when the attempt was merely interrupted.
//
// 'Owner changed' is an implementation detail of scope ownership. It is
// not a server answer, not a verdict on the password, and must never be
// user-visible. This file pins that. If a change makes any case here
// fail, the change is wrong — not the test.
// ─────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { bootstrapAccessAuth, setAuthContext, __test__ } from '../web/auth.js';

setupDomHarness();

const NAMESPACE_A = 'phi_access_credential_v1:profile-a';
const NAMESPACE_B = 'phi_access_credential_v1:profile-b';
const PASSWORD = 'correct horse battery staple';
const STATUS = {
    enabled: true,
    authenticated: false,
    protocols: ['v1', 'v2'],
};
const HOST_STATUS = { enabled: true, authenticated: false, owned: true };

function response(body, options = {}) {
    const { status = 200, headers = {} } = options;
    const lower = new Map(
        Object.entries(headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
        ]),
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name) => lower.get(String(name).toLowerCase()) ?? null,
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

const asEmbeddedShell = () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
            protocol: 'phi-app:',
            host: 'app',
            origin: 'phi-app://app',
            href: 'phi-app://app/',
            reload: vi.fn(),
        },
    });
    return () =>
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: original,
        });
};

function scopeContext(credentialKey, fetchImpl) {
    return { credentialKey, fetch: fetchImpl };
}

function deadFetch(reason = 'Owner changed') {
    return vi.fn(async (url) => {
        if (url === '/api/auth/status')
            return response(STATUS, {
                headers: { 'X-Phi-Host-Auth-Protocol': 'v2' },
            });
        if (url === '/api/auth/v2/status') return response(HOST_STATUS);
        // Anything past discovery dies the way a replaced scope dies.
        throw new DOMException(reason, 'AbortError');
    });
}

async function openPrompt(context) {
    const opened = bootstrapAccessAuth(context);
    await vi.waitFor(() =>
        expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
    );
    const overlay = document.querySelector('.access-auth-overlay');
    overlay.querySelector('input[type="password"]').value = PASSWORD;
    return { opened, overlay };
}

function submit(overlay) {
    overlay
        .querySelector('form')
        .dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('a sign-in prompt whose scope was replaced', () => {
    let restoreLocation;

    beforeEach(() => {
        __test__.resetAccessState();
        restoreLocation = asEmbeddedShell();
    });

    afterEach(() => {
        __test__.resetAccessState();
        restoreLocation?.();
        restoreLocation = undefined;
    });

    it('posts the password through the scope the page shows now', async () => {
        // Same server, new scope: the desktop reloaded its view, or the
        // switch went A -> B -> A. The namespace survived; the scope did not.
        const dead = scopeContext(NAMESPACE_A, deadFetch());
        const liveFetch = vi.fn(async (url) => {
            if (url === '/api/auth/status')
                return response(STATUS, {
                    headers: { 'X-Phi-Host-Auth-Protocol': 'v2' },
                });
            if (url === '/api/auth/v2/status') return response(HOST_STATUS);
            if (url === '/api/auth/v2/login') return response({ ok: true });
            throw new Error(`unexpected request ${url}`);
        });
        const live = scopeContext(NAMESPACE_A, liveFetch);

        const { overlay, opened } = await openPrompt(dead);
        // The scope is replaced behind the prompt's back.
        setAuthContext(live);
        submit(overlay);

        await expect(opened).resolves.toEqual({ enabled: true });
        expect(
            liveFetch.mock.calls.some(
                ([url]) => String(url) === '/api/auth/v2/login',
            ),
        ).toBe(true);
        expect(
            dead.fetch.mock.calls.some(
                ([url]) => String(url) === '/api/auth/v2/login',
            ),
        ).toBe(false);
    });

    it('closes without posting when its server is no longer on screen', async () => {
        // The exact desktop failure: a prompt for server A stays open
        // while the rail switches to server B. The password typed into
        // that prompt belongs to A and must never reach B.
        const serverA = scopeContext(NAMESPACE_A, deadFetch());
        const serverBFetch = vi.fn(async (url) => {
            throw new Error(`server B must not see ${url}`);
        });
        const serverB = scopeContext(NAMESPACE_B, serverBFetch);

        const { overlay, opened } = await openPrompt(serverA);
        setAuthContext(serverB);
        submit(overlay);

        // The prompt resolves closed; nothing was posted anywhere.
        await expect(opened).resolves.toEqual({ enabled: false });
        expect(overlay.isConnected).toBe(false);
        expect(
            serverA.fetch.mock.calls.some(
                ([url]) => String(url) === '/api/auth/v2/login',
            ),
        ).toBe(false);
        expect(serverBFetch).not.toHaveBeenCalled();
    });

    it('never shows the internal abort reason as an answer', async () => {
        // The scope died mid-flight — after the password left the field.
        // That is an interrupted attempt, not a server verdict, and the
        // internal reason ('Owner changed') is not the user's business.
        const scope = scopeContext(NAMESPACE_A, deadFetch());

        const { overlay } = await openPrompt(scope);
        submit(overlay);

        await vi.waitFor(() => {
            const text =
                overlay.querySelector('.access-auth-error').textContent;
            expect(text).not.toBe('');
        });
        const text = overlay.querySelector('.access-auth-error').textContent;
        expect(text).not.toContain('Owner changed');
        expect(text).not.toContain('Wrong password');
        expect(text).toBe('Sign-in was interrupted. Try again.');
        // An interrupted attempt keeps the password: a retry must not
        // force the user to retype it.
        expect(overlay.querySelector('input[type="password"]').value).toBe(
            PASSWORD,
        );
    });
});
